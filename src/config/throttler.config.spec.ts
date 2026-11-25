import { Controller, ExecutionContext, ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerException, ThrottlerStorage } from '@nestjs/throttler';
import type Redis from 'ioredis';
import {
  AppThrottlerGuard,
  ThrottlerStorageRedis,
  ThrottlerStorageUnavailableError,
  createRedisClientForThrottler,
  isFailClosedRoute,
} from './throttler.config';
import { ErrorMessages } from '../common/constants/error-messages';

@Controller('auth')
class FakeAuthController {
  login() {}
}

@Controller('cards')
class FakeCardsController {
  list() {}
}

const contextFor = (controller: new () => object, handler: string): ExecutionContext => {
  const res = { header: jest.fn() };
  return {
    getClass: () => controller,
    getHandler: () => (controller.prototype as Record<string, () => void>)[handler],
    switchToHttp: () => ({
      getRequest: () => ({ ip: '1.2.3.4', headers: {} }),
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
};

describe('ThrottlerStorageRedis', () => {
  it('lança ThrottlerStorageUnavailableError quando o Redis falha (decisão fica com o guard)', async () => {
    const redis = { exists: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) };
    const storage = new ThrottlerStorageRedis(redis as unknown as Redis);

    await expect(storage.increment('k', 1000, 10, 1000, 'short')).rejects.toBeInstanceOf(
      ThrottlerStorageUnavailableError,
    );
  });

  it('conta hits normalmente com Redis disponível', async () => {
    const redis = {
      exists: jest.fn().mockResolvedValue(0),
      zremrangebyscore: jest.fn().mockResolvedValue(0),
      zadd: jest.fn().mockResolvedValue(1),
      pexpire: jest.fn().mockResolvedValue(1),
      zcard: jest.fn().mockResolvedValue(3),
      set: jest.fn(),
    };
    const storage = new ThrottlerStorageRedis(redis as unknown as Redis);

    await expect(storage.increment('k', 1000, 10, 1000, 'short')).resolves.toEqual({
      totalHits: 3,
      timeToExpire: 1,
      isBlocked: false,
      timeToBlockExpire: 0,
    });
  });
});

describe('isFailClosedRoute', () => {
  it('identifica controllers de /auth', () => {
    expect(isFailClosedRoute(contextFor(FakeAuthController, 'login'))).toBe(true);
    expect(isFailClosedRoute(contextFor(FakeCardsController, 'list'))).toBe(false);
  });
});

describe('AppThrottlerGuard', () => {
  let storage: { increment: jest.Mock };
  let guard: AppThrottlerGuard;

  beforeEach(async () => {
    storage = { increment: jest.fn() };
    guard = new AppThrottlerGuard(
      { throttlers: [{ name: 'short', ttl: 1000, limit: 10 }] },
      storage as unknown as ThrottlerStorage,
      new Reflector(),
    );
    await guard.onModuleInit();
  });

  describe('com Redis fora do ar', () => {
    beforeEach(() => {
      storage.increment.mockRejectedValue(new ThrottlerStorageUnavailableError(new Error('down')));
    });

    it('falha fechado (503) em /auth/* com mensagem de ErrorMessages', async () => {
      const err = await guard
        .canActivate(contextFor(FakeAuthController, 'login'))
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ServiceUnavailableException);
      expect((err as ServiceUnavailableException).message).toBe(
        ErrorMessages.RATE_LIMIT_UNAVAILABLE,
      );
    });

    it('falha aberto nas demais rotas', async () => {
      await expect(guard.canActivate(contextFor(FakeCardsController, 'list'))).resolves.toBe(true);
    });
  });

  it('continua retornando 429 quando o limite é excedido', async () => {
    storage.increment.mockResolvedValue({
      totalHits: 11,
      timeToExpire: 0,
      isBlocked: true,
      timeToBlockExpire: 1,
    });
    await expect(guard.canActivate(contextFor(FakeCardsController, 'list'))).rejects.toBeInstanceOf(
      ThrottlerException,
    );
  });

  it('não engole outros erros do storage', async () => {
    storage.increment.mockRejectedValue(new Error('bug'));
    await expect(guard.canActivate(contextFor(FakeCardsController, 'list'))).rejects.toThrow('bug');
  });
});

describe('createRedisClientForThrottler', () => {
  it('falha rápido: commandTimeout, connectTimeout e 1 retry por comando', () => {
    const client = createRedisClientForThrottler(() => undefined);
    try {
      expect(client.options).toEqual(
        expect.objectContaining({
          db: 2,
          lazyConnect: true,
          commandTimeout: 1000,
          connectTimeout: 2000,
          maxRetriesPerRequest: 1,
        }),
      );
      expect(client.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      client.disconnect();
    }
  });
});
