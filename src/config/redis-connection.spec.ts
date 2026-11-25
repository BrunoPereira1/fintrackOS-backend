import { readRedisConnection, toIoRedisOptions, toNodeRedisOptions } from './redis-connection';

const reader = (env: Record<string, string>) => (key: string) => env[key];

describe('redis-connection', () => {
  it('usa localhost:6379 sem senha nem TLS por padrão', () => {
    const conn = readRedisConnection(reader({}));
    expect(conn).toEqual({ host: 'localhost', port: 6379, password: undefined, tls: false });
    expect(toIoRedisOptions(conn)).toEqual({ host: 'localhost', port: 6379 });
    expect(toNodeRedisOptions(conn)).toEqual({ socket: { host: 'localhost', port: 6379 } });
  });

  it('aplica REDIS_PASSWORD e REDIS_TLS=true nos dois formatos de cliente', () => {
    const conn = readRedisConnection(
      reader({ REDIS_HOST: 'r', REDIS_PORT: '6380', REDIS_PASSWORD: 's3cr3t', REDIS_TLS: 'true' }),
    );
    expect(toIoRedisOptions(conn)).toEqual({ host: 'r', port: 6380, password: 's3cr3t', tls: {} });
    expect(toNodeRedisOptions(conn)).toEqual({
      socket: { host: 'r', port: 6380, tls: true },
      password: 's3cr3t',
    });
  });

  it('trata REDIS_PASSWORD vazio como sem senha', () => {
    expect(readRedisConnection(reader({ REDIS_PASSWORD: '' })).password).toBeUndefined();
  });
});
