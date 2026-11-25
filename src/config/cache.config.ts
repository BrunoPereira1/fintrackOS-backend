import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheOptionsFactory, CacheOptions } from '@nestjs/cache-manager';
// `redis` (node-redis v4) é a dependência do próprio cache-manager-redis-yet; o cliente é criado
// aqui, e não pelo `redisStore()`, para registrar o listener de erro antes de conectar.
import { createClient, type RedisClientType } from 'redis';
import { redisInsStore } from 'cache-manager-redis-yet';
import { KeyvAdapter } from 'cache-manager';
import Keyv from 'keyv';
import { CacheTTL } from '../common/cache-keys';
import { envReaderFrom, readRedisConnection, toNodeRedisOptions } from './redis-connection';

/**
 * Cache (sessão/perfil) é **fail-open, inclusive no boot**: a API sobe sem Redis e o cache
 * degrada (sessão → Firebase, perfil → banco). Por isso:
 *  - o listener de `error` é registrado ANTES de conectar (sem ele, o primeiro erro do
 *    node-redis derruba o processo);
 *  - o `connect()` não é aguardado: com o Redis fora, o node-redis tenta reconectar para
 *    sempre e o `await` travaria o boot;
 *  - `disableOfflineQueue` faz os comandos falharem na hora enquanto não há conexão.
 */
@Injectable()
export class CacheConfig implements CacheOptionsFactory {
  private readonly logger = new Logger(CacheConfig.name);

  constructor(private readonly config: ConfigService) {}

  async createCacheOptions(): Promise<CacheOptions> {
    const client = createClient({
      ...toNodeRedisOptions(readRedisConnection(envReaderFrom(this.config))),
      database: 1, // DB 1 — separado do BullMQ (DB 0) e do throttler (DB 2)
      // Sem Redis, comandos falham na hora (os callers já tratam erro de cache) em vez de
      // ficarem presos na fila offline até a reconexão.
      disableOfflineQueue: true,
    }) as RedisClientType;

    // Loga só a primeira falha de cada queda (o client tenta reconectar várias vezes por segundo).
    let down = false;
    client.on('error', (err: Error & { code?: string }) => {
      if (down) return;
      down = true;
      this.logger.warn(`Cache Redis client error: ${err.message || err.code || err.name}`);
    });
    client.on('ready', () => {
      if (down) this.logger.log('Cache Redis client reconnected');
      down = false;
    });

    // Sem await: o boot não espera o Redis. Uma rejeição (ex.: configuração inválida) só é logada.
    client.connect().catch((err: Error) => {
      this.logger.warn(`Cache Redis connect failed, running without cache: ${err.message}`);
    });

    const store = redisInsStore(client);

    return {
      stores: [new Keyv({ store: new KeyvAdapter(store) })],
      ttl: CacheTTL.USER_PROFILE,
    };
  }
}
