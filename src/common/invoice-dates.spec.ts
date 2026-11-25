import { addMonths, invoiceDates } from './invoice-dates';

describe('invoice-dates', () => {
  describe('invoiceDates (dias atuais do cartão, fatura = mês do vencimento)', () => {
    it('dueDay < closingDay: fecha no mês anterior', () => {
      expect(invoiceDates('2026-03', { closingDay: 25, dueDay: 5 })).toEqual({
        closingDate: '2026-02-25',
        dueDate: '2026-03-05',
      });
    });

    it('dueDay > closingDay: fecha no mesmo mês', () => {
      expect(invoiceDates('2026-03', { closingDay: 10, dueDay: 17 })).toEqual({
        closingDate: '2026-03-10',
        dueDate: '2026-03-17',
      });
    });

    it('dueDay == closingDay: fecha no mês anterior', () => {
      expect(invoiceDates('2026-03', { closingDay: 15, dueDay: 15 })).toEqual({
        closingDate: '2026-02-15',
        dueDate: '2026-03-15',
      });
    });

    it('virada de ano: fatura de janeiro fecha em dezembro do ano anterior', () => {
      expect(invoiceDates('2027-01', { closingDay: 25, dueDay: 5 })).toEqual({
        closingDate: '2026-12-25',
        dueDate: '2027-01-05',
      });
    });
  });

  describe('addMonths', () => {
    it.each([
      ['2026-03', -1, '2026-02'],
      ['2026-01', -1, '2025-12'],
      ['2026-12', 1, '2027-01'],
      ['2026-05', 0, '2026-05'],
      ['2026-11', 14, '2028-01'],
    ])('%s %+d → %s', (month, delta, expected) => {
      expect(addMonths(month, delta)).toBe(expected);
    });
  });
});
