import { Test, TestingModule } from '@nestjs/testing';
import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import * as admin from 'firebase-admin';
import { FirebaseStrategy } from './firebase.strategy';
import { TokenCacheService } from './token-cache.service';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { Plan } from '../users/enums/plan.enum';

jest.mock('firebase-admin', () => ({ auth: jest.fn() }));
jest.mock('../config', () => ({ initializeFirebase: jest.fn() }));

const TOKEN = 'id-token-abc';
const UID = 'firebase-uid-1';
const EXP = 1_900_000_000; // segundos (claim `exp` do ID token)
const SESSION = { expiresAt: EXP * 1000, version: 'v1' };

const firebaseError = (code: string) => Object.assign(new Error(`firebase: ${code}`), { code });

const mockUser = (): User => ({ id: 'uuid-1', firebaseUid: UID, plan: Plan.BASIC }) as User;

const reqWithToken = (token = TOKEN): Request =>
  ({ headers: { authorization: `Bearer ${token}` } }) as Request;

describe('FirebaseStrategy', () => {
  let strategy: FirebaseStrategy;
  let tokenCache: jest.Mocked<TokenCacheService>;
  let usersService: jest.Mocked<UsersService>;
  let verifyIdToken: jest.Mock;

  beforeEach(async () => {
    verifyIdToken = jest.fn().mockResolvedValue({
      uid: UID,
      exp: EXP,
      email: 'test@example.com',
      firebase: { sign_in_provider: 'password' },
    });
    (admin.auth as unknown as jest.Mock).mockReturnValue({ verifyIdToken });

    tokenCache = {
      getByToken: jest.fn().mockResolvedValue(undefined),
      getByFirebaseUid: jest.fn().mockResolvedValue(undefined),
      getSessionVersion: jest.fn().mockResolvedValue('v1'),
      setByToken: jest.fn(),
      setSessionOnly: jest.fn(),
      invalidateUser: jest.fn(),
    } as unknown as jest.Mocked<TokenCacheService>;
    usersService = { findOrCreate: jest.fn() } as unknown as jest.Mocked<UsersService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FirebaseStrategy,
        { provide: TokenCacheService, useValue: tokenCache },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    strategy = module.get(FirebaseStrategy);
  });

  it('rejeita requisição sem Bearer token', async () => {
    await expect(strategy.validate({ headers: {} } as Request)).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('nível 1: retorna usuário do cache de sessão sem chamar o Firebase', async () => {
    const user = mockUser();
    tokenCache.getByToken.mockResolvedValue(user);

    await expect(strategy.validate(reqWithToken())).resolves.toBe(user);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('rejeita token inválido no Firebase', async () => {
    verifyIdToken.mockRejectedValue(firebaseError('auth/id-token-expired'));
    await expect(strategy.validate(reqWithToken())).rejects.toThrow(UnauthorizedException);
  });

  it('verifica o token com checkRevoked = true', async () => {
    usersService.findOrCreate.mockResolvedValue(mockUser());
    await strategy.validate(reqWithToken());
    expect(verifyIdToken).toHaveBeenCalledWith(TOKEN, true);
  });

  it.each(['auth/id-token-revoked', 'auth/user-disabled'])(
    '%s → Unauthorized com mensagem genérica e nada é cacheado',
    async (code) => {
      verifyIdToken.mockRejectedValue(firebaseError(code));

      const err = await strategy.validate(reqWithToken()).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe('Invalid or expired token');
      expect(tokenCache.setByToken).not.toHaveBeenCalled();
      expect(tokenCache.setSessionOnly).not.toHaveBeenCalled();
    },
  );

  it.each([
    'auth/id-token-expired',
    'auth/argument-error',
    'auth/invalid-id-token',
    'auth/id-token-revoked',
    'auth/user-disabled',
    'auth/user-not-found',
  ])('%s → 401 genérico', async (code) => {
    verifyIdToken.mockRejectedValue(firebaseError(code));

    const err = await strategy.validate(reqWithToken()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnauthorizedException);
    expect((err as UnauthorizedException).message).toBe('Invalid or expired token');
  });

  describe('falha transitória do Firebase → 503 (não desloga o usuário)', () => {
    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    it.each(['app/network-error', 'app/network-timeout', 'auth/internal-error'])(
      '%s → 503',
      async (code) => {
        verifyIdToken.mockRejectedValue(firebaseError(code));

        const err = await strategy.validate(reqWithToken()).catch((e: unknown) => e);

        expect(err).toBeInstanceOf(ServiceUnavailableException);
        expect((err as ServiceUnavailableException).message).toBe(
          'Authentication service is temporarily unavailable, please try again',
        );
        expect(tokenCache.setByToken).not.toHaveBeenCalled();
      },
    );

    it('erro de rede sem code (ex.: ECONNRESET) → 503', async () => {
      verifyIdToken.mockRejectedValue(
        Object.assign(new Error('socket hang up'), { errno: -54, syscall: 'read' }),
      );
      await expect(strategy.validate(reqWithToken())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });

    it('erro de rede com code de sistema (ECONNRESET/ETIMEDOUT) → 503', async () => {
      verifyIdToken.mockRejectedValue(firebaseError('ECONNRESET'));
      await expect(strategy.validate(reqWithToken())).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });

  it('nível 2: grava só a sessão e NÃO regrava user:profile (TTL não se auto-renova)', async () => {
    const user = mockUser();
    tokenCache.getByFirebaseUid.mockResolvedValue(user);

    await expect(strategy.validate(reqWithToken())).resolves.toBe(user);

    expect(tokenCache.getByFirebaseUid).toHaveBeenCalledWith(UID);
    // versão capturada antes de ler o perfil (invalidação concorrente não grava sessão defasada)
    expect(tokenCache.getSessionVersion.mock.invocationCallOrder[0]).toBeLessThan(
      tokenCache.getByFirebaseUid.mock.invocationCallOrder[0],
    );
    expect(tokenCache.setSessionOnly).toHaveBeenCalledWith(TOKEN, user, SESSION);
    expect(tokenCache.setByToken).not.toHaveBeenCalled();
    expect(usersService.findOrCreate).not.toHaveBeenCalled();
  });

  it('fallback: busca no banco e popula sessão + perfil', async () => {
    const user = mockUser();
    usersService.findOrCreate.mockResolvedValue(user);

    await expect(strategy.validate(reqWithToken())).resolves.toBe(user);

    expect(usersService.findOrCreate).toHaveBeenCalledWith(
      expect.objectContaining({ firebaseUid: UID, email: 'test@example.com' }),
    );
    expect(tokenCache.setByToken).toHaveBeenCalledWith(TOKEN, user, SESSION);
  });
});
