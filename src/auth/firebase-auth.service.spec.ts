import {
  BadRequestException,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FIREBASE_REST_TIMEOUT_MS, FirebaseAuthService } from './firebase-auth.service';
import { ErrorMessages } from '../common/constants/error-messages';

const jsonResponse = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockResolvedValue(body),
  }) as unknown as Response;

const htmlResponse = (status: number): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON')),
  }) as unknown as Response;

const firebaseError = (status: number, message: string) =>
  jsonResponse(status, { error: { code: status, message } });

const domException = (name: string) => Object.assign(new Error(`${name} raised`), { name });

const SIGN_IN_OK = {
  idToken: 'id',
  refreshToken: 'refresh',
  expiresIn: '3600',
  localId: 'uid-1',
  email: 'a@b.com',
};

describe('FirebaseAuthService', () => {
  let service: FirebaseAuthService;
  let fetchMock: jest.Mock;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const config = { getOrThrow: () => 'api-key' } as unknown as ConfigService;
    service = new FirebaseAuthService(config);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const expectUnavailable = async (promise: Promise<unknown>) => {
    const err = await promise.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).message).toBe(
      ErrorMessages.AUTH_PROVIDER_UNAVAILABLE,
    );
  };

  describe('requisição', () => {
    it('envia com timeout explícito (AbortSignal.timeout de 5 s)', async () => {
      const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
      fetchMock.mockResolvedValue(jsonResponse(200, SIGN_IN_OK));

      await expect(service.signInWithPassword('a@b.com', 'secret')).resolves.toEqual(SIGN_IN_OK);

      expect(FIREBASE_REST_TIMEOUT_MS).toBe(5000);
      expect(timeoutSpy).toHaveBeenCalledWith(5000);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('signInWithPassword', () => {
    it.each(['TimeoutError', 'AbortError'])('%s → 503', async (name) => {
      fetchMock.mockRejectedValue(domException(name));
      await expectUnavailable(service.signInWithPassword('a@b.com', 'secret'));
    });

    it('erro de rede (fetch failed) → 503', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      await expectUnavailable(service.signInWithPassword('a@b.com', 'secret'));
    });

    it.each([500, 502, 503])('HTTP %i → 503', async (status) => {
      fetchMock.mockResolvedValue(firebaseError(status, 'INTERNAL'));
      await expectUnavailable(service.signInWithPassword('a@b.com', 'secret'));
    });

    it('HTTP 429 → 503 (não 401)', async () => {
      fetchMock.mockResolvedValue(firebaseError(429, 'RESOURCE_EXHAUSTED'));
      await expectUnavailable(service.signInWithPassword('a@b.com', 'secret'));
    });

    it('corpo não-JSON (página HTML de proxy) → 503', async () => {
      fetchMock.mockResolvedValue(htmlResponse(200));
      await expectUnavailable(service.signInWithPassword('a@b.com', 'secret'));
    });

    it('timeout durante a leitura do corpo → 503', async () => {
      const res = jsonResponse(200, SIGN_IN_OK);
      (res.json as jest.Mock).mockRejectedValue(domException('TimeoutError'));
      fetchMock.mockResolvedValue(res);
      await expectUnavailable(service.signInWithPassword('a@b.com', 'secret'));
    });

    it.each(['EMAIL_NOT_FOUND', 'INVALID_PASSWORD', 'INVALID_LOGIN_CREDENTIALS', 'USER_DISABLED'])(
      '%s → 401 genérico',
      async (code) => {
        fetchMock.mockResolvedValue(firebaseError(400, code));

        const err = await service.signInWithPassword('a@b.com', 'x').catch((e: unknown) => e);

        expect(err).toBeInstanceOf(UnauthorizedException);
        expect((err as UnauthorizedException).message).toBe(ErrorMessages.INVALID_CREDENTIALS);
      },
    );

    it('outro erro 4xx do provedor → 401 genérico sem vazar o código', async () => {
      fetchMock.mockResolvedValue(firebaseError(400, 'TOO_MANY_ATTEMPTS_TRY_LATER'));

      const err = await service.signInWithPassword('a@b.com', 'x').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(UnauthorizedException);
      expect((err as UnauthorizedException).message).toBe(ErrorMessages.AUTH_FAILED);
    });
  });

  describe('sendPasswordResetEmail', () => {
    it('sucesso → resolve', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { email: 'a@b.com' }));
      await expect(service.sendPasswordResetEmail('a@b.com')).resolves.toBeUndefined();
    });

    it('EMAIL_NOT_FOUND → resolve em silêncio (sem enumeração)', async () => {
      fetchMock.mockResolvedValue(firebaseError(400, 'EMAIL_NOT_FOUND'));
      await expect(service.sendPasswordResetEmail('a@b.com')).resolves.toBeUndefined();
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it('outro 4xx → resolve e loga', async () => {
      fetchMock.mockResolvedValue(firebaseError(400, 'MISSING_EMAIL'));
      await expect(service.sendPasswordResetEmail('a@b.com')).resolves.toBeUndefined();
      expect(Logger.prototype.warn).toHaveBeenCalled();
    });

    it('provedor fora (timeout) → 503', async () => {
      fetchMock.mockRejectedValue(domException('TimeoutError'));
      await expectUnavailable(service.sendPasswordResetEmail('a@b.com'));
    });
  });

  describe('confirmPasswordReset', () => {
    it.each([
      ['EXPIRED_OOB_CODE', ErrorMessages.RESET_LINK_EXPIRED],
      ['INVALID_OOB_CODE', ErrorMessages.RESET_LINK_INVALID],
      ['WEAK_PASSWORD : Password should be at least 6 characters', ErrorMessages.WEAK_PASSWORD],
      ['SOMETHING_ELSE', ErrorMessages.PASSWORD_RESET_FAILED],
    ])('%s → 400', async (code, message) => {
      fetchMock.mockResolvedValue(firebaseError(400, code));

      const err = await service.confirmPasswordReset('oob', 'newpass').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).message).toBe(message);
    });

    it('HTTP 503 → 503 (não 400)', async () => {
      fetchMock.mockResolvedValue(htmlResponse(503));
      await expectUnavailable(service.confirmPasswordReset('oob', 'newpass'));
    });
  });
});
