import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheckError, HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';
import { envReaderFrom, readRedisConnection, toIoRedisOptions } from '../config/redis-connection';

@Injectable()
export class RedisHealthIndicator extends HealthIndicator implements OnModuleDestroy {
  private readonly logger = new Logger(RedisHealthIndicator.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    super();
    this.client = new Redis({
      ...toIoRedisOptions(readRedisConnection(envReaderFrom(config))),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      // Redis conectado mas travado: o PING falha em 1 s em vez de segurar o /health.
      commandTimeout: 1000,
    });

    // Sem listener, o ioredis emite "Unhandled error event" a cada tentativa de reconexão.
    // Loga só a primeira falha de cada queda; o detalhe por requisição sai em isHealthy.
    let down = false;
    this.client.on('error', (err: Error & { code?: string }) => {
      if (!down) {
        this.logger.warn(
          `Redis unavailable for health check: ${err.message || err.code || err.name}`,
        );
      }
      down = true;
    });
    this.client.on('ready', () => {
      if (down) this.logger.log('Redis reconnected for health check');
      down = false;
    });
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      if (this.client.status === 'wait') await this.client.connect();
      const pong = await this.client.ping();
      if (pong !== 'PONG') throw new Error(`unexpected PING reply: ${pong}`);
      return this.getStatus(key, true);
    } catch (error) {
      // O endpoint é público: o detalhe (host, porta, erro de auth) fica só no log.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.error(`Redis health check failed: ${detail}`);
      throw new HealthCheckError(
        'Redis check failed',
        this.getStatus(key, false, { message: 'unavailable' }),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status !== 'end') this.client.disconnect();
  }
}
