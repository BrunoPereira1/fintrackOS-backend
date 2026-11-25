import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import * as admin from 'firebase-admin';
import { AuthService } from './auth.service';
import { UsersService } from '../users/users.service';
import { TokenCacheService } from './token-cache.service';
import { FirebaseAuthService } from './firebase-auth.service';
import { DocumentType } from '../users/enums/document-type.enum';
import { RegisterDto } from './dto/register.dto';
import { User } from '../users/entities/user.entity';
import { ErrorMessages } from '../common/constants/error-messages';

jest.mock('firebase-admin', () => ({ auth: jest.fn() }));

const registerDto = (): RegisterDto => ({
  email: 'new@example.com',
  password: 'secret123',
  displayName: 'Novo',
  documentType: DocumentType.CPF,
  document: '529.982.247-25',
});

describe('AuthService', () => {
  let service: AuthService;
  let usersService: jest.Mocked<UsersService>;
  let tokenCache: jest.Mocked<TokenCacheService>;
  let firebaseAuth: jest.Mocked<FirebaseAuthService>;
  let createUser: jest.Mock;
  let deleteUser: jest.Mock;
  let revokeRefreshTokens: jest.Mock;

  beforeEach(async () => {
    createUser = jest.fn().mockResolvedValue({ uid: 'new-uid', email: 'new@example.com' });
    deleteUser = jest.fn().mockResolvedValue(undefined);
    revokeRefreshTokens = jest.fn().mockResolvedValue(undefined);
    (admin.auth as unknown as jest.Mock).mockReturnValue({
      createUser,
      deleteUser,
      revokeRefreshTokens,
    });

    tokenCache = {
      getSessionVersion: jest.fn().mockResolvedValue('v1'),
      setByToken: jest.fn().mockResolvedValue(undefined),
      invalidateAllSessions: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<TokenCacheService>;
    firebaseAuth = {
      signInWithPassword: jest.fn(),
    } as unknown as jest.Mocked<FirebaseAuthService>;

    usersService = {
      assertDocumentAvailable: jest.fn().mockResolvedValue(undefined),
      findOrCreate: jest.fn(),
    } as unknown as jest.Mocked<UsersService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: usersService },
        { provide: TokenCacheService, useValue: tokenCache },
        { provide: FirebaseAuthService, useValue: firebaseAuth },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('register', () => {
    it('cria usuário no Firebase e no banco com documento normalizado', async () => {
      const user = { id: 'uuid-1' } as User;
      usersService.findOrCreate.mockResolvedValue(user);

      await expect(service.register(registerDto())).resolves.toBe(user);

      expect(usersService.assertDocumentAvailable).toHaveBeenCalledWith('52998224725');
      expect(createUser).toHaveBeenCalled();
      expect(usersService.findOrCreate).toHaveBeenCalledWith(
        expect.objectContaining({ firebaseUid: 'new-uid', document: '52998224725' }),
      );
    });

    it('e-mail já existente no Firebase → 409 com mensagem de ErrorMessages', async () => {
      createUser.mockRejectedValue(
        Object.assign(new Error('exists'), { code: 'auth/email-already-exists' }),
      );
      await expect(service.register(registerDto())).rejects.toThrow(
        new ConflictException(ErrorMessages.EMAIL_ALREADY_REGISTERED),
      );
    });

    it('senha recusada pelo Firebase → 400 com mensagem de ErrorMessages', async () => {
      createUser.mockRejectedValue(
        Object.assign(new Error('weak'), { code: 'auth/invalid-password' }),
      );
      await expect(service.register(registerDto())).rejects.toThrow(
        new BadRequestException(ErrorMessages.INVALID_PASSWORD_POLICY),
      );
    });

    it.each([
      ['code desconhecido', Object.assign(new Error('boom'), { code: 'auth/internal-error' })],
      ['erro de rede sem code', new Error('socket hang up')],
    ])('erro desconhecido do createUser (%s) → 503, não 500 cru', async (_label, error) => {
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      createUser.mockRejectedValue(error);

      const err = await service.register(registerDto()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).message).toBe(
        ErrorMessages.AUTH_PROVIDER_UNAVAILABLE,
      );
      expect(usersService.findOrCreate).not.toHaveBeenCalled();
    });

    it('documento já usado → BadRequest e o Firebase NÃO é chamado (sem conta órfã)', async () => {
      usersService.assertDocumentAvailable.mockRejectedValue(
        new BadRequestException('Document cannot be used'),
      );

      await expect(service.register(registerDto())).rejects.toThrow(BadRequestException);
      expect(createUser).not.toHaveBeenCalled();
      expect(usersService.findOrCreate).not.toHaveBeenCalled();
    });

    it('corrida (23505 em UQ_users_document) → BadRequest e desfaz conta do Firebase', async () => {
      usersService.findOrCreate.mockRejectedValue(
        new QueryFailedError(
          'INSERT ...',
          [],
          Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'UQ_users_document',
          }),
        ),
      );

      await expect(service.register(registerDto())).rejects.toThrow(
        new BadRequestException('Document cannot be used'),
      );
      expect(deleteUser).toHaveBeenCalledWith('new-uid');
    });

    it('outros erros do banco são propagados sem conversão', async () => {
      const err = new Error('connection lost');
      usersService.findOrCreate.mockRejectedValue(err);

      await expect(service.register(registerDto())).rejects.toBe(err);
      expect(deleteUser).not.toHaveBeenCalled();
    });
  });

  describe('login', () => {
    afterEach(() => jest.useRealTimers());

    it('pré-aquece a sessão com TTL limitado pelo expiresIn e a versão lida antes do perfil', async () => {
      const now = new Date('2026-01-01T12:00:00Z').getTime();
      jest.useFakeTimers().setSystemTime(now);
      const user = { id: 'uuid-1', firebaseUid: 'uid-1' } as User;
      firebaseAuth.signInWithPassword.mockResolvedValue({
        idToken: 'id-token',
        refreshToken: 'refresh',
        expiresIn: '3600',
        localId: 'uid-1',
        email: 'a@b.com',
      });
      usersService.findOrCreate.mockResolvedValue(user);

      await service.login({ email: 'a@b.com', password: 'secret123' });

      expect(tokenCache.getSessionVersion).toHaveBeenCalledWith('uid-1');
      expect(tokenCache.setByToken).toHaveBeenCalledWith('id-token', user, {
        expiresAt: now + 3600 * 1000,
        version: 'v1',
      });
    });
  });

  describe('logout', () => {
    it('revoga refresh tokens no Firebase e derruba todas as sessões em cache', async () => {
      await expect(service.logout('uid-1')).resolves.toBeUndefined();

      expect(revokeRefreshTokens).toHaveBeenCalledWith('uid-1');
      expect(tokenCache.invalidateAllSessions).toHaveBeenCalledWith('uid-1');
      // revoga antes de invalidar: nenhuma revalidação posterior volta a cachear o token
      expect(revokeRefreshTokens.mock.invocationCallOrder[0]).toBeLessThan(
        tokenCache.invalidateAllSessions.mock.invocationCallOrder[0],
      );
    });

    it('falha no Firebase → ainda invalida o cache e responde 503', async () => {
      revokeRefreshTokens.mockRejectedValue(new Error('network'));

      await expect(service.logout('uid-1')).rejects.toThrow(ServiceUnavailableException);
      expect(tokenCache.invalidateAllSessions).toHaveBeenCalledWith('uid-1');
    });
  });
});
