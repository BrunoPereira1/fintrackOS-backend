import { InstallmentCalculatorService } from './installment-calculator.service';
import { InstallmentStatus } from './installment-status.enum';
import { CreditCard, CardBrand } from '../cards/entities/credit-card.entity';
import { BadRequestException } from '@nestjs/common';
import { ErrorMessages } from '../common/constants/error-messages';

const mockCard = (closingDay: number, dueDay: number): CreditCard =>
  ({ closingDay, dueDay, brand: CardBrand.VISA }) as CreditCard;

/** Data local (meia-noite), igual ao que o TypeORM grava numa coluna `date`. */
const d = (y: number, m: number, day: number) => new Date(y, m - 1, day);

describe('InstallmentCalculatorService', () => {
  let service: InstallmentCalculatorService;

  beforeEach(() => {
    service = new InstallmentCalculatorService();
  });

  const firstDue = (closingDay: number, dueDay: number, purchaseDate: string) =>
    service.calculate({
      totalAmount: 100,
      installmentsCount: 1,
      purchaseDate,
      card: mockCard(closingDay, dueDay),
    })[0].dueDate;

  describe('1ª data de vencimento — vencimento depois do fechamento (fecha 10, vence 17)', () => {
    it('compra antes do fechamento → fatura do mês, vence no mesmo mês', () => {
      expect(firstDue(10, 17, '2026-03-05')).toEqual(d(2026, 3, 17));
    });

    it('compra na véspera do fechamento → ainda entra na fatura do mês', () => {
      expect(firstDue(10, 17, '2026-03-09')).toEqual(d(2026, 3, 17));
    });

    it('compra no dia do fechamento (melhor dia de compra) → próxima fatura', () => {
      expect(firstDue(10, 17, '2026-03-10')).toEqual(d(2026, 4, 17));
    });

    it('compra após o fechamento → próxima fatura, vence no mês seguinte', () => {
      expect(firstDue(10, 17, '2026-03-15')).toEqual(d(2026, 4, 17));
    });

    it('avança o ano em dezembro', () => {
      expect(firstDue(10, 17, '2026-12-15')).toEqual(d(2027, 1, 17));
    });
  });

  describe('1ª data de vencimento — vencimento antes do fechamento no calendário (fecha 25, vence 5)', () => {
    it('compra antes do fechamento → fatura fecha dia 25 e vence dia 5 do mês seguinte', () => {
      expect(firstDue(25, 5, '2026-01-20')).toEqual(d(2026, 2, 5));
    });

    it('compra na véspera do fechamento → fatura que fecha dia 25', () => {
      expect(firstDue(25, 5, '2026-01-24')).toEqual(d(2026, 2, 5));
    });

    it('compra no dia do fechamento (melhor dia de compra) → próxima fatura, vence 5 de março', () => {
      expect(firstDue(25, 5, '2026-01-25')).toEqual(d(2026, 3, 5));
    });

    it('compra após o fechamento → fatura de fevereiro, vence 5 de março', () => {
      expect(firstDue(25, 5, '2026-01-26')).toEqual(d(2026, 3, 5));
    });

    it('compra após o fechamento em dezembro → vence em fevereiro do ano seguinte', () => {
      expect(firstDue(25, 5, '2026-12-28')).toEqual(d(2027, 2, 5));
    });

    it('vencimento nunca é anterior à data da compra', () => {
      for (let day = 1; day <= 28; day++) {
        const purchase = `2026-01-${String(day).padStart(2, '0')}`;
        expect(firstDue(25, 5, purchase).getTime()).toBeGreaterThan(d(2026, 1, day).getTime());
        expect(firstDue(10, 17, purchase).getTime()).toBeGreaterThan(d(2026, 1, day).getTime());
      }
    });
  });

  describe('vencimento igual ao fechamento (fecha 15, vence 15)', () => {
    it('vence no mesmo dia do mês seguinte ao fechamento', () => {
      expect(firstDue(15, 15, '2026-01-10')).toEqual(d(2026, 2, 15));
    });
  });

  describe('fuso horário', () => {
    const originalTz = process.env.TZ;
    afterEach(() => {
      process.env.TZ = originalTz;
    });

    it.each(['America/Sao_Paulo', 'America/Recife', 'UTC', 'Asia/Tokyo'])(
      'compra no dia do fechamento cai na próxima fatura em %s',
      (tz) => {
        process.env.TZ = tz;
        // fecha 10, compra 10/01 → próxima fatura (17/02), independentemente do fuso do servidor.
        // Lida via UTC, a data viraria 09/01 em UTC-3 e cairia na fatura errada.
        const due = firstDue(10, 17, '2026-01-10');
        expect([due.getFullYear(), due.getMonth() + 1, due.getDate()]).toEqual([2026, 2, 17]);
      },
    );

    it('aceita data-hora ISO e usa a data do calendário informada', () => {
      expect(firstDue(10, 17, '2026-01-10T23:30:00-03:00')).toEqual(d(2026, 2, 17));
    });

    it('rejeita data inválida com 400 genérico (sem ecoar o valor recebido)', () => {
      expect(() => firstDue(10, 17, '11/01/2026')).toThrow(
        new BadRequestException(ErrorMessages.INVALID_PURCHASE_DATE),
      );
    });
  });

  describe('cálculo dos valores', () => {
    it('distribui valor igualmente quando divisível', () => {
      const result = service.calculate({
        totalAmount: 300,
        installmentsCount: 3,
        purchaseDate: '2026-03-05',
        card: mockCard(10, 17),
      });
      expect(result.every((i) => i.amount === 100)).toBe(true);
    });

    it('absorve diferença de arredondamento na última parcela', () => {
      const result = service.calculate({
        totalAmount: 100,
        installmentsCount: 3,
        purchaseDate: '2026-03-05',
        card: mockCard(10, 17),
      });
      expect(result.map((i) => i.amount)).toEqual([33.33, 33.33, 33.34]);
    });

    it('soma das parcelas é sempre igual ao total', () => {
      for (const [total, n] of [
        [0.1, 3],
        [99.99, 7],
        [1234.56, 12],
        [10, 48],
      ]) {
        const result = service.calculate({
          totalAmount: total,
          installmentsCount: n,
          purchaseDate: '2026-03-05',
          card: mockCard(10, 17),
        });
        const sumCents = result.reduce((acc, i) => acc + Math.round(i.amount * 100), 0);
        expect(sumCents).toBe(Math.round(total * 100));
      }
    });

    it('compra à vista (1 parcela) gera uma parcela com o valor total', () => {
      const result = service.calculate({
        totalAmount: 250.9,
        installmentsCount: 1,
        purchaseDate: '2026-03-05',
        card: mockCard(10, 17),
      });
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ number: 1, totalInstallments: 1, amount: 250.9 });
    });
  });

  describe('estrutura das parcelas', () => {
    it('gera a quantidade correta de parcelas, numeradas e PENDING', () => {
      const result = service.calculate({
        totalAmount: 600,
        installmentsCount: 6,
        purchaseDate: '2026-01-05',
        card: mockCard(10, 15),
      });
      expect(result).toHaveLength(6);
      expect(result.map((i) => i.number)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(result.every((i) => i.totalInstallments === 6)).toBe(true);
      expect(result.every((i) => i.status === InstallmentStatus.PENDING)).toBe(true);
    });

    it('incrementa mês a mês, atravessando o ano', () => {
      const result = service.calculate({
        totalAmount: 300,
        installmentsCount: 3,
        purchaseDate: '2026-11-26',
        card: mockCard(25, 5),
      });
      // fecha 25/12 → vence 05/01/2027
      expect(result.map((i) => i.dueDate)).toEqual([d(2027, 1, 5), d(2027, 2, 5), d(2027, 3, 5)]);
    });
  });

  describe('data de fechamento da fatura de cada parcela (D14)', () => {
    const calc = (closingDay: number, dueDay: number, purchaseDate: string, n = 3) =>
      service.calculate({
        totalAmount: 300,
        installmentsCount: n,
        purchaseDate,
        card: mockCard(closingDay, dueDay),
      });

    it('vence depois do fechamento (fecha 10, vence 17): fecha no mês do vencimento', () => {
      expect(calc(10, 17, '2026-03-05').map((i) => [i.closingDate, i.dueDate])).toEqual([
        [d(2026, 3, 10), d(2026, 3, 17)],
        [d(2026, 4, 10), d(2026, 4, 17)],
        [d(2026, 5, 10), d(2026, 5, 17)],
      ]);
    });

    it('vence antes do fechamento no calendário (fecha 25, vence 5): fecha no mês anterior, atravessando o ano', () => {
      expect(calc(25, 5, '2026-11-26').map((i) => [i.closingDate, i.dueDate])).toEqual([
        [d(2026, 12, 25), d(2027, 1, 5)],
        [d(2027, 1, 25), d(2027, 2, 5)],
        [d(2027, 2, 25), d(2027, 3, 5)],
      ]);
    });

    it('fecha e vence no mesmo dia (15/15): fecha no mês anterior ao vencimento', () => {
      expect(calc(15, 15, '2026-01-10', 1).map((i) => [i.closingDate, i.dueDate])).toEqual([
        [d(2026, 1, 15), d(2026, 2, 15)],
      ]);
    });

    it('o fechamento é sempre posterior ou igual à compra e anterior ao vencimento', () => {
      for (let closing = 1; closing <= 28; closing++) {
        for (const due of [1, closing, 28]) {
          for (const day of [1, closing, 28]) {
            const purchase = `2026-12-${String(day).padStart(2, '0')}`;
            const [first] = calc(closing, due, purchase, 1);
            expect(first.closingDate.getTime()).toBeLessThan(first.dueDate.getTime());
            expect(first.closingDate.getTime()).toBeGreaterThanOrEqual(d(2026, 12, day).getTime());
          }
        }
      }
    });
  });
});
