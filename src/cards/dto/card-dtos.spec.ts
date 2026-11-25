import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { randomUUID } from 'crypto';
import { CardInvoiceEntryParamsDto, CardInvoiceParamsDto } from './card-invoice-params.dto';
import { QueryCardsDto } from './query-cards.dto';
import { CreateInvoicePaymentDto } from '../../invoices/dto/create-invoice-payment.dto';
import { CreateInvoiceChargeDto } from '../../invoices/dto/create-invoice-charge.dto';
import { MAX_MONEY } from '../../common/money-limits';

const errorsOf = async (cls: new () => object, plain: object) =>
  (await validate(plainToInstance(cls, plain))).map((e) => e.property);

describe('DTOs de cartão e fatura', () => {
  describe('parâmetros de /cards/:cardId/invoices/:month', () => {
    const cardId = randomUUID();

    it.each(['2026-01', '2026-12'])('aceita mês %s', async (month) => {
      expect(await errorsOf(CardInvoiceParamsDto, { cardId, month })).toEqual([]);
    });

    it.each(['2026-13', '2026-1', '2026-03-01', 'x'])('rejeita mês %s', async (month) => {
      expect(await errorsOf(CardInvoiceParamsDto, { cardId, month })).toEqual(['month']);
    });

    it('exige UUID em cardId e id', async () => {
      expect(
        await errorsOf(CardInvoiceEntryParamsDto, { cardId: 'a', month: '2026-03', id: 'b' }),
      ).toEqual(expect.arrayContaining(['cardId', 'id']));
    });
  });

  describe('CreateInvoicePaymentDto', () => {
    it('aceita valor com 2 casas e paidOn YYYY-MM-DD (ou omitido)', async () => {
      expect(await errorsOf(CreateInvoicePaymentDto, { amount: 0.01 })).toEqual([]);
      expect(
        await errorsOf(CreateInvoicePaymentDto, { amount: MAX_MONEY, paidOn: '2026-03-15' }),
      ).toEqual([]);
    });

    it.each([0, -1, 1.001, MAX_MONEY + 1, '10'])('rejeita amount %p', async (amount) => {
      expect(await errorsOf(CreateInvoicePaymentDto, { amount })).toEqual(['amount']);
    });

    it.each(['2026-02-30', '2026-03-15T10:00:00Z', '15/03/2026'])(
      'rejeita paidOn %s',
      async (paidOn) => {
        expect(await errorsOf(CreateInvoicePaymentDto, { amount: 1, paidOn })).toEqual(['paidOn']);
      },
    );
  });

  describe('CreateInvoiceChargeDto', () => {
    it('description ≤ 255', async () => {
      expect(
        await errorsOf(CreateInvoiceChargeDto, { amount: 1, description: 'a'.repeat(255) }),
      ).toEqual([]);
      expect(
        await errorsOf(CreateInvoiceChargeDto, { amount: 1, description: 'a'.repeat(256) }),
      ).toEqual(['description']);
    });
  });

  describe('QueryCardsDto', () => {
    it.each([
      ['true', true],
      ['false', false],
    ])('includeArchived=%s → %p', async (raw, expected) => {
      const dto = plainToInstance(QueryCardsDto, { includeArchived: raw });
      expect(dto.includeArchived).toBe(expected);
      expect(await validate(dto)).toEqual([]);
    });

    it('rejeita valor que não é true/false', async () => {
      expect(await errorsOf(QueryCardsDto, { includeArchived: 'sim' })).toEqual([
        'includeArchived',
      ]);
    });
  });
});
