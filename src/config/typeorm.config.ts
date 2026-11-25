import { DataSourceOptions } from 'typeorm';
import type { TlsOptions } from 'tls';
import * as path from 'path';

type LoggerOptions = NonNullable<DataSourceOptions['logging']>;

function parseBool(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  throw new Error(`Invalid boolean value "${value}" (use true/false)`);
}

/**
 * TLS do Postgres:
 *  - `DB_SSL` (default: true em produção, false fora dela);
 *  - `DB_SSL_CA`: certificado PEM da CA (aceita `\n` escapado, como FIREBASE_PRIVATE_KEY);
 *  - `DB_SSL_REJECT_UNAUTHORIZED` (default: true). `false` desativa a validação do certificado —
 *    escape documentado para provedores sem CA disponível; nunca é o padrão.
 */
export function buildSslConfig(env: NodeJS.ProcessEnv): false | TlsOptions {
  const isProduction = env.NODE_ENV === 'production';
  const enabled = parseBool(env.DB_SSL) ?? isProduction;
  if (!enabled) return false;

  const ssl: TlsOptions = {
    rejectUnauthorized: parseBool(env.DB_SSL_REJECT_UNAUTHORIZED) ?? true,
  };
  const ca = env.DB_SSL_CA?.replace(/\\n/g, '\n').trim();
  if (ca) ssl.ca = ca;
  return ssl;
}

/** Por padrão só erros/avisos — `logging: true` gravaria toda query com parâmetros (dados pessoais). */
export function buildLoggingConfig(env: NodeJS.ProcessEnv): LoggerOptions {
  return parseBool(env.DB_LOGGING) ? true : ['error', 'warn'];
}

function parsePositiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${name} "${value}" (use a positive integer in ms)`);
  }
  return n;
}

/**
 * Timeouts do pool `pg` (repassados via `extra`):
 *  - `DB_CONNECT_TIMEOUT_MS` (default 5000): espera máxima por uma conexão nova — sem ele,
 *    um Postgres inalcançável segura a requisição indefinidamente;
 *  - `DB_STATEMENT_TIMEOUT_MS` (default 15000): o Postgres cancela queries mais longas.
 */
export function buildPoolTimeouts(env: NodeJS.ProcessEnv): {
  connectionTimeoutMillis: number;
  statement_timeout: number;
} {
  return {
    connectionTimeoutMillis: parsePositiveInt(
      'DB_CONNECT_TIMEOUT_MS',
      env.DB_CONNECT_TIMEOUT_MS,
      5000,
    ),
    statement_timeout: parsePositiveInt(
      'DB_STATEMENT_TIMEOUT_MS',
      env.DB_STATEMENT_TIMEOUT_MS,
      15000,
    ),
  };
}

export function buildTypeOrmConfig(env: NodeJS.ProcessEnv): DataSourceOptions {
  const isProduction = env.NODE_ENV === 'production';

  if (isProduction && !env.DATABASE_URL && !env.DB_PASSWORD) {
    throw new Error('Database credentials are missing. Set DATABASE_URL or DB_PASSWORD.');
  }

  return {
    type: 'postgres',
    url: env.DATABASE_URL,
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 5432),
    username: env.DB_USERNAME ?? 'fintrack',
    password: env.DB_PASSWORD,
    database: env.DB_NAME ?? 'fintrack_db',
    entities: [path.join(__dirname, '/../**/*.entity{.ts,.js}')],
    migrations: [path.join(__dirname, '/../database/migrations/*{.ts,.js}')],
    migrationsRun: false,
    synchronize: false,
    logging: buildLoggingConfig(env),
    ssl: buildSslConfig(env),
    extra: buildPoolTimeouts(env),
  };
}
