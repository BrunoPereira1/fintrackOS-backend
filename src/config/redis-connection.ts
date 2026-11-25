import type { RedisOptions } from 'ioredis';
import type { redisStore } from 'cache-manager-redis-yet';

type NodeRedisOptions = NonNullable<Parameters<typeof redisStore>[0]>;

/** Lê uma variável de ambiente — aceita `ConfigService` ou `process.env`. */
export type EnvReader = (key: string) => string | undefined;

export interface RedisConnectionOptions {
  host: string;
  port: number;
  password?: string;
  tls: boolean;
}

export function envReaderFrom(source: { get: (key: string) => unknown }): EnvReader {
  return (key) => {
    const value = source.get(key);
    return value === undefined || value === null ? undefined : String(value);
  };
}

/**
 * Fonte única das opções de conexão Redis (cache, BullMQ, throttler, health).
 * `REDIS_PASSWORD` e `REDIS_TLS=true` são opcionais — sem eles conecta sem auth/TLS (dev/CI).
 */
export function readRedisConnection(env: EnvReader): RedisConnectionOptions {
  const password = env('REDIS_PASSWORD');
  return {
    host: env('REDIS_HOST') || 'localhost',
    port: Number(env('REDIS_PORT') || 6379),
    password: password ? password : undefined,
    tls: env('REDIS_TLS')?.toLowerCase() === 'true',
  };
}

/** Opções para clientes ioredis (BullMQ, throttler, health). */
export function toIoRedisOptions(conn: RedisConnectionOptions): RedisOptions {
  return {
    host: conn.host,
    port: conn.port,
    ...(conn.password ? { password: conn.password } : {}),
    ...(conn.tls ? { tls: {} } : {}),
  };
}

/** Opções para o cliente node-redis v4 (cache-manager-redis-yet). */
export function toNodeRedisOptions(conn: RedisConnectionOptions): NodeRedisOptions {
  return {
    socket: conn.tls
      ? { host: conn.host, port: conn.port, tls: true }
      : { host: conn.host, port: conn.port },
    ...(conn.password ? { password: conn.password } : {}),
  };
}
