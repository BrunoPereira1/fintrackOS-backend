import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { ErrorMessages } from './constants/error-messages';

/** Código SQLSTATE do Postgres para violação de unicidade. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Código SQLSTATE do Postgres para violação de chave estrangeira. */
export const PG_FOREIGN_KEY_VIOLATION = '23503';

/** SQLSTATE de deadlock detectado pelo Postgres (uma das transações é abortada). */
export const PG_DEADLOCK_DETECTED = '40P01';

/** SQLSTATE de falha de serialização (isolamento REPEATABLE READ/SERIALIZABLE). */
export const PG_SERIALIZATION_FAILURE = '40001';

function isPgViolation(err: unknown, code: string, constraint?: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driverError = err.driverError as { code?: string; constraint?: string } | undefined;
  if (driverError?.code !== code) return false;
  return !constraint || driverError.constraint === constraint;
}

/**
 * `true` se o erro é uma violação de unicidade do Postgres. Se `constraint` for informado,
 * exige também que a violação seja daquele índice/constraint (evita mascarar outras).
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  return isPgViolation(err, PG_UNIQUE_VIOLATION, constraint);
}

/**
 * `true` se o erro é uma violação de chave estrangeira do Postgres (23503 — ex.: a FK
 * `NO ACTION DEFERRABLE INITIALLY DEFERRED` de `cost_splits → contacts` barrando, no COMMIT, a
 * remoção de um registro referenciado). Se `constraint` for informado, exige também que a
 * violação seja daquela FK (evita mascarar outras).
 */
export function isForeignKeyViolation(err: unknown, constraint?: string): boolean {
  return isPgViolation(err, PG_FOREIGN_KEY_VIOLATION, constraint);
}

/**
 * `true` se a transação de banco foi abortada por deadlock (40P01) ou falha de serialização
 * (40001): conflito com outra requisição simultânea — o cliente pode tentar de novo.
 */
export function isTransactionConflict(err: unknown): boolean {
  return isPgViolation(err, PG_DEADLOCK_DETECTED) || isPgViolation(err, PG_SERIALIZATION_FAILURE);
}

/**
 * Executa `work` (tipicamente um `manager.transaction`) convertendo deadlock/serialização em
 * 409 `CONCURRENT_UPDATE`; outros erros passam intactos.
 */
export async function mapTransactionConflict<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (isTransactionConflict(err)) throw new ConflictException(ErrorMessages.CONCURRENT_UPDATE);
    throw err;
  }
}
