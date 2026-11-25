import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FirebaseRestError } from '../common/constants/firebase-errors';
import { ErrorMessages } from '../common/constants/error-messages';

const BASE = 'https://identitytoolkit.googleapis.com/v1/accounts';

/** Timeout de cada chamada ao Identity Toolkit (síncrona, dentro da requisição HTTP). */
export const FIREBASE_REST_TIMEOUT_MS = 5000;

export interface FirebaseSignInResult {
  idToken: string;
  refreshToken: string;
  expiresIn: string;
  localId: string;
  email: string;
}

/** Provedor fora, lento ou respondendo lixo (timeout, rede, 5xx, 429, corpo não-JSON) → 503. */
class FirebaseRestUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'FirebaseRestUnavailableError';
  }
}

/** Erro do cliente reportado pelo provedor (4xx com `error.message`, ex.: `EMAIL_NOT_FOUND`). */
class FirebaseRestRequestError extends Error {
  constructor(
    readonly status: number,
    readonly providerCode: string,
  ) {
    super(`HTTP ${status}: ${providerCode}`);
    this.name = 'FirebaseRestRequestError';
  }
}

@Injectable()
export class FirebaseAuthService {
  private readonly logger = new Logger(FirebaseAuthService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.getOrThrow<string>('FIREBASE_API_KEY');
  }

  /**
   * POST no Identity Toolkit, classificando a falha ANTES de qualquer mapeamento:
   * transitória → `FirebaseRestUnavailableError`; erro do cliente → `FirebaseRestRequestError`.
   */
  private async post<T>(endpoint: string, body: object): Promise<T> {
    const url = `${BASE}:${endpoint}?key=${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FIREBASE_REST_TIMEOUT_MS),
      });
    } catch (err) {
      // TimeoutError/AbortError (AbortSignal.timeout) ou falha de rede (DNS, ECONNRESET...)
      throw new FirebaseRestUnavailableError(`${endpoint}: ${(err as Error).name}`);
    }

    if (res.status >= 500 || res.status === 429) {
      throw new FirebaseRestUnavailableError(`${endpoint}: HTTP ${res.status}`);
    }

    let data: { error?: { message?: string } } & T;
    try {
      data = (await res.json()) as typeof data;
    } catch (err) {
      // Página HTML de proxy/gateway ou timeout durante a leitura do corpo
      throw new FirebaseRestUnavailableError(
        `${endpoint}: unreadable body (HTTP ${res.status}, ${(err as Error).name})`,
      );
    }

    if (!res.ok) {
      throw new FirebaseRestRequestError(res.status, data?.error?.message ?? '');
    }

    return data;
  }

  /** Transitória → 503 (com log do motivo, sem payload); senão devolve o código do provedor. */
  private providerCodeOrThrowUnavailable(err: unknown, operation: string): string {
    if (err instanceof FirebaseRestRequestError) return err.providerCode;
    const reason = err instanceof Error ? err.message : String(err);
    this.logger.warn(`Firebase REST unavailable (${operation}): ${reason}`);
    throw new ServiceUnavailableException(ErrorMessages.AUTH_PROVIDER_UNAVAILABLE);
  }

  // ── Login com email e senha ───────────────────────────────────────────────

  async signInWithPassword(email: string, password: string): Promise<FirebaseSignInResult> {
    try {
      return await this.post<FirebaseSignInResult>('signInWithPassword', {
        email,
        password,
        returnSecureToken: true,
      });
    } catch (err) {
      const code = this.providerCodeOrThrowUnavailable(err, 'signIn');

      if (
        code.includes(FirebaseRestError.EMAIL_NOT_FOUND) ||
        code.includes(FirebaseRestError.INVALID_PASSWORD) ||
        code.includes(FirebaseRestError.INVALID_LOGIN_CREDENTIALS) ||
        code.includes(FirebaseRestError.USER_DISABLED)
      ) {
        throw new UnauthorizedException(ErrorMessages.INVALID_CREDENTIALS);
      }

      this.logger.error(`Firebase signIn failed: ${code}`);
      throw new UnauthorizedException(ErrorMessages.AUTH_FAILED);
    }
  }

  // ── Envio de email de redefinição ─────────────────────────────────────────

  async sendPasswordResetEmail(email: string): Promise<void> {
    try {
      await this.post('sendOobCode', { requestType: 'PASSWORD_RESET', email });
    } catch (err) {
      // Provedor fora → 503 (não revela nada sobre a conta). Erros do cliente são silenciados,
      // e o de e-mail inexistente nem é logado, para evitar enumeração de contas.
      const code = this.providerCodeOrThrowUnavailable(err, 'sendPasswordResetEmail');
      if (!code.includes(FirebaseRestError.EMAIL_NOT_FOUND)) {
        this.logger.warn(`Firebase sendPasswordResetEmail failed: ${code}`);
      }
    }
  }

  // ── Confirmação da nova senha ─────────────────────────────────────────────

  async confirmPasswordReset(oobCode: string, newPassword: string): Promise<void> {
    try {
      await this.post('resetPassword', { oobCode, newPassword });
    } catch (err) {
      const code = this.providerCodeOrThrowUnavailable(err, 'confirmPasswordReset');

      if (code.includes(FirebaseRestError.EXPIRED_OOB_CODE)) {
        throw new BadRequestException(ErrorMessages.RESET_LINK_EXPIRED);
      }
      if (code.includes(FirebaseRestError.INVALID_OOB_CODE)) {
        throw new BadRequestException(ErrorMessages.RESET_LINK_INVALID);
      }
      if (code.includes(FirebaseRestError.WEAK_PASSWORD)) {
        throw new BadRequestException(ErrorMessages.WEAK_PASSWORD);
      }

      this.logger.error(`Firebase confirmPasswordReset failed: ${code}`);
      throw new BadRequestException(ErrorMessages.PASSWORD_RESET_FAILED);
    }
  }
}
