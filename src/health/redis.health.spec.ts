import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthCheckError } from '@nestjs/terminus';
import { RedisHealthIndicator } from './redis.health';

const mockClient = {
  status: 'ready',
  connect: jest.fn(),
  ping: jest.fn(),
  disconnect: jest.fn(),
  on: jest.fn(),
};

/** Dispara o listener registrado pelo indicador para o evento informado. */
const emit = (event: string, ...args: unknown[]) => {
  const call = mockClient.on.mock.calls.find(([name]) => name === event);
  if (!call) throw new Error(`no listener for ${event}`);
  (call[1] as (...a: unknown[]) => void)(...args);
};
const RedisCtor = jest.fn();

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation((opts: unknown) => {
    RedisCtor(opts);
    return mockClient;
  }),
}));

const config = (env: Record<string, string>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('RedisHealthIndicator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('falha rápido: commandTimeout e connectTimeout no cliente', () => {
    new RedisHealthIndicator(config({}));
    expect(RedisCtor).toHaveBeenCalledWith(
      expect.objectContaining({ commandTimeout: 1000, connectTimeout: 2000, lazyConnect: true }),
    );
  });

  it('registra listener de error e loga só a primeira falha de cada queda', () => {
    new RedisHealthIndicator(config({}));

    emit('error', new Error('ECONNREFUSED'));
    emit('error', new Error('ECONNREFUSED'));
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);

    emit('ready');
    expect(Logger.prototype.log).toHaveBeenCalledTimes(1);

    emit('error', new Error('ECONNRESET'));
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(2);
  });

  it('usa REDIS_PASSWORD/REDIS_TLS do helper de conexão', () => {
    new RedisHealthIndicator(config({ REDIS_PASSWORD: 'pw', REDIS_TLS: 'true' }));
    expect(RedisCtor).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'localhost', port: 6379, password: 'pw', tls: {} }),
    );
  });

  it('retorna up quando o PING responde', async () => {
    mockClient.ping.mockResolvedValue('PONG');
    const indicator = new RedisHealthIndicator(config({}));
    await expect(indicator.isHealthy('redis')).resolves.toEqual({ redis: { status: 'up' } });
  });

  it('não vaza o erro interno na resposta e loga o detalhe', async () => {
    mockClient.ping.mockRejectedValue(new Error('NOAUTH Authentication required. 10.0.0.5:6379'));
    const indicator = new RedisHealthIndicator(config({}));

    const err = await indicator.isHealthy('redis').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(HealthCheckError);
    expect((err as HealthCheckError).causes).toEqual({
      redis: { status: 'down', message: 'unavailable' },
    });
    expect(JSON.stringify((err as HealthCheckError).causes)).not.toContain('NOAUTH');
    expect(Logger.prototype.error).toHaveBeenCalledWith(expect.stringContaining('NOAUTH'));
  });
});
