import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import * as admin from 'firebase-admin';
import { initializeFirebase } from '../config';
import { UsersService } from '../users/users.service';
import { SessionWriteOptions, TokenCacheService } from './token-cache.service';
import { User } from '../users/entities/user.entity';
import { ErrorMessages } from '../common/constants/error-messages';
import {
  FirebaseAdminError,
  isFirebaseAdminTransientError,
} from '../common/constants/firebase-errors';

/** Códigos de rejeição que pedem log explícito (sessão encerrada no Firebase). */
const REVOCATION_CODES: ReadonlySet<string> = new Set([
  FirebaseAdminError.ID_TOKEN_REVOKED,
  FirebaseAdminError.USER_DISABLED,
]);

@Injectable()
export class FirebaseStrategy extends PassportStrategy(Strategy, 'firebase') {
  private readonly logger = new Logger(FirebaseStrategy.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly tokenCache: TokenCacheService,
  ) {
    super();
    initializeFirebase();
  }

  async validate(req: Request): Promise<User> {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedException(ErrorMessages.MISSING_TOKEN);
    }

    const token = authHeader.slice(7);

    // ── Nível 1: cache do token (evita chamada HTTP ao Firebase) ──────────
    const cached = await this.tokenCache.getByToken(token);
    if (cached) return cached;

    // ── Valida com Firebase (checkRevoked: rejeita tokens revogados/conta desativada) ──
    // Custa uma chamada extra ao Firebase, mas só ocorre fora do cache de sessão.
    let decoded: admin.auth.DecodedIdToken;
    try {
      decoded = await admin.auth().verifyIdToken(token, true);
    } catch (err) {
      const code = (err as admin.FirebaseError).code;
      if (isFirebaseAdminTransientError(err)) {
        // Firebase fora/lento (ex.: falha ao buscar as chaves públicas ou checar revogação):
        // 503 para o cliente tentar de novo, em vez de 401, que o faria deslogar o usuário.
        this.logger.warn(
          `Firebase unavailable during token validation: ${code ?? (err as Error)?.name ?? 'unknown'}`,
        );
        throw new ServiceUnavailableException(ErrorMessages.AUTH_PROVIDER_UNAVAILABLE);
      }
      if (REVOCATION_CODES.has(code)) {
        this.logger.warn(`Firebase token rejected: ${code}`);
      } else {
        this.logger.warn(`Firebase token validation failed: ${code}`);
      }
      // Mesma mensagem genérica para qualquer motivo: não revela revogação/desativação
      throw new UnauthorizedException(ErrorMessages.INVALID_TOKEN);
    }

    // Versão lida ANTES do perfil: se as sessões forem invalidadas no meio do caminho
    // (logout, mudança de plano), a sessão gravada abaixo já nasce inválida.
    const session: SessionWriteOptions = {
      expiresAt: decoded.exp * 1000,
      version: await this.tokenCache.getSessionVersion(decoded.uid),
    };

    // ── Nível 2: cache do perfil (evita query ao banco) ───────────────────
    const cachedUser = await this.tokenCache.getByFirebaseUid(decoded.uid);
    if (cachedUser) {
      // Só a sessão: regravar user:profile renovaria seu TTL e o perfil nunca expiraria
      await this.tokenCache.setSessionOnly(token, cachedUser, session);
      return cachedUser;
    }

    // ── Fallback: busca/cria no banco e popula o cache ────────────────────
    const user = await this.usersService.findOrCreate({
      firebaseUid: decoded.uid,
      email: decoded.email ?? '',
      displayName: decoded.name,
      authProvider: decoded.firebase?.sign_in_provider ?? 'password',
    });

    await this.tokenCache.setByToken(token, user, session);
    return user;
  }
}
