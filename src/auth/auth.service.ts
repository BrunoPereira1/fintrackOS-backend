import {
  Injectable,
  ConflictException,
  BadRequestException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { USER_DOCUMENT_UNIQUE_INDEX, UsersService } from '../users/users.service';
import { TokenCacheService } from './token-cache.service';
import { FirebaseAuthService } from './firebase-auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { User } from '../users/entities/user.entity';
import { LoginResponseDto } from './dto/login-response.dto';
import { normalizeDocument } from '../common/validators/document.validator';
import { UserMapper } from '../users/user.mapper';
import { FirebaseAdminError } from '../common/constants/firebase-errors';
import { ErrorMessages } from '../common/constants/error-messages';
import { isUniqueViolation } from '../common/db-errors';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly usersService: UsersService,
    private readonly tokenCache: TokenCacheService,
    private readonly firebaseAuth: FirebaseAuthService,
  ) {}

  // ── Registro com email e senha ────────────────────────────────────────────

  async register(dto: RegisterDto): Promise<User> {
    const document = normalizeDocument(dto.documentType, dto.document);

    // Checa o documento ANTES de criar a conta no Firebase, para não deixar conta órfã
    await this.usersService.assertDocumentAvailable(document);

    let firebaseUser: admin.auth.UserRecord;

    try {
      firebaseUser = await admin.auth().createUser({
        email: dto.email,
        password: dto.password,
        displayName: dto.displayName,
        emailVerified: false,
      });
    } catch (err) {
      const code = (err as admin.FirebaseError).code;

      if (code === FirebaseAdminError.EMAIL_ALREADY_EXISTS) {
        throw new ConflictException(ErrorMessages.EMAIL_ALREADY_REGISTERED);
      }
      if (code === FirebaseAdminError.INVALID_PASSWORD) {
        throw new BadRequestException(ErrorMessages.INVALID_PASSWORD_POLICY);
      }

      // Código não mapeado (rede, erro interno, cota): nunca 500 cru com detalhe do provedor.
      // Loga só o código/nome — a mensagem do SDK pode trazer o e-mail informado.
      this.logger.error(`Firebase user creation failed: ${code ?? (err as Error)?.name}`);
      throw new ServiceUnavailableException(ErrorMessages.AUTH_PROVIDER_UNAVAILABLE);
    }

    try {
      return await this.usersService.findOrCreate({
        firebaseUid: firebaseUser.uid,
        email: firebaseUser.email ?? dto.email,
        displayName: dto.displayName,
        authProvider: 'password',
        documentType: dto.documentType,
        document,
      });
    } catch (err) {
      if (!isUniqueViolation(err, USER_DOCUMENT_UNIQUE_INDEX)) throw err;

      // Corrida entre a checagem e o insert: desfaz a conta do Firebase recém-criada
      // (best-effort) e responde com a mesma BadRequest genérica, nunca 500.
      await admin
        .auth()
        .deleteUser(firebaseUser.uid)
        .catch((delErr: Error) =>
          this.logger.error(`Failed to roll back Firebase user: ${delErr.message}`),
        );
      throw new BadRequestException(ErrorMessages.DOCUMENT_UNAVAILABLE);
    }
  }

  // ── Login com email e senha ───────────────────────────────────────────────

  async login(dto: LoginDto): Promise<LoginResponseDto> {
    const firebaseResult = await this.firebaseAuth.signInWithPassword(dto.email, dto.password);

    // Versão lida antes do perfil: uma invalidação concorrente impede gravar sessão defasada
    const sessionVersion = await this.tokenCache.getSessionVersion(firebaseResult.localId);

    // Busca ou cria o usuário no banco (garante consistência se criado externamente)
    const user = await this.usersService.findOrCreate({
      firebaseUid: firebaseResult.localId,
      email: firebaseResult.email,
      authProvider: 'password',
    });

    // Pré-aquece o cache para que a primeira requisição autenticada seja instantânea
    await this.tokenCache.setByToken(firebaseResult.idToken, user, {
      expiresAt: Date.now() + Number(firebaseResult.expiresIn) * 1000,
      version: sessionVersion,
    });

    return {
      idToken: firebaseResult.idToken,
      refreshToken: firebaseResult.refreshToken,
      expiresIn: Number(firebaseResult.expiresIn),
      user: UserMapper.toDto(user),
    };
  }

  // ── Logout ────────────────────────────────────────────────────────────────

  /**
   * Revoga os refresh tokens no Firebase (com `checkRevoked`, os ID tokens já emitidos também
   * passam a ser rejeitados) e derruba todas as sessões/perfil em cache do usuário.
   */
  async logout(firebaseUid: string): Promise<void> {
    try {
      await admin.auth().revokeRefreshTokens(firebaseUid);
    } catch (err) {
      this.logger.error(`Firebase revokeRefreshTokens failed: ${(err as Error).message}`);
      // Mesmo sem revogar no Firebase, derruba o cache local antes de falhar
      await this.tokenCache.invalidateAllSessions(firebaseUid);
      throw new ServiceUnavailableException(ErrorMessages.LOGOUT_FAILED);
    }

    await this.tokenCache.invalidateAllSessions(firebaseUid);
  }

  // ── Esqueci a senha ───────────────────────────────────────────────────────

  async forgotPassword(email: string): Promise<void> {
    await this.firebaseAuth.sendPasswordResetEmail(email);
    // Resposta sempre igual — não revela se o email existe na base
  }

  // ── Redefinir senha ───────────────────────────────────────────────────────

  async resetPassword(oobCode: string, newPassword: string): Promise<void> {
    await this.firebaseAuth.confirmPasswordReset(oobCode, newPassword);
  }
}
