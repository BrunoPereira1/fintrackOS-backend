import { Test } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import { buildCardLedger, CardLedgerInput } from './invoice-ledger.calculator';
import { InvoiceLedgerQuery, RECORDED_DATES_SQL } from './invoice-ledger.query';
import { CardInvoiceDatesService } from './card-invoice-dates.service';
import { invoiceDates } from '../common/invoice-dates';

const USER_ID = 'user-uuid-1';
const CARD_ID = 'card-uuid-1';
const TODAY = '2026-11-27';
const OLD_DAYS = { closingDay: 25, dueDay: 5 };
/** Dias novos do cartão na mudança (D14): fecha 28, vence 10. */
const NEW_DAYS = { closingDay: 28, dueDay: 10 };

/** Razão pelos dias atuais (antigos) do cartão: fecha 25, vence 5. */
const ledger = (over: Partial<CardLedgerInput> = {}) =>
  buildCardLedger({
    card: { ...OLD_DAYS, creditLimit: '1000.00' },
    installments: [],
    charges: [],
    payments: [],
    today: TODAY,
    ...over,
  });

const installment = (id: string, month: string) => ({
  id,
  transactionId: `tx-${id}`,
  transactionCreatedAt: '2026-01-01T10:00:00.000000Z',
  number: 1,
  amount: '10.00',
  ...invoiceDates(month, OLD_DAYS),
});

describe('CardInvoiceDatesService', () => {
  let service: CardInvoiceDatesService;
  let ledgers: { loadLedger: jest.Mock };
  let query: jest.Mock;
  let em: EntityManager;

  beforeEach(async () => {
    ledgers = { loadLedger: jest.fn() };
    query = jest.fn().mockResolvedValue([]);
    em = { query } as unknown as EntityManager;
    const moduleRef = await Test.createTestingModule({
      providers: [CardInvoiceDatesService, { provide: InvoiceLedgerQuery, useValue: ledgers }],
    }).compile();
    service = moduleRef.get(CardInvoiceDatesService);
  });

  describe('recordClosedInvoices (D31)', () => {
    it('lê o razão com o em e o "hoje" do chamador e grava os meses fechados, sem sobrescrever', async () => {
      ledgers.loadLedger.mockResolvedValue(
        ledger({
          installments: [installment('nov', '2026-11'), installment('jan', '2027-01')],
          payments: [{ id: 'p', invoiceMonth: '2026-10', amount: '5.00', paidOn: '2026-10-05' }],
        }),
      );

      const recorded = await service.recordClosedInvoices(em, CARD_ID, USER_ID, NEW_DAYS, TODAY);

      expect(ledgers.loadLedger).toHaveBeenCalledWith(USER_ID, CARD_ID, em, TODAY);
      expect(recorded).toBe(3);
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/INSERT INTO card_invoice_dates/);
      expect(sql).toMatch(/ON CONFLICT \(card_id, invoice_month\) DO NOTHING/);
      // 2026-10 (pagamento), 2026-11 (parcela) e 2026-12 (fechada mais recente, vazia);
      // 2027-01 ainda aberta (fecha 25/12) não entra
      expect(params).toEqual([
        USER_ID,
        CARD_ID,
        ['2026-10', '2026-11', '2026-12'],
        ['2026-09-25', '2026-10-25', '2026-11-25'],
        ['2026-10-05', '2026-11-05', '2026-12-05'],
      ]);
    });

    it('grava também o mês vazio fechado que reabriria pelos dias novos (D31 🔜)', async () => {
      // hoje 26/11: 2026-11 (fechou 25/10) vazia; 2026-12 (fechou 25/11) com compra.
      // Dias novos "fecha 27, vence 28": 2026-11 fecharia em 27/11 (> hoje) — reabriria.
      ledgers.loadLedger.mockResolvedValue(
        ledger({ today: '2026-11-26', installments: [installment('dec', '2026-12')] }),
      );

      const recorded = await service.recordClosedInvoices(
        em,
        CARD_ID,
        USER_ID,
        { closingDay: 27, dueDay: 28 },
        '2026-11-26',
      );

      expect(recorded).toBe(2);
      const [, params] = query.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual([
        USER_ID,
        CARD_ID,
        ['2026-11', '2026-12'],
        ['2026-10-25', '2026-11-25'],
        ['2026-11-05', '2026-12-05'],
      ]);
    });

    it('nada a gravar (tudo já gravado) → não escreve', async () => {
      ledgers.loadLedger.mockResolvedValue(
        ledger({
          recordedDates: [
            { invoiceMonth: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
          ],
        }),
      );
      expect(await service.recordClosedInvoices(em, CARD_ID, USER_ID, NEW_DAYS, TODAY)).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });

    it('cartão fora do razão (não deveria acontecer sob a trava) → não escreve', async () => {
      ledgers.loadLedger.mockResolvedValue(undefined);
      expect(await service.recordClosedInvoices(em, CARD_ID, USER_ID, NEW_DAYS, TODAY)).toBe(0);
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('findRecorded (D32)', () => {
    it('devolve o mapa mês → datas do cartão, filtrando por cartão e usuário no em informado', async () => {
      query.mockResolvedValue([
        {
          cardId: CARD_ID,
          invoiceMonth: '2026-12',
          closingDate: '2026-11-25',
          dueDate: '2026-12-05',
        },
      ]);
      const map = await service.findRecorded(em, CARD_ID, USER_ID);
      const [sql, params] = query.mock.calls[0] as [string, unknown[]];
      // a mesma consulta do razão (InvoiceLedgerQuery), sem SQL duplicado
      expect(sql).toBe(RECORDED_DATES_SQL);
      expect(params).toEqual([USER_ID, [CARD_ID]]);
      expect(Object.fromEntries(map)).toEqual({
        '2026-12': { closingDate: '2026-11-25', dueDate: '2026-12-05' },
      });
    });
  });
});
