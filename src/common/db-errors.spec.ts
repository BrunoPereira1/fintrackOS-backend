import { QueryFailedError } from 'typeorm';
import { ConflictException } from '@nestjs/common';
import {
  isForeignKeyViolation,
  isTransactionConflict,
  isUniqueViolation,
  mapTransactionConflict,
} from './db-errors';
import { ErrorMessages } from './constants/error-messages';

const pgError = (code: string, constraint?: string) =>
  new QueryFailedError('SQL', [], Object.assign(new Error('pg'), { code, constraint }));

describe('db-errors', () => {
  describe('isUniqueViolation', () => {
    it('reconhece 23505 e confere a constraint quando informada', () => {
      const err = pgError('23505', 'UQ_x');
      expect(isUniqueViolation(err)).toBe(true);
      expect(isUniqueViolation(err, 'UQ_x')).toBe(true);
      expect(isUniqueViolation(err, 'UQ_y')).toBe(false);
    });

    it('ignora outros códigos e erros que não são do banco', () => {
      expect(isUniqueViolation(pgError('23503', 'UQ_x'))).toBe(false);
      expect(isUniqueViolation(new Error('x'))).toBe(false);
    });
  });

  describe('isForeignKeyViolation', () => {
    it('reconhece 23503 sem exigir constraint', () => {
      expect(isForeignKeyViolation(pgError('23503', 'FK_a'))).toBe(true);
    });

    it('exige a constraint informada (não mascara outra FK)', () => {
      const err = pgError('23503', 'FK_a');
      expect(isForeignKeyViolation(err, 'FK_a')).toBe(true);
      expect(isForeignKeyViolation(err, 'FK_b')).toBe(false);
    });

    it('ignora violação de unicidade e erros que não são QueryFailedError', () => {
      expect(isForeignKeyViolation(pgError('23505', 'FK_a'))).toBe(false);
      expect(isForeignKeyViolation(new Error('23503'))).toBe(false);
      expect(isForeignKeyViolation(undefined)).toBe(false);
    });
  });

  describe('isTransactionConflict', () => {
    it('reconhece deadlock (40P01) e falha de serialização (40001)', () => {
      expect(isTransactionConflict(pgError('40P01'))).toBe(true);
      expect(isTransactionConflict(pgError('40001'))).toBe(true);
    });

    it('ignora outros códigos e erros que não são do banco', () => {
      expect(isTransactionConflict(pgError('23505'))).toBe(false);
      expect(isTransactionConflict(new Error('40P01'))).toBe(false);
      expect(isTransactionConflict(undefined)).toBe(false);
    });
  });

  describe('mapTransactionConflict', () => {
    it('devolve o resultado quando não há erro', async () => {
      await expect(mapTransactionConflict(() => Promise.resolve(42))).resolves.toBe(42);
    });

    it('converte deadlock/serialização em 409 CONCURRENT_UPDATE', async () => {
      await expect(mapTransactionConflict(() => Promise.reject(pgError('40P01')))).rejects.toThrow(
        new ConflictException(ErrorMessages.CONCURRENT_UPDATE),
      );
    });

    it('repassa os demais erros sem alterar', async () => {
      const err = pgError('23505', 'UQ_x');
      await expect(mapTransactionConflict(() => Promise.reject(err))).rejects.toBe(err);
    });
  });
});
