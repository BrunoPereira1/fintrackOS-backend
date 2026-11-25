import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CacheConfig } from './cache.config';

const calls: string[] = [];
const mockClient: { on: jest.Mock; connect: jest.Mock } = {
  on: jest.fn((event: string): void => {
    calls.push(`on:${event}`);
  }),
  connect: jest.fn(),
};
const createClient = jest.fn((_opts: unknown) => mockClient);

jest.mock('redis', () => ({ createClient: (opts: unknown) => createClient(opts) }));
jest.mock('cache-manager-redis-yet', () => ({
  redisInsStore: jest.fn(() => ({ client: mockClient })),
}));

const config = (env: Record<string, string>) =>
  ({ get: (key: string) => env[key] }) as unknown as ConfigService;

const emit = (event: string, ...args: unknown[]) => {
  const call = (mockClient.on.mock.calls as [string, (...a: unknown[]) => void][]).find(
    ([name]) => name === event,
  );
  if (!call) throw new Error(`no listener for ${event}`);
  call[1](...args);
};

describe('CacheConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calls.length = 0;
    mockClient.connect.mockImplementation(() => {
      calls.push('connect');
      return Promise.resolve();
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  it('cria o cliente no DB 1, sem fila offline e com a senha do helper de conexão', async () => {
    await new CacheConfig(config({ REDIS_PASSWORD: 'pw' })).createCacheOptions();

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        database: 1,
        disableOfflineQueue: true,
        password: 'pw',
        socket: expect.objectContaining({ host: 'localhost', port: 6379 }),
      }),
    );
  });

  it('registra o listener de error ANTES de conectar', async () => {
    await new CacheConfig(config({})).createCacheOptions();
    expect(calls.indexOf('on:error')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('on:error')).toBeLessThan(calls.indexOf('connect'));
  });

  it('fail-open no boot: Redis fora não impede a API de subir', async () => {
    // node-redis tenta reconectar para sempre: o connect nunca resolve com o Redis fora
    mockClient.connect.mockImplementation(() => new Promise(() => undefined));
    await expect(new CacheConfig(config({})).createCacheOptions()).resolves.toEqual(
      expect.objectContaining({ stores: expect.any(Array) }),
    );
  });

  it('fail-open no boot: connect rejeitado é capturado e logado', async () => {
    mockClient.connect.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(new CacheConfig(config({})).createCacheOptions()).resolves.toBeDefined();
    await new Promise(process.nextTick);
    expect(Logger.prototype.warn).toHaveBeenCalled();
  });

  it('loga só a primeira falha de cada queda', async () => {
    await new CacheConfig(config({})).createCacheOptions();

    emit('error', new Error('ECONNREFUSED'));
    emit('error', new Error('ECONNREFUSED'));
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);

    emit('ready');
    expect(Logger.prototype.log).toHaveBeenCalledTimes(1);
  });
});
