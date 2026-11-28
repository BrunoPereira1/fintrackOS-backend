import { DataSource, EntityManager } from 'typeorm';
import { Clock } from '../common/clock';
import { cardBalance, invoiceDatesOf } from './invoice-ledger.calculator';
import { InvoiceLedgerQuery } from './invoice-ledger.query';

const USER_ID = 'user-uuid-1';
const CARD_A = 'card-a';
const CARD_B = 'card-b';
const TS = '2026-01-10T12:00:00.000000Z';

/** Responde cada consulta pela tabela principal do FROM. */
function fakeQuery(rows: {
  cards?: unknown[];
  installments?: unknown[];
  charges?: unknown[];
  payments?: unknown[];
  recorded?: unknown[];
}) {
  return jest.fn((sql: string) => {
    if (/FROM card_invoice_dates/.test(sql)) return Promise.resolve(rows.recorded ?? []);
    if (/FROM credit_cards/.test(sql)) return Promise.resolve(rows.cards ?? []);
    if (/FROM installments/.test(sql)) return Promise.resolve(rows.installments ?? []);
    if (/FROM invoice_charges/.test(sql)) return Promise.resolve(rows.charges ?? []);
    if (/FROM invoice_payments/.test(sql)) return Promise.resolve(rows.payments ?? []);
    return Promise.reject(new Error(`consulta inesperada: ${sql}`));
  });
}

