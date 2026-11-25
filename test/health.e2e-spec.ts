import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { DatabaseModule } from '../src/database/database.module';
import { HealthModule } from '../src/health/health.module';

/**
 * Requer PostgreSQL e Redis acessíveis (local: `make up`; CI: services do workflow).
 */
describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), DatabaseModule, HealthModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health/live → 200', () => {
    return request(app.getHttpServer()).get('/health/live').expect(200, { status: 'ok' });
  });

  it('GET /health → 200 com database e redis "up"', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.info.database.status).toBe('up');
    expect(res.body.info.redis.status).toBe('up');
  });
});
