import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

@ApiTags('health')
// SkipThrottle() sem argumentos só pula o throttler "default"; os nomeados precisam ser listados.
@SkipThrottle({ default: true, short: true, medium: true })
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  /** Liveness: o processo está de pé (não verifica dependências). */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: PostgreSQL e Redis respondendo. */
  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 2000 }),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