describe('InvoiceLedgerQuery', () => {
  const clock = { today: () => '2026-03-01' } as Clock;

  const card = (id: string, creditLimit = '1000.00') => ({
    id,
    closingDay: 10,
    dueDay: 17,
    creditLimit,
  });

  it('carrega em lote por usuário e agrupa parcelas, encargos e pagamentos por cartão', async () => {
    const query = fakeQuery({
      cards: [card(CARD_A), card(CARD_B, '0.00')],
      installments: [
        {
          id: 'i1',
          transactionId: 't1',
          cardId: CARD_A,
          transactionCreatedAt: TS,
          number: 1,
          amount: '100.00',
          dueDate: '2026-02-17',
          closingDate: '2026-02-10',
        },
        {
          id: 'i2',
          transactionId: 't2',
          cardId: CARD_B,
          transactionCreatedAt: TS,
          number: 1,
          amount: '50.00',
          dueDate: '2026-02-17',
          closingDate: '2026-02-10',
        },
      ],
      charges: [
        { id: 'c1', cardId: CARD_A, invoiceMonth: '2026-02', amount: '10.00', createdAt: TS },
      ],
      payments: [
        { id: 'p1', cardId: CARD_A, invoiceMonth: '2026-02', amount: '30.00', paidOn: null },
        {
          id: 'p2',
          cardId: CARD_B,
          invoiceMonth: '2026-02',
          amount: '80.00',
          paidOn: '2026-02-15',
        },
      ],
    });
    const ds = { query } as unknown as DataSource;

    const ledgers = await new InvoiceLedgerQuery(ds, clock).loadLedgers(USER_ID);

    expect(query).toHaveBeenCalledTimes(5);
    // Toda consulta filtra pelo usuário ($1) e recebe o filtro de cartões ($2, null = todos)
    for (const [sql, params] of query.mock.calls as unknown as [string, unknown[]][]) {
      expect(sql).toMatch(/user_id = \$1/);
      expect(params).toEqual([USER_ID, null]);
    }
    expect([...ledgers.keys()]).toEqual([CARD_A, CARD_B]);
    const a = ledgers.get(CARD_A)!;
    expect(a.today).toBe('2026-03-01');
    expect(cardBalance(a)).toEqual({ outstanding: 80, credit: 0, availableLimit: 920 });
    expect(cardBalance(ledgers.get(CARD_B)!)).toEqual({
      outstanding: 0,
      credit: 30,
      availableLimit: null,
    });
  });

  it('D31: carrega as datas gravadas por fatura, por cartão, com precedência sobre os dias', async () => {
    const query = fakeQuery({
      cards: [card(CARD_A), card(CARD_B)],
      recorded: [
        {
          cardId: CARD_A,
          invoiceMonth: '2026-02',
          closingDate: '2026-01-25',
          dueDate: '2026-02-05',
        },
        {
          cardId: 'outro',
          invoiceMonth: '2026-02',
          closingDate: '2026-01-20',
          dueDate: '2026-02-01',
        },
      ],
    });
    const ledgers = await new InvoiceLedgerQuery(
      { query } as unknown as DataSource,
      clock,
    ).loadLedgers(USER_ID);

    const recordedSql = (query.mock.calls as unknown as [string, unknown[]][]).find(([sql]) =>
      /FROM card_invoice_dates/.test(sql),
    );
    expect(recordedSql?.[0]).toMatch(/user_id = \$1/);
    expect(recordedSql?.[0]).toMatch(/to_char\(d\.closing_date, 'YYYY-MM-DD'\)/);
    expect(invoiceDatesOf(ledgers.get(CARD_A)!, '2026-02')).toEqual({
      closingDate: '2026-01-25',
      dueDate: '2026-02-05',
    });
    expect(ledgers.get(CARD_B)!.recordedDates.size).toBe(0);
  });

  it('cartão sem lançamentos ganha razão vazio', async () => {
    const ds = { query: fakeQuery({ cards: [card(CARD_A)] }) } as unknown as DataSource;
    const ledger = (await new InvoiceLedgerQuery(ds, clock).loadLedgers(USER_ID)).get(CARD_A)!;
    expect(ledger.items).toEqual([]);
    expect(cardBalance(ledger)).toEqual({ outstanding: 0, credit: 0, availableLimit: 1000 });
  });

  it('usa o EntityManager informado (mesma transação) e repassa o filtro de cartões', async () => {
    const dsQuery = jest.fn();
    const emQuery = fakeQuery({ cards: [card(CARD_A)] });
    const ds = { query: dsQuery } as unknown as DataSource;
    const em = { query: emQuery } as unknown as EntityManager;

    const ledgers = await new InvoiceLedgerQuery(ds, clock).loadLedgers(USER_ID, {
      cardIds: [CARD_A],
      em,
    });

    expect(dsQuery).not.toHaveBeenCalled();
    expect(emQuery).toHaveBeenCalledTimes(5);
    for (const [, params] of emQuery.mock.calls as unknown as [string, unknown[]][]) {
      expect(params).toEqual([USER_ID, [CARD_A]]);
    }
    expect(ledgers.has(CARD_A)).toBe(true);
  });

  it('lista de cartões vazia não consulta o banco', async () => {
    const query = jest.fn();
    const ds = { query } as unknown as DataSource;
    const ledgers = await new InvoiceLedgerQuery(ds, clock).loadLedgers(USER_ID, { cardIds: [] });
    expect(ledgers.size).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  it('ignora lançamentos de cartão que não veio na consulta de cartões', async () => {
    const ds = {
      query: fakeQuery({
        cards: [card(CARD_A)],
        payments: [
          { id: 'p1', cardId: 'outro', invoiceMonth: '2026-02', amount: '30.00', paidOn: null },
        ],
      }),
    } as unknown as DataSource;
    const ledgers = await new InvoiceLedgerQuery(ds, clock).loadLedgers(USER_ID);
    expect(ledgers.get(CARD_A)!.paidCents).toBe(0);
    expect(ledgers.size).toBe(1);
  });

  it('loadLedger devolve o razão de um cartão (ou undefined)', async () => {
    const ds = { query: fakeQuery({ cards: [card(CARD_A)] }) } as unknown as DataSource;
    const q = new InvoiceLedgerQuery(ds, clock);
    expect((await q.loadLedger(USER_ID, CARD_A))?.card.creditLimitCents).toBe(100000);
    const empty = { query: fakeQuery({}) } as unknown as DataSource;
    expect(await new InvoiceLedgerQuery(empty, clock).loadLedger(USER_ID, CARD_A)).toBeUndefined();
  });

  it('usa o "hoje" do chamador quando informado (um único hoje por requisição)', async () => {
    const today = jest.fn(() => '2026-03-01');
    const ds = { query: fakeQuery({ cards: [card(CARD_A)] }) } as unknown as DataSource;
    const q = new InvoiceLedgerQuery(ds, { today } as unknown as Clock);

    const ledgers = await q.loadLedgers(USER_ID, { today: '2026-04-20' });
    expect(ledgers.get(CARD_A)!.today).toBe('2026-04-20');
    expect((await q.loadLedger(USER_ID, CARD_A, undefined, '2026-05-02'))!.today).toBe(
      '2026-05-02',
    );
    expect(today).not.toHaveBeenCalled();

    expect((await q.loadLedger(USER_ID, CARD_A))!.today).toBe('2026-03-01');
    expect(today).toHaveBeenCalledTimes(1);
  });
});
