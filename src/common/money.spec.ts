import { splitCents, sumCents, toCents } from './money';

describe('money', () => {
  it('converte número e string decimal do Postgres para centavos', () => {
    expect(toCents(200)).toBe(20000);
    expect(toCents('200.00')).toBe(20000);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents('33.34')).toBe(3334);
  });

  it('soma em centavos, tratando lista vazia/ausente como zero', () => {
    expect(sumCents([{ v: '0.10' }, { v: 0.2 }], (x) => toCents(x.v))).toBe(30);
    expect(sumCents(undefined, () => 1)).toBe(0);
  });

  describe('splitCents', () => {
    it('divide com floor e põe o resto na última parte (Σ partes == total)', () => {
      expect(splitCents(10000, 3)).toEqual([3333, 3333, 3334]);
      expect(splitCents(10001, 1)).toEqual([10001]);
      expect(splitCents(1, 3)).toEqual([0, 0, 1]);
      expect(splitCents(60000, 3)).toEqual([20000, 20000, 20000]);
    });

    it.each([0, -1, 1.5])('quantidade de partes inválida (%s) → erro', (parts) => {
      expect(() => splitCents(100, parts)).toThrow(RangeError);
    });

    it('total não inteiro (não está em centavos) → erro', () => {
      expect(() => splitCents(10.5, 2)).toThrow(RangeError);
    });
  });
});
