import { buildTypeOrmConfig } from './typeorm.config';

const PEM = '-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----';
const PEM_ESCAPED = '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----\\n';

const build = (env: NodeJS.ProcessEnv) =>
  buildTypeOrmConfig(env) as ReturnType<typeof buildTypeOrmConfig> & {
    ssl: unknown;
    password?: string;
    logging: unknown;
    extra: { connectionTimeoutMillis: number; statement_timeout: number };
  };

describe('buildTypeOrmConfig', () => {
  describe('ssl', () => {
    it('fica desligado fora de produção por padrão', () => {
      expect(build({ NODE_ENV: 'development' }).ssl).toBe(false);
    });

    it('liga em produção validando o certificado por padrão', () => {
      expect(build({ NODE_ENV: 'production', DB_PASSWORD: 'x' }).ssl).toEqual({
        rejectUnauthorized: true,
      });
    });

    it('DB_SSL=false desliga em produção; DB_SSL=true liga em dev', () => {
      expect(build({ NODE_ENV: 'production', DB_PASSWORD: 'x', DB_SSL: 'false' }).ssl).toBe(false);
      expect(build({ NODE_ENV: 'development', DB_SSL: 'true' }).ssl).toEqual({
        rejectUnauthorized: true,
      });
    });

    it('usa DB_SSL_CA convertendo \\n escapado em quebra de linha', () => {
      const ssl = build({ NODE_ENV: 'production', DB_PASSWORD: 'x', DB_SSL_CA: PEM_ESCAPED })
        .ssl as { ca: string; rejectUnauthorized: boolean };
      expect(ssl.ca).toBe(PEM);
      expect(ssl.rejectUnauthorized).toBe(true);
    });

    it('permite desativar a validação apenas com DB_SSL_REJECT_UNAUTHORIZED=false explícito', () => {
      expect(
        build({ NODE_ENV: 'production', DB_PASSWORD: 'x', DB_SSL_REJECT_UNAUTHORIZED: 'false' })
          .ssl,
      ).toEqual({ rejectUnauthorized: false });
    });

    it('rejeita valor booleano inválido', () => {
      expect(() => build({ NODE_ENV: 'production', DB_PASSWORD: 'x', DB_SSL: 'talvez' })).toThrow(
        /Invalid boolean/,
      );
    });
  });

  describe('credenciais', () => {
    it('não tem senha padrão hardcoded', () => {
      expect(build({ NODE_ENV: 'development' }).password).toBeUndefined();
    });

    it('falha em produção sem DB_PASSWORD nem DATABASE_URL', () => {
      expect(() => build({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL or DB_PASSWORD/);
    });

    it('aceita DATABASE_URL em produção sem DB_PASSWORD', () => {
      expect(() =>
        build({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u:p@db:5432/x' }),
      ).not.toThrow();
    });
  });

  describe('logging', () => {
    it('registra só erros e avisos por padrão (sem queries/parâmetros)', () => {
      expect(build({ NODE_ENV: 'development' }).logging).toEqual(['error', 'warn']);
      expect(build({ NODE_ENV: 'production', DB_PASSWORD: 'x' }).logging).toEqual([
        'error',
        'warn',
      ]);
    });

    it('DB_LOGGING=true habilita log completo', () => {
      expect(build({ NODE_ENV: 'development', DB_LOGGING: 'true' }).logging).toBe(true);
    });
  });

  describe('timeouts do pool (extra)', () => {
    it('usa 5 s para conectar e 15 s por statement por padrão', () => {
      expect(build({ NODE_ENV: 'development' }).extra).toEqual({
        connectionTimeoutMillis: 5000,
        statement_timeout: 15000,
      });
    });

    it('DB_CONNECT_TIMEOUT_MS e DB_STATEMENT_TIMEOUT_MS sobrescrevem os padrões', () => {
      expect(
        build({
          NODE_ENV: 'development',
          DB_CONNECT_TIMEOUT_MS: '2000',
          DB_STATEMENT_TIMEOUT_MS: '30000',
        }).extra,
      ).toEqual({ connectionTimeoutMillis: 2000, statement_timeout: 30000 });
    });

    it('valor vazio cai no padrão', () => {
      expect(build({ NODE_ENV: 'development', DB_CONNECT_TIMEOUT_MS: '' }).extra).toEqual(
        expect.objectContaining({ connectionTimeoutMillis: 5000 }),
      );
    });

    it.each(['abc', '0', '-1', '1.5'])('rejeita valor inválido "%s"', (value) => {
      expect(() => build({ NODE_ENV: 'development', DB_STATEMENT_TIMEOUT_MS: value })).toThrow(
        /DB_STATEMENT_TIMEOUT_MS/,
      );
    });
  });
});
