import { ExecutionContext, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import type { ThrottlerRequest } from '@nestjs/throttler';
import type { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';
import { EnvReader, readRedisConnection, toIoRedisOptions } from './redis-connection';
import { ErrorMessages } from '../common/constants/error-messages';

/**
 * Lançado pelo storage quando o Redis está indisponível. O `AppThrottlerGuard` decide se
 * a requisição passa (fail-open) ou é recusada (fail-closed) conforme a rota.
 */
export class ThrottlerStorageUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Throttler storage unavailable: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'ThrottlerStorageUnavailableError';
  }
}

/** Prefixos de controller (`@Controller('<prefixo>')`) que falham fechado sem Redis. */
export const FAIL_CLOSED_CONTROLLER_PATHS = ['auth'];

/**
 * Sliding-window rate limiter backed by Redis (DB 2).
 *
 * Por request:
 *  1. Verifica chave de bloqueio — retorna imediatamente se bloqueado.
 *  2. Remove entradas fora da janela (ZREMRANGEBYSCORE).
 *  3. Adiciona entrada atual (ZADD).
 *  4. Conta total na janela (ZCARD).
 *  5. Se excedeu o limite, grava chave de bloqueio com TTL = blockDuration.
 */
@Injectable()
export class ThrottlerStorageRedis implements ThrottlerStorage {
  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number, // ms
    limit: number,
    blockDuration: number, // ms
    _throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const trackKey = `throttle:${key}`;
    const blockKey = `throttle:${key}:blocked`;
    const now = Date.now();

    try {
      // ── Verifica bloqueio ──────────────────────────────────────────────
      const isBlocked = await this.redis.exists(blockKey);
      if (isBlocked) {
        const remaining = await this.redis.pttl(blockKey);
        return {
          totalHits: limit + 1,
          timeToExpire: 0,
          isBlocked: true,
          timeToBlockExpire: Math.ceil(remaining / 1000),
        };
      }

      // ── Janela deslizante ──────────────────────────────────────────────
      const windowStart = now - ttl;
      const member = `${now}:${Math.random().toString(36).slice(2)}`;

      await this.redis.zremrangebyscore(trackKey, 0, windowStart);
      await this.redis.zadd(trackKey, now, member);
      await this.redis.pexpire(trackKey, ttl);

      const totalHits = await this.redis.zcard(trackKey);

      // ── Bloqueia se excedeu ────────────────────────────────────────────
      if (totalHits > limit && blockDuration > 0) {
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
        return {
          totalHits,
          timeToExpire: 0,
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockDuration / 1000),
        };
      }

      return {
        totalHits,
        timeToExpire: Math.ceil(ttl / 1000),
        isBlocked: false,
        timeToBlockExpire: 0,
      };
    } catch (err) {
      // A decisão (fail-open/fail-closed) fica com o AppThrottlerGuard, que conhece a rota.
      throw new ThrottlerStorageUnavailableError(err);
    }
  }
}

/**
 * ThrottlerGuard com política de falha por rota quando o storage (Redis) está fora:
 *  - controllers em `FAIL_CLOSED_CONTROLLER_PATHS` (ex.: /auth/*) → 503, para não liberar
 *    brute force de login/reset de senha sem rate limit;
 *  - demais rotas → passam (fail-open), para não derrubar a API inteira.
 *
 * A chave entregue ao storage é um hash sem a rota, por isso a decisão é tomada aqui.
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(AppThrottlerGuard.name);

  protected async handleRequest(requestProps: ThrottlerRequest): Promise<boolean> {
    try {
      return await super.handleRequest(requestProps);
    } catch (err) {
      if (!(err instanceof ThrottlerStorageUnavailableError)) throw err;

      const failClosed = isFailClosedRoute(requestProps.context);
      this.logger.warn(`${err.message} — ${failClosed ? 'rejecting (fail-closed)' : 'allowing'}`);
      if (failClosed) throw new ServiceUnavailableException(ErrorMessages.RATE_LIMIT_UNAVAILABLE);
      return true;
    }
  }
}

export function isFailClosedRoute(context: ExecutionContext): boolean {
  const raw: unknown = Reflect.getMetadata(PATH_METADATA, context.getClass());
  const paths = (Array.isArray(raw) ? raw : [raw])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.replace(/^\/+|\/+$/g, '').toLowerCase());
  return paths.some((p) =>
    FAIL_CLOSED_CONTROLLER_PATHS.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)),
  );
}

export function createRedisClientForThrottler(env: EnvReader): Redis {
  const client = new Redis({
    ...toIoRedisOptions(readRedisConnection(env)),
    db: 2,
    lazyConnect: true,
    // Falha rápido quando o Redis cai, em vez de segurar a requisição na fila offline.
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    // Redis conectado mas travado: sem isto o comando espera indefinidamente.
    commandTimeout: 1000,
  });

  // Sem listener, o ioredis emite "Unhandled error event" a cada tentativa de reconexão.
  // Loga só a primeira falha de cada queda; o guard já trata a indisponibilidade.
  const logger = new Logger('ThrottlerRedis');
  let down = false;
  client.on('error', (err: Error & { code?: string }) => {
    if (!down)
      logger.warn(`Redis unavailable for throttler: ${err.message || err.code || err.name}`);
    down = true;
  });
  client.on('ready', () => {
    if (down) logger.log('Redis reconnected for throttler');
    down = false;
  });
  return client;
}
