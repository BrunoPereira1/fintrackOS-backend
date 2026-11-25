import { Logger } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { CACHE_OP_TIMEOUT_MS, SessionWriteOptions, TokenCacheService } from './token-cache.service';
import { User } from '../users/entities/user.entity';
import { CacheKeys, CacheTTL } from '../common/cache-keys';
import { Plan } from '../users/enums/plan.enum';

const TOKEN = 'id-token-abc';
const OTHER_TOKEN = 'id-token-def';
const UID = 'firebase-uid-1';
const NOW = new Date('2026-01-01T12:00:00Z').getTime();

const mockUser = (): User => ({ id: 'uuid-1', firebaseUid: UID, plan: Plan.BASIC }) as User;

/** Fake em memória de get/set/del com TTL (ms), respeitando o relógio do Jest. */
const createMemoryCache = () => {
  const store = new Map<string, { value: unknown; expiresAt: number }>();
  return {
    store,
    get: jest.fn(async (key: string) => {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (Date.now() >= hit.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    }),
    set: jest.fn(async (key: string, value: unknown, ttl: number) => {
      store.set(key, { value, expiresAt: Date.now() + ttl });
    }),
    del: jest.fn(async (key: string) => {
      store.delete(key);
    }),
  };
};

describe('TokenCacheService', () => {
  let service: TokenCacheService;
  let cache: ReturnType<typeof createMemoryCache>;

  const opts = (overrides: Partial<SessionWriteOptions> = {}): SessionWriteOptions => ({
    expiresAt: NOW + 60 * 60 * 1000, // token válido por 1h
    version: '0',
    ...overrides,
  });

  const sessionTtl = () => {
    const call = cache.set.mock.calls.find(([key]) => key === CacheKeys.tokenSession(TOKEN));
    return call?.[2];
  };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(NOW);
    cache = createMemoryCache();

    const module: TestingModule = await Test.createTestingModule({
      providers: [TokenCacheService, { provide: CACHE_MANAGER, useValue: cache }],
    }).compile();

    service = module.get(TokenCacheService);
  });

  afterEach(() => jest.useRealTimers());

  describe('setByToken', () => {
    it('grava sessão do token e perfil do usuário', async () => {
      const user = mockUser();
      await service.setByToken(TOKEN, user, opts());

      expect(sessionTtl()).toBe(CacheTTL.TOKEN_SESSION);
      expect(cache.set).toHaveBeenCalledWith(
        CacheKeys.userProfile(UID),
        user,
        CacheTTL.USER_PROFILE,
      );
      await expect(service.getByToken(TOKEN)).resolves.toEqual(user);
    });

    it('TTL da sessão respeita o exp do token (expira em 60s → TTL 60s)', async () => {
      await service.setByToken(TOKEN, mockUser(), opts({ expiresAt: NOW + 60_000 }));
      expect(sessionTtl()).toBe(60_000);
    });

    it('token já expirado → não grava sessão nem perfil', async () => {
      await service.setByToken(TOKEN, mockUser(), opts({ expiresAt: NOW - 1 }));
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('não grava nada se as sessões foram invalidadas depois da leitura da versão', async () => {
      const version = await service.getSessionVersion(UID);
      await service.invalidateAllSessions(UID);
      cache.set.mockClear();

      await service.setByToken(TOKEN, mockUser(), opts({ version }));

      expect(cache.set).not.toHaveBeenCalled();
      await expect(service.getByToken(TOKEN)).resolves.toBeUndefined();
    });
  });

  describe('setSessionOnly', () => {
    it('grava apenas a sessão do token, sem renovar user:profile', async () => {
      await service.setSessionOnly(TOKEN, mockUser(), opts());

      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(sessionTtl()).toBe(CacheTTL.TOKEN_SESSION);
    });

    it('TTL respeita o exp do token (expira em 60s → TTL 60s)', async () => {
      await service.setSessionOnly(TOKEN, mockUser(), opts({ expiresAt: NOW + 60_000 }));
      expect(sessionTtl()).toBe(60_000);
    });

    it('token já expirado → não grava', async () => {
      await service.setSessionOnly(TOKEN, mockUser(), opts({ expiresAt: NOW }));
      expect(cache.set).not.toHaveBeenCalled();
    });

    it('não propaga falhas do cache', async () => {
      cache.set.mockRejectedValue(new Error('redis down'));
      await expect(service.setSessionOnly(TOKEN, mockUser(), opts())).resolves.toBeUndefined();
    });
  });

  describe('getByToken', () => {
    it('sessão expira junto com o token', async () => {
      await service.setSessionOnly(TOKEN, mockUser(), opts({ expiresAt: NOW + 60_000 }));
      jest.setSystemTime(NOW + 60_001);
      await expect(service.getByToken(TOKEN)).resolves.toBeUndefined();
    });

    it('ignora entradas no formato antigo (User puro, sem versão)', async () => {
      await cache.set(CacheKeys.tokenSession(TOKEN), mockUser(), CacheTTL.TOKEN_SESSION);
      await expect(service.getByToken(TOKEN)).resolves.toBeUndefined();
    });

    it('falha do cache → undefined (revalida no Firebase)', async () => {
      cache.get.mockRejectedValue(new Error('redis down'));
      await expect(service.getByToken(TOKEN)).resolves.toBeUndefined();
    });
  });

  describe('invalidateAllSessions', () => {
    it('derruba todas as sessões do uid e o perfil', async () => {
      const user = mockUser();
      await service.setByToken(TOKEN, user, opts());
      await service.setSessionOnly(OTHER_TOKEN, user, opts());
      await expect(service.getByToken(TOKEN)).resolves.toEqual(user);

      await service.invalidateAllSessions(UID);

      await expect(service.getByToken(TOKEN)).resolves.toBeUndefined();
      await expect(service.getByToken(OTHER_TOKEN)).resolves.toBeUndefined();
      await expect(service.getByFirebaseUid(UID)).resolves.toBeUndefined();
    });

    it('não afeta sessões de outros usuários', async () => {
      const other = { ...mockUser(), id: 'uuid-2', firebaseUid: 'firebase-uid-2' } as User;
      await service.setSessionOnly(OTHER_TOKEN, other, opts());

      await service.invalidateAllSessions(UID);

      await expect(service.getByToken(OTHER_TOKEN)).resolves.toEqual(other);
    });

    it('sessões gravadas depois com a nova versão voltam a valer', async () => {
      await service.invalidateAllSessions(UID);
      const version = await service.getSessionVersion(UID);
      expect(version).not.toBe('0');

      await service.setSessionOnly(TOKEN, mockUser(), opts({ version }));
      await expect(service.getByToken(TOKEN)).resolves.toEqual(mockUser());
    });

    it('a versão vive mais que qualquer sessão gravada antes da invalidação', () => {
      expect(CacheTTL.SESSION_VERSION).toBeGreaterThan(CacheTTL.TOKEN_SESSION);
    });

    it('não propaga falhas do cache', async () => {
      cache.set.mockRejectedValue(new Error('redis down'));
      cache.del.mockRejectedValue(new Error('redis down'));
      await expect(service.invalidateAllSessions(UID)).resolves.toBeUndefined();
    });
  });

  describe('invalidateUser', () => {
    it('apaga user:profile:{uid}', async () => {
      await service.invalidateUser(UID);
      expect(cache.del).toHaveBeenCalledWith('user:profile:firebase-uid-1');
    });
  });

  describe('Redis travado (comando sem resposta)', () => {
    const hang = () => new Promise<never>(() => undefined);

    beforeEach(() => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      cache.get.mockImplementation(hang);
      cache.set.mockImplementation(hang);
      cache.del.mockImplementation(hang);
    });

    afterEach(() => jest.restoreAllMocks());

    /** Avança o relógio até o timeout e devolve o resultado da operação. */
    const settle = async <T>(promise: Promise<T>): Promise<T> => {
      let done = false;
      void promise.finally(() => (done = true));
      await jest.advanceTimersByTimeAsync(CACHE_OP_TIMEOUT_MS - 1);
      expect(done).toBe(false); // não desiste antes do prazo
      await jest.advanceTimersByTimeAsync(1);
      return promise;
    };

    it('timeout curto (500 ms)', () => {
      expect(CACHE_OP_TIMEOUT_MS).toBe(500);
    });

    it('getByToken → undefined (revalida no Firebase)', async () => {
      await expect(settle(service.getByToken(TOKEN))).resolves.toBeUndefined();
    });

    it('getSessionVersion → versão inicial', async () => {
      await expect(settle(service.getSessionVersion(UID))).resolves.toBe('0');
    });

    it('getByFirebaseUid → undefined (busca no banco)', async () => {
      await expect(settle(service.getByFirebaseUid(UID))).resolves.toBeUndefined();
    });

    it('setByToken / setSessionOnly não seguram a requisição', async () => {
      await expect(settle(service.setByToken(TOKEN, mockUser(), opts()))).resolves.toBeUndefined();
      await expect(
        settle(service.setSessionOnly(TOKEN, mockUser(), opts())),
      ).resolves.toBeUndefined();
    });

    it('invalidateUser / invalidateAllSessions não seguram a requisição', async () => {
      await expect(settle(service.invalidateUser(UID))).resolves.toBeUndefined();
      const all = service.invalidateAllSessions(UID);
      // duas operações em sequência (versão + perfil), cada uma com seu próprio prazo
      await jest.advanceTimersByTimeAsync(CACHE_OP_TIMEOUT_MS * 2);
      await expect(all).resolves.toBeUndefined();
    });
  });

  it('operações normais não deixam timers pendentes', async () => {
    await service.setByToken(TOKEN, mockUser(), opts());
    await service.getByToken(TOKEN);
    expect(jest.getTimerCount()).toBe(0);
  });
});
