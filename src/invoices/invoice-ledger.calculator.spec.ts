import {
  acceptsInvoiceEntries,
  buildCardLedger,
  buildInvoiceView,
  cardBalance,
  CardLedger,
  CardLedgerInput,
  closedInvoiceDatesToRecord,
  currentOpenInvoiceMonth,
  hasCoveredInstallmentInClosedInvoice,
  invoiceDatesOf,
  installmentStates,
  installmentsFallInClosedInvoice,
  LedgerCardInput,
  LedgerChargeInput,
  LedgerInstallmentInput,
  LedgerPaymentInput,
} from './invoice-ledger.calculator';
import { addMonths, invoiceDates } from '../common/invoice-dates';

/** Cartão padrão: fecha 25, vence 5 (fatura 2026-03 fecha 2026-02-25 e vence 2026-03-05). */
const CARD: LedgerCardInput = { closingDay: 25, dueDay: 5, creditLimit: '1000.00' };

/** Parcela na fatura `month`, com as datas do cartão informado (como gravado após D14). */
function inst(
  id: string,
  month: string,
  amount: string,
  over: Partial<LedgerInstallmentInput> = {},
  card: LedgerCardInput = CARD,
): LedgerInstallmentInput {
  return {
    id,
    transactionId: `tx-${id}`,
    transactionCreatedAt: '2026-01-01T10:00:00.000000Z',
    number: 1,
    amount,
    ...invoiceDates(month, card),
    ...over,
  };
}

function charge(
  id: string,
  invoiceMonth: string,
  amount: string,
  createdAt = '2026-01-01T10:00:00.000000Z',
): LedgerChargeInput {
  return { id, invoiceMonth, amount, createdAt };
}

function pay(
  id: string,
  invoiceMonth: string,
  amount: string | number,
  paidOn: string | null = '2026-01-01',
): LedgerPaymentInput {
  return { id, invoiceMonth, amount, paidOn };
}

function ledger(input: Partial<CardLedgerInput> & { today: string }): CardLedger {
  return buildCardLedger({ card: CARD, installments: [], charges: [], payments: [], ...input });
}

describe('invoice-ledger.calculator', () => {
  describe('validação de formato da entrada (D25)', () => {
    const base = (): CardLedgerInput => ({
      card: CARD,
      today: '2026-03-10',
      installments: [inst('a', '2026-03', '1.00')],
      charges: [charge('c', '2026-03', '1.00')],
      payments: [pay('p', '2026-03', '1.00')],
    });

    it.each([
      ['sem fração', '2026-01-01T10:00:00Z'],
      ['fração de 3 dígitos', '2026-01-01T10:00:00.500Z'],
      ['offset em vez de Z', '2026-01-01T10:00:00.000000-03:00'],
      ['formato texto do Postgres', '2026-01-01 10:00:00.123456+00'],
    ])('transactionCreatedAt %s (%s) lança', (_label, value) => {
      const input = base();
      input.installments = [inst('a', '2026-03', '1.00', { transactionCreatedAt: value })];
      expect(() => buildCardLedger(input)).toThrow(
        new RegExp(`transactionCreatedAt.*${value.replace(/[.+]/g, '\\$&')}`),
      );
    });

    it('createdAt do encargo fora do formato lança', () => {
      const input = base();
      input.charges = [charge('c', '2026-03', '1.00', '2026-01-01T10:00:00.500Z')];
      expect(() => buildCardLedger(input)).toThrow(/createdAt/);
    });

    it('Date em vez de string lança', () => {
      const input = base();
      input.installments = [
        inst('a', '2026-03', '1.00', {
          transactionCreatedAt: new Date(0) as unknown as string,
        }),
      ];
      expect(() => buildCardLedger(input)).toThrow(/transactionCreatedAt/);
      const withDate = base();
      withDate.installments = [
        inst('a', '2026-03', '1.00', { dueDate: new Date(0) as unknown as string }),
      ];
      expect(() => buildCardLedger(withDate)).toThrow(/dueDate/);
    });

    it.each([
      ['dueDate', { dueDate: '2026-3-05' }],
      ['closingDate', { closingDate: '2026-02-25T00:00:00.000000Z' }],
    ])('%s fora de YYYY-MM-DD lança', (field, over) => {
      const input = base();
      input.installments = [inst('a', '2026-03', '1.00', over)];
      expect(() => buildCardLedger(input)).toThrow(new RegExp(field));
    });

    it('paidOn, invoiceMonth e today fora do formato lançam; paidOn null é aceito', () => {
      expect(() =>
        buildCardLedger({ ...base(), payments: [pay('p', '2026-03', '1.00', '01/03/2026')] }),
      ).toThrow(/paidOn/);
      expect(() => buildCardLedger({ ...base(), payments: [pay('p', '2026-3', '1.00')] })).toThrow(
        /invoiceMonth/,
      );
      expect(() =>
        buildCardLedger({ ...base(), charges: [charge('c', '2026-03-01', '1.00')] }),
      ).toThrow(/invoiceMonth/);
      expect(() => buildCardLedger({ ...base(), today: '2026-03-10T00:00:00Z' })).toThrow(/today/);
      expect(() =>
        buildCardLedger({ ...base(), payments: [pay('p', '2026-03', '1.00', null)] }),
      ).not.toThrow();
    });

    it('mês inválido na visão da fatura e na D9 lança', () => {
      const l = buildCardLedger(base());
      expect(() => buildInvoiceView(l, '2026-13')).toThrow(/month/);
      expect(() => acceptsInvoiceEntries(l, '2026-3')).toThrow(/month/);
    });

    it('microssegundos ordenam corretamente (.000001 antes de .000002)', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [
          inst('second', '2026-03', '1.00', {
            transactionId: 'tx-a',
            transactionCreatedAt: '2026-01-01T10:00:00.000002Z',
          }),
          inst('first', '2026-03', '1.00', {
            transactionId: 'tx-z',
            transactionCreatedAt: '2026-01-01T10:00:00.000001Z',
          }),
        ],
        charges: [
          charge('ch-second', '2026-03', '1.00', '2026-01-01T10:00:00.000002Z'),
          charge('ch-first', '2026-03', '1.00', '2026-01-01T10:00:00.000001Z'),
        ],
      });
      expect(l.items.map((i) => i.id)).toEqual(['first', 'second', 'ch-first', 'ch-second']);
    });
  });

  describe('alocação FIFO (D5)', () => {
    it('encargo em mês sem parcelas entre meses com parcelas e após todas as parcelas', () => {
      const l = ledger({
        today: '2026-01-10',
        installments: [inst('apr', '2026-04', '1.00'), inst('feb', '2026-02', '1.00')],
        charges: [charge('ch-jun', '2026-06', '1.00'), charge('ch-mar', '2026-03', '1.00')],
      });
      expect(l.items.map((i) => i.id)).toEqual(['feb', 'ch-mar', 'apr', 'ch-jun']);
    });

    it('ordena por mês; no mês, parcelas por createdAt, transactionId e número; encargos por último', () => {
      const l = ledger({
        today: '2026-01-10',
        installments: [
          inst('apr', '2026-04', '1.00', { transactionCreatedAt: '2026-01-01T00:00:00.000000Z' }),
          inst('mar-late', '2026-03', '1.00', {
            transactionId: 'tx-a',
            transactionCreatedAt: '2026-02-01T00:00:00.000000Z',
          }),
          inst('mar-b2', '2026-03', '1.00', {
            transactionId: 'tx-b',
            number: 2,
            transactionCreatedAt: '2026-01-15T00:00:00.000000Z',
          }),
          inst('mar-b1', '2026-03', '1.00', {
            transactionId: 'tx-b',
            number: 1,
            transactionCreatedAt: '2026-01-15T00:00:00.000000Z',
          }),
          inst('mar-a', '2026-03', '1.00', {
            transactionId: 'tx-a',
            transactionCreatedAt: '2026-01-15T00:00:00.000000Z',
          }),
        ],
        charges: [
          charge('ch-z', '2026-03', '1.00', '2026-01-02T00:00:00.000000Z'),
          charge('ch-a', '2026-03', '1.00', '2026-01-02T00:00:00.000000Z'),
          charge('ch-first', '2026-03', '1.00', '2026-01-01T00:00:00.000000Z'),
          charge('ch-feb', '2026-02', '1.00', '2026-03-01T00:00:00.000000Z'),
        ],
      });

      expect(l.items.map((i) => i.id)).toEqual([
        'ch-feb',
        'mar-a',
        'mar-b1',
        'mar-b2',
        'mar-late',
        'ch-first',
        'ch-a',
        'ch-z',
        'apr',
      ]);
    });

    it('cobre em ordem com o total de todos os pagamentos, independentemente do mês lançado', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '100.00'), inst('b', '2026-04', '50.00')],
        payments: [pay('p1', '2026-04', '30.00'), pay('p2', '2026-03', '90.00')],
      });

      expect(l.paidCents).toBe(12000);
      expect(l.items.map((i) => [i.id, i.coveredCents, i.remainingCents])).toEqual([
        ['a', 10000, 0],
        ['b', 2000, 3000],
      ]);
      expect(l.outstandingCents).toBe(3000);
      expect(l.creditCents).toBe(0);
    });

    it('o resultado não depende da ordem dos arrays de entrada', () => {
      const installments = [
        inst('a', '2026-03', '10.00'),
        inst('b', '2026-03', '20.00', { transactionCreatedAt: '2026-01-02T00:00:00.000000Z' }),
        inst('c', '2026-04', '30.00'),
      ];
      const charges = [charge('x', '2026-03', '5.00'), charge('y', '2026-04', '5.00')];
      const payments = [pay('p', '2026-03', '33.00')];
      const one = ledger({ today: '2026-03-10', installments, charges, payments });
      const two = ledger({
        today: '2026-03-10',
        installments: [...installments].reverse(),
        charges: [...charges].reverse(),
        payments,
      });
      expect(two.items).toEqual(one.items);
    });
  });

  describe('cenários do razão (§7)', () => {
    it('pagamento integral quita a fatura e não gera saldo anterior', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '100.00'), inst('b', '2026-04', '50.00')],
        payments: [pay('p', '2026-03', '100.00', '2026-03-01')],
      });

      const mar = buildInvoiceView(l, '2026-03');
      expect(mar).toMatchObject({
        status: 'paid',
        installmentsTotal: 100,
        coveredAmount: 100,
        remaining: 0,
        previousBalance: 0,
        amountDue: 0,
      });
      const apr = buildInvoiceView(l, '2026-04');
      expect(apr).toMatchObject({
        status: 'open',
        previousBalance: 0,
        remaining: 50,
        amountDue: 50,
      });
      expect(cardBalance(l)).toEqual({ outstanding: 50, credit: 0, availableLimit: 950 });
    });

    describe('pagamento parcial: o saldo rola e só aparece após o vencimento da anterior (D10)', () => {
      const input = {
        installments: [inst('a', '2026-03', '100.00'), inst('b', '2026-04', '50.00')],
        payments: [pay('p', '2026-03', '40.00', '2026-03-01')],
      };

      it.each([
        ['véspera do vencimento', '2026-03-04', 0, 'closed'],
        ['dia do vencimento', '2026-03-05', 0, 'closed'],
        ['dia seguinte ao vencimento', '2026-03-06', 60, 'partially_paid'],
      ])('%s (%s): previousBalance de abril = %d', (_label, today, previous, marStatus) => {
        const l = ledger({ today, ...input });
        const apr = buildInvoiceView(l, '2026-04');
        expect(apr.previousBalance).toBe(previous);
        expect(apr.amountDue).toBe(previous + 50);
        expect(apr.status).toBe('open');
        const mar = buildInvoiceView(l, '2026-03');
        expect(mar).toMatchObject({ status: marStatus, coveredAmount: 40, remaining: 60 });
      });
    });

    it('pagamento a maior vira crédito; limite disponível não passa do limite', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '100.00')],
        payments: [pay('p', '2026-03', '150.00')],
      });
      expect(buildInvoiceView(l, '2026-03').status).toBe('paid');
      expect(cardBalance(l)).toEqual({ outstanding: 0, credit: 50, availableLimit: 1000 });
    });

    it('encargo lançado em fatura quitada fica descoberto sem despagar as parcelas', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '100.00')],
        charges: [charge('j', '2026-03', '10.00', '2026-03-09T12:00:00.000000Z')],
        payments: [pay('p', '2026-03', '100.00')],
      });
      expect(installmentStates(l).get('a')).toEqual({
        status: 'paid',
        coveredAmount: 100,
        remainingAmount: 0,
      });
      const mar = buildInvoiceView(l, '2026-03');
      expect(mar).toMatchObject({
        status: 'partially_paid',
        chargesTotal: 10,
        remaining: 10,
        coveredAmount: 100,
      });
      expect(mar.charges).toEqual([
        expect.objectContaining({ id: 'j', coveredAmount: 0, remainingAmount: 10 }),
      ]);
    });

    it.each([
      ['compra nova', 'tx-new'],
      ['compra retroativa (lançada agora, data de compra antiga)', 'tx-0-retro'],
    ])('%s em fatura já paga: só ela fica descoberta no mês', (_label, transactionId) => {
      const l = ledger({
        today: '2026-03-01',
        installments: [
          inst('old', '2026-03', '100.00', { transactionCreatedAt: '2026-02-01T00:00:00.000000Z' }),
          inst('new', '2026-03', '30.00', {
            transactionId,
            transactionCreatedAt: '2026-02-28T00:00:00.000000Z',
          }),
        ],
        payments: [pay('p', '2026-03', '100.00')],
      });
      const states = installmentStates(l);
      expect(states.get('old')?.status).toBe('paid');
      expect(states.get('new')).toEqual({
        status: 'pending',
        coveredAmount: 0,
        remainingAmount: 30,
      });
      expect(buildInvoiceView(l, '2026-03')).toMatchObject({ status: 'closed', remaining: 30 });
    });

    it('compra nova com crédito existente nasce coberta', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '100.00'), inst('b', '2026-04', '30.00')],
        payments: [pay('p', '2026-03', '150.00')],
      });
      expect(installmentStates(l).get('b')).toEqual({
        status: 'paid',
        coveredAmount: 30,
        remainingAmount: 0,
      });
      expect(buildInvoiceView(l, '2026-04').status).toBe('paid');
      expect(cardBalance(l).credit).toBe(20);
    });

    it('pagamento lançado em fatura posterior quita a anterior em aberto (FIFO global)', () => {
      const l = ledger({
        today: '2026-04-10',
        installments: [inst('a', '2026-03', '100.00'), inst('b', '2026-04', '50.00')],
        payments: [pay('p', '2026-04', '100.00', '2026-04-01')],
      });
      const mar = buildInvoiceView(l, '2026-03');
      expect(mar).toMatchObject({ status: 'paid', remaining: 0, payments: [] });
      const apr = buildInvoiceView(l, '2026-04');
      expect(apr).toMatchObject({ status: 'unpaid', remaining: 50, previousBalance: 0 });
      expect(apr.payments).toEqual([
        { id: 'p', amount: 100, paidOn: '2026-04-01', paidLate: false },
      ]);
    });

    it('excluir compra coberta realoca o pagamento para a próxima dívida', () => {
      const installments = [inst('a', '2026-03', '100.00'), inst('b', '2026-04', '80.00')];
      const payments = [pay('p', '2026-03', '150.00')];
      const before = ledger({ today: '2026-03-10', installments, payments });
      expect(installmentStates(before).get('b')).toMatchObject({ coveredAmount: 50 });

      const after = ledger({ today: '2026-03-10', installments: [installments[1]], payments });
      expect(installmentStates(after).get('b')).toMatchObject({
        status: 'paid',
        coveredAmount: 80,
      });
      expect(cardBalance(after)).toMatchObject({ outstanding: 0, credit: 70 });
    });

    it('sem dívida após a exclusão, o valor vira crédito', () => {
      const l = ledger({ today: '2026-03-10', payments: [pay('p', '2026-03', '100.00')] });
      expect(cardBalance(l)).toEqual({ outstanding: 0, credit: 100, availableLimit: 1000 });
    });

    it.each([
      ['antes do vencimento', '2026-03-05', 'pending'],
      ['depois do vencimento', '2026-03-06', 'overdue'],
    ])('parcela parcialmente coberta expõe coberto/restante (%s → %s)', (_label, today, status) => {
      const l = ledger({
        today,
        installments: [inst('a', '2026-03', '100.00')],
        payments: [pay('p', '2026-03', '30.00')],
      });
      expect(installmentStates(l).get('a')).toEqual({
        status,
        coveredAmount: 30,
        remainingAmount: 70,
      });
      const view = buildInvoiceView(l, '2026-03');
      expect(view.installments[0]).toMatchObject({
        status,
        coveredAmount: 30,
        remainingAmount: 70,
      });
      expect(view).toMatchObject({ coveredAmount: 30, remaining: 70 });
    });

    it('meses vazios no meio da cadeia seguem as datas e nunca ficam paid (D17)', () => {
      const l = ledger({
        today: '2026-05-10',
        installments: [inst('a', '2026-03', '100.00'), inst('c', '2026-07', '100.00')],
        payments: [pay('p', '2026-03', '100.00')],
      });
      const apr = buildInvoiceView(l, '2026-04');
      expect(apr).toMatchObject({
        closingDate: '2026-03-25',
        dueDate: '2026-04-05',
        status: 'closed',
        installmentsTotal: 0,
        chargesTotal: 0,
        previousBalance: 0,
        amountDue: 0,
        installments: [],
        charges: [],
      });
      expect(buildInvoiceView(l, '2026-05').status).toBe('closed');
      expect(buildInvoiceView(l, '2026-06').status).toBe('open');
      expect(buildInvoiceView(l, '2026-07')).toMatchObject({ status: 'open', previousBalance: 0 });
    });

    it('mês vazio após o vencimento com saldo anterior fica unpaid', () => {
      const l = ledger({ today: '2026-04-10', installments: [inst('a', '2026-03', '100.00')] });
      expect(buildInvoiceView(l, '2026-04')).toMatchObject({
        status: 'unpaid',
        previousBalance: 100,
        remaining: 0,
        amountDue: 100,
      });
    });

    it('mês vazio com saldo anterior antes do próprio vencimento segue as datas', () => {
      const l = ledger({ today: '2026-03-30', installments: [inst('a', '2026-03', '100.00')] });
      expect(buildInvoiceView(l, '2026-04')).toMatchObject({
        status: 'closed',
        previousBalance: 100,
      });
    });

    describe('fatura só com encargo (datas pelos dias do cartão)', () => {
      const charges = [charge('j', '2026-04', '15.00')];

      it('aberta antes do fechamento', () => {
        const view = buildInvoiceView(ledger({ today: '2026-03-10', charges }), '2026-04');
        expect(view).toMatchObject({
          closingDate: '2026-03-25',
          dueDate: '2026-04-05',
          status: 'open',
          installmentsTotal: 0,
          chargesTotal: 15,
          remaining: 15,
        });
      });

      it('paga quando o encargo está coberto', () => {
        const l = ledger({
          today: '2026-03-10',
          charges,
          payments: [pay('p', '2026-04', '15.00')],
        });
        expect(buildInvoiceView(l, '2026-04').status).toBe('paid');
      });

      it('unpaid após o vencimento sem pagamento', () => {
        const view = buildInvoiceView(ledger({ today: '2026-04-06', charges }), '2026-04');
        expect(view.status).toBe('unpaid');
        expect(view.charges[0]).toMatchObject({ status: 'overdue', remainingAmount: 15 });
      });
    });

    describe('status em cada fronteira', () => {
      it.each([
        // [card, closingDate, dueDate, [today, status][]]
        [
          'dueDay < closingDay (25/5)',
          { closingDay: 25, dueDay: 5 },
          [
            ['2026-02-24', 'open'],
            ['2026-02-25', 'closed'],
            ['2026-03-05', 'closed'],
            ['2026-03-06', 'unpaid'],
          ],
        ],
        [
          'dueDay > closingDay (10/17)',
          { closingDay: 10, dueDay: 17 },
          [
            ['2026-03-09', 'open'],
            ['2026-03-10', 'closed'],
            ['2026-03-17', 'closed'],
            ['2026-03-18', 'unpaid'],
          ],
        ],
        [
          'dueDay == closingDay (15/15)',
          { closingDay: 15, dueDay: 15 },
          [
            ['2026-02-14', 'open'],
            ['2026-02-15', 'closed'],
            ['2026-03-15', 'closed'],
            ['2026-03-16', 'unpaid'],
          ],
        ],
      ] as const)('%s', (_label, days, cases) => {
        const card = { ...days, creditLimit: 0 };
        for (const [today, status] of cases) {
          const l = buildCardLedger({
            card,
            today,
            installments: [inst('a', '2026-03', '100.00', {}, card)],
            charges: [],
            payments: [],
          });
          expect({ today, status: buildInvoiceView(l, '2026-03').status }).toEqual({
            today,
            status,
          });
        }
      });

      it('parcela não coberta vence no dia seguinte ao vencimento (pending no dia)', () => {
        const at = (today: string) =>
          installmentStates(ledger({ today, installments: [inst('a', '2026-03', '1.00')] })).get(
            'a',
          )?.status;
        expect(at('2026-03-05')).toBe('pending');
        expect(at('2026-03-06')).toBe('overdue');
      });
    });

    it('virada de ano: dezembro vem antes de janeiro e o saldo rola', () => {
      const l = ledger({
        today: '2027-01-10',
        installments: [
          inst('jan', '2027-01', '50.00', { transactionCreatedAt: '2026-11-01T00:00:00.000000Z' }),
          inst('dec', '2026-12', '100.00', { transactionCreatedAt: '2026-12-20T00:00:00.000000Z' }),
        ],
        payments: [pay('p', '2026-12', '60.00')],
      });
      expect(l.items.map((i) => i.id)).toEqual(['dec', 'jan']);
      expect(buildInvoiceView(l, '2027-01')).toMatchObject({
        closingDate: '2026-12-25',
        dueDate: '2027-01-05',
        previousBalance: 40,
        remaining: 50,
        amountDue: 90,
        status: 'unpaid',
      });
    });

    describe('partially_paid × unpaid', () => {
      const installments = [inst('a', '2026-03', '100.00'), inst('b', '2026-04', '100.00')];

      it('crédito vindo de antes cobrindo parte do mês → partially_paid', () => {
        const l = ledger({
          today: '2026-04-10',
          installments,
          payments: [pay('p', '2026-03', '150.00')],
        });
        expect(buildInvoiceView(l, '2026-04')).toMatchObject({
          status: 'partially_paid',
          coveredAmount: 50,
          remaining: 50,
          payments: [],
        });
      });

      it('nenhum item do mês coberto → unpaid', () => {
        const l = ledger({
          today: '2026-04-10',
          installments,
          payments: [pay('p', '2026-03', '100.00')],
        });
        expect(buildInvoiceView(l, '2026-04')).toMatchObject({
          status: 'unpaid',
          coveredAmount: 0,
        });
      });

      it('saldo anterior pendente: o mês não tem item coberto → unpaid', () => {
        const l = ledger({ today: '2026-04-10', installments });
        expect(buildInvoiceView(l, '2026-04')).toMatchObject({
          status: 'unpaid',
          previousBalance: 100,
          amountDue: 200,
        });
      });
    });

    describe('centavos (100,00 em 3x = 33,33 / 33,33 / 33,34)', () => {
      const installments = [
        inst('i1', '2026-03', '33.33', { transactionId: 'tx', number: 1 }),
        inst('i2', '2026-04', '33.33', { transactionId: 'tx', number: 2 }),
        inst('i3', '2026-05', '33.34', { transactionId: 'tx', number: 3 }),
      ];

      it('pagamento de 66,66 cobre exatamente as duas primeiras', () => {
        const states = installmentStates(
          ledger({ today: '2026-03-01', installments, payments: [pay('p', '2026-03', '66.66')] }),
        );
        expect(states.get('i1')?.status).toBe('paid');
        expect(states.get('i2')?.status).toBe('paid');
        expect(states.get('i3')).toEqual({
          status: 'pending',
          coveredAmount: 0,
          remainingAmount: 33.34,
        });
      });

      it('pagamento de 66,67 deixa 0,01 coberto na terceira', () => {
        const l = ledger({
          today: '2026-03-01',
          installments,
          payments: [pay('p', '2026-03', 66.67)],
        });
        expect(installmentStates(l).get('i3')).toEqual({
          status: 'pending',
          coveredAmount: 0.01,
          remainingAmount: 33.33,
        });
        expect(cardBalance(l).outstanding).toBe(33.33);
      });
    });

    it('paidLate em mês só com encargo usa o vencimento pelos dias do cartão', () => {
      const l = ledger({
        today: '2026-04-10',
        charges: [charge('j', '2026-04', '15.00')],
        payments: [
          pay('late', '2026-04', '5.00', '2026-04-06'),
          pay('on-time', '2026-04', '5.00', '2026-04-05'),
        ],
      });
      expect(buildInvoiceView(l, '2026-04').payments).toEqual([
        { id: 'on-time', amount: 5, paidOn: '2026-04-05', paidLate: false },
        { id: 'late', amount: 5, paidOn: '2026-04-06', paidLate: true },
      ]);
    });

    it('mês só com um encargo parcialmente coberto → partially_paid', () => {
      const l = ledger({
        today: '2026-03-10',
        charges: [charge('j', '2026-03', '10.00')],
        payments: [pay('p', '2026-03', '4.00')],
      });
      expect(buildInvoiceView(l, '2026-03')).toMatchObject({
        status: 'partially_paid',
        coveredAmount: 4,
        remaining: 6,
      });
    });

    it('status da parcela usa o vencimento da fatura, não o da parcela isolada (D25)', () => {
      const l = ledger({
        today: '2026-04-03',
        installments: [
          inst('x', '2026-04', '1.00', { closingDate: '2026-03-20', dueDate: '2026-04-01' }),
          inst('y', '2026-04', '1.00', { closingDate: '2026-03-25', dueDate: '2026-04-05' }),
        ],
      });
      expect(installmentStates(l).get('x')?.status).toBe('pending');
      expect(buildInvoiceView(l, '2026-04').installments[0]).toMatchObject({
        id: 'x',
        status: 'pending',
      });
    });

    it('paidLate: relativo ao vencimento da fatura em que foi lançado; null para legado', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '100.00')],
        payments: [
          pay('late', '2026-03', '10.00', '2026-03-06'),
          pay('on-time', '2026-03', '10.00', '2026-03-05'),
          pay('legacy', '2026-03', '10.00', null),
        ],
      });
      expect(buildInvoiceView(l, '2026-03').payments).toEqual([
        { id: 'legacy', amount: 10, paidOn: null, paidLate: null },
        { id: 'on-time', amount: 10, paidOn: '2026-03-05', paidLate: false },
        { id: 'late', amount: 10, paidOn: '2026-03-06', paidLate: true },
      ]);
    });

    it('datas da fatura vêm das parcelas gravadas; se divergirem, usa a maior', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [
          inst('a', '2026-03', '1.00', { closingDate: '2026-02-20', dueDate: '2026-03-01' }),
          inst('b', '2026-03', '1.00', { closingDate: '2026-02-22', dueDate: '2026-03-03' }),
        ],
      });
      expect(buildInvoiceView(l, '2026-03')).toMatchObject({
        closingDate: '2026-02-22',
        dueDate: '2026-03-03',
      });
    });
  });

  describe('cardBalance (D11)', () => {
    it('dívida acima do limite deixa o limite disponível negativo (fórmula da D11, sem piso)', () => {
      const l = buildCardLedger({
        card: { ...CARD, creditLimit: '100.00' },
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '150.00')],
        charges: [],
        payments: [],
      });
      expect(cardBalance(l)).toEqual({ outstanding: 150, credit: 0, availableLimit: -50 });
    });

    it('limite disponível = limite − dívida em aberto', () => {
      const l = ledger({ today: '2026-03-10', installments: [inst('a', '2026-03', '300.00')] });
      expect(cardBalance(l)).toEqual({ outstanding: 300, credit: 0, availableLimit: 700 });
    });

    it('crédito não aumenta o limite disponível', () => {
      const l = ledger({ today: '2026-03-10', payments: [pay('p', '2026-03', '200.00')] });
      expect(cardBalance(l)).toEqual({ outstanding: 0, credit: 200, availableLimit: 1000 });
    });

    it.each([['0.00'], [0]])('creditLimit = %p → availableLimit null', (creditLimit) => {
      const l = buildCardLedger({
        card: { ...CARD, creditLimit },
        today: '2026-03-10',
        installments: [inst('a', '2026-03', '10.00')],
        charges: [],
        payments: [],
      });
      expect(cardBalance(l)).toEqual({ outstanding: 10, credit: 0, availableLimit: null });
    });
  });

  describe('D9: em que mês pode lançar pagamento/encargo', () => {
    it.each([
      ['2026-03-10', '2026-04'],
      ['2026-03-24', '2026-04'],
      ['2026-03-25', '2026-05'],
      ['2026-12-26', '2027-02'],
    ])('hoje %s → fatura aberta atual %s', (today, month) => {
      expect(currentOpenInvoiceMonth(ledger({ today }))).toBe(month);
    });

    it('fatura aberta atual pelo cartão 10/17 (fecha no mesmo mês)', () => {
      const l = buildCardLedger({
        card: { closingDay: 10, dueDay: 17, creditLimit: 0 },
        today: '2026-03-09',
        installments: [],
        charges: [],
        payments: [],
      });
      expect(currentOpenInvoiceMonth(l)).toBe('2026-03');
    });

    it.each([
      ['dia do fechamento', '2026-03-10', '2026-04'],
      ['virada de ano', '2026-12-10', '2027-01'],
    ])('cartão 10/17, %s (hoje %s) → aberta atual %s', (_label, today, month) => {
      const l = buildCardLedger({
        card: { closingDay: 10, dueDay: 17, creditLimit: 0 },
        today,
        installments: [],
        charges: [],
        payments: [],
      });
      expect(currentOpenInvoiceMonth(l)).toBe(month);
      expect(acceptsInvoiceEntries(l, month)).toBe(true);
      expect(acceptsInvoiceEntries(l, addMonths(month, 1))).toBe(false);
    });

    it('fechadas e a aberta atual aceitam; o mês seguinte à aberta não', () => {
      const l = ledger({ today: '2026-03-10', installments: [inst('a', '2026-05', '10.00')] });
      expect(acceptsInvoiceEntries(l, '2025-01')).toBe(true);
      expect(acceptsInvoiceEntries(l, '2026-03')).toBe(true);
      expect(acceptsInvoiceEntries(l, '2026-04')).toBe(true);
      expect(acceptsInvoiceEntries(l, '2026-05')).toBe(false);
      expect(acceptsInvoiceEntries(l, '2027-01')).toBe(false);
    });

    it('usa as datas gravadas nas parcelas do mês quando existem', () => {
      // Parcela de abril gravada com fechamento antigo (20/03) já passou: abril está fechada
      const l = ledger({
        today: '2026-03-21',
        installments: [inst('a', '2026-04', '10.00', { closingDate: '2026-03-20' })],
      });
      expect(acceptsInvoiceEntries(l, '2026-04')).toBe(true);
      expect(currentOpenInvoiceMonth(l)).toBe('2026-05');
      expect(buildInvoiceView(l, '2026-04').status).toBe('closed');
    });
  });

  describe('D20: parcela coberta em fatura fechada', () => {
    const installments = [
      inst('m1', '2026-03', '100.00', { transactionId: 'tx', number: 1 }),
      inst('m2', '2026-04', '100.00', { transactionId: 'tx', number: 2 }),
    ];

    it.each([
      ['dia do fechamento', '2026-02-25', true],
      ['véspera do fechamento', '2026-02-24', false],
    ])('fronteira: %s (%s) → %p', (_label, today, expected) => {
      const l = ledger({ today, installments, payments: [pay('p', '2026-03', '100.00')] });
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx')).toBe(expected);
    });

    it('usa o fechamento da fatura (maior), não o da parcela isolada (D25)', () => {
      const l = ledger({
        today: '2026-03-21',
        installments: [
          inst('x', '2026-04', '10.00', {
            transactionId: 'tx-x',
            closingDate: '2026-03-20',
            transactionCreatedAt: '2026-01-01T00:00:00.000000Z',
          }),
          inst('y', '2026-04', '10.00', {
            transactionId: 'tx-y',
            closingDate: '2026-03-25',
            transactionCreatedAt: '2026-01-02T00:00:00.000000Z',
          }),
        ],
        payments: [pay('p', '2026-04', '10.00')],
      });
      expect(buildInvoiceView(l, '2026-04').status).toBe('open');
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx-x')).toBe(false);
    });

    it('coberta em fatura fechada → true', () => {
      const l = ledger({
        today: '2026-03-10',
        installments,
        payments: [pay('p', '2026-03', '100.00')],
      });
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx')).toBe(true);
    });

    it('parcialmente coberta em fatura fechada → true', () => {
      const l = ledger({
        today: '2026-03-10',
        installments,
        payments: [pay('p', '2026-03', '0.01')],
      });
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx')).toBe(true);
    });

    it('coberta só em fatura aberta → false', () => {
      const l = ledger({
        today: '2026-02-20',
        installments,
        payments: [pay('p', '2026-03', '200.00')],
      });
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx')).toBe(false);
    });

    it('não coberta em fatura fechada → false; outra transação coberta não conta', () => {
      const l = ledger({
        today: '2026-03-10',
        installments: [
          inst('other', '2026-03', '50.00', {
            transactionId: 'tx-other',
            transactionCreatedAt: '2025-12-01T00:00:00.000000Z',
          }),
          ...installments,
        ],
        payments: [pay('p', '2026-03', '50.00')],
      });
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx')).toBe(false);
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx-other')).toBe(true);
    });
  });

  describe('D24: parcelas recalculadas caindo em fatura já fechada', () => {
    const existing = [inst('a', '2026-04', '10.00')]; // abril fecha 2026-03-25

    it.each([
      ['dia do fechamento → bloqueia', '2026-03-25', true],
      ['véspera do fechamento → libera', '2026-03-24', false],
    ])('%s (hoje %s)', (_label, today, expected) => {
      const l = ledger({ today, installments: existing });
      expect(
        installmentsFallInClosedInvoice(l, [{ dueDate: '2026-05-05' }, { dueDate: '2026-04-05' }]),
      ).toBe(expected);
    });

    it('mês de destino sem parcelas usa os dias do cartão', () => {
      const l = ledger({ today: '2026-03-25' });
      expect(installmentsFallInClosedInvoice(l, [{ dueDate: '2026-04-05' }])).toBe(true);
      expect(installmentsFallInClosedInvoice(l, [{ dueDate: '2026-05-05' }])).toBe(false);
    });

    it('usa as datas da fatura de destino (maior fechamento gravado, D25)', () => {
      const l = ledger({
        today: '2026-03-21',
        installments: [
          inst('x', '2026-04', '1.00', { closingDate: '2026-03-20' }),
          inst('y', '2026-04', '1.00', { closingDate: '2026-03-25' }),
        ],
      });
      expect(installmentsFallInClosedInvoice(l, [{ dueDate: '2026-04-05' }])).toBe(false);
    });

    it('lista vazia → false; data fora de YYYY-MM-DD lança', () => {
      const l = ledger({ today: '2026-03-25' });
      expect(installmentsFallInClosedInvoice(l, [])).toBe(false);
      expect(() => installmentsFallInClosedInvoice(l, [{ dueDate: '2026-04' }])).toThrow(/dueDate/);
    });
  });

  describe('D31: datas gravadas por fatura (card_invoice_dates)', () => {
    // Cartão mudou de "fecha 25, vence 5" (CARD) para "fecha 28, vence 10"; hoje 27/11/2026.
    // A fatura 2026-12 fechou em 25/11 e foi gravada antes da mudança.
    const NEW_CARD: LedgerCardInput = { closingDay: 28, dueDay: 10, creditLimit: '1000.00' };
    const DEC = { invoiceMonth: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' };
    const newLedger = (input: Partial<CardLedgerInput> & { today: string }) =>
      ledger({ card: NEW_CARD, recordedDates: [DEC], ...input });

    it('precedência: gravada por fatura → parcelas do mês → dias atuais do cartão', () => {
      const l = newLedger({
        today: '2026-11-27',
        installments: [
          // parcela legada no mês gravado, com datas divergentes: a gravada por fatura vence
          inst('dec', '2026-12', '10.00', { closingDate: '2026-11-28', dueDate: '2026-12-10' }),
          inst('jan', '2027-01', '10.00', {}, NEW_CARD),
          inst('feb', '2027-02', '10.00', { closingDate: '2027-01-27' }, NEW_CARD),
        ],
      });
      expect(invoiceDatesOf(l, '2026-12')).toEqual({
        closingDate: '2026-11-25',
        dueDate: '2026-12-05',
      });
      // sem gravação por fatura: as datas gravadas nas parcelas (não os dias do cartão)
      expect(invoiceDatesOf(l, '2027-02')).toEqual({
        closingDate: '2027-01-27',
        dueDate: '2027-02-10',
      });
      expect(invoiceDatesOf(l, '2027-03')).toEqual(invoiceDates('2027-03', NEW_CARD));
      expect(l.recordedDates.get('2026-12')).toEqual({
        closingDate: '2026-11-25',
        dueDate: '2026-12-05',
      });
      expect(l.recordedDates.has('2027-01')).toBe(false);
    });

    it('fatura gravada sem itens continua fechada (não reabre pelos dias novos)', () => {
      const view = buildInvoiceView(newLedger({ today: '2026-11-27' }), '2026-12');
      expect(view).toMatchObject({
        closingDate: '2026-11-25',
        dueDate: '2026-12-05',
        status: 'closed',
      });
      // sem a gravação, os dias novos (fecha 28/11) fariam a fatura parecer aberta
      const without = buildInvoiceView(ledger({ card: NEW_CARD, today: '2026-11-27' }), '2026-12');
      expect(without.status).toBe('open');
    });

    it('D9: a aberta atual é a seguinte à gravada; a gravada (fechada) também aceita', () => {
      const l = newLedger({ today: '2026-11-27' });
      expect(currentOpenInvoiceMonth(l)).toBe('2027-01');
      expect(acceptsInvoiceEntries(l, '2026-12')).toBe(true);
      expect(acceptsInvoiceEntries(l, '2027-01')).toBe(true);
      expect(acceptsInvoiceEntries(l, '2027-02')).toBe(false);
    });

    it('D24 usa o fechamento gravado da fatura de destino', () => {
      const l = newLedger({ today: '2026-11-27' });
      expect(installmentsFallInClosedInvoice(l, [{ dueDate: '2026-12-05' }])).toBe(true);
      expect(installmentsFallInClosedInvoice(l, [{ dueDate: '2027-01-10' }])).toBe(false);
    });

    it('vencida e saldo anterior (D10) usam o vencimento gravado', () => {
      const l = newLedger({
        today: '2026-12-07', // depois do vencimento gravado (05/12), antes do novo (10/12)
        installments: [
          inst('dec', '2026-12', '10.00', { closingDate: '2026-11-25', dueDate: '2026-12-05' }),
        ],
      });
      expect(installmentStates(l).get('dec')?.status).toBe('overdue');
      expect(buildInvoiceView(l, '2026-12').status).toBe('unpaid');
      expect(buildInvoiceView(l, '2027-01').previousBalance).toBe(10);
    });

    it('encargo em mês gravado vence pelo vencimento gravado (05/12), não pelo dos dias novos (10/12)', () => {
      const l = newLedger({ today: '2026-12-07', charges: [charge('ch', '2026-12', '7.50')] });
      const view = buildInvoiceView(l, '2026-12');
      expect(view.dueDate).toBe('2026-12-05');
      expect(view.charges).toEqual([
        expect.objectContaining({ id: 'ch', status: 'overdue', remainingAmount: 7.5 }),
      ]);
      expect(view.status).toBe('unpaid');
      // sem a gravação (vence 10/12 pelos dias novos) o mesmo encargo ainda estaria pendente
      const without = ledger({
        card: NEW_CARD,
        today: '2026-12-07',
        charges: [charge('ch', '2026-12', '7.50')],
      });
      expect(buildInvoiceView(without, '2026-12').charges[0].status).toBe('pending');
    });

    it('paidLate usa o vencimento gravado: pago em 07/12 (gravada vence 05/12, dias novos 10/12)', () => {
      const l = newLedger({
        today: '2026-12-08',
        payments: [
          pay('late', '2026-12', '5.00', '2026-12-07'),
          pay('ok', '2026-12', '5.00', '2026-12-05'),
        ],
      });
      const byId = Object.fromEntries(
        buildInvoiceView(l, '2026-12').payments.map((p) => [p.id, p.paidLate]),
      );
      expect(byId).toEqual({ late: true, ok: false });
      const without = ledger({
        card: NEW_CARD,
        today: '2026-12-08',
        payments: [pay('late', '2026-12', '5.00', '2026-12-07')],
      });
      expect(buildInvoiceView(without, '2026-12').payments[0].paidLate).toBe(false);
    });

    it('D20: parcela coberta em fatura gravada (fechada) é detectada', () => {
      const l = newLedger({
        today: '2026-11-27',
        installments: [
          // gravada nas parcelas pelos dias novos (fecha 28/11, ainda aberta), mas a fatura fechou
          inst('dec', '2026-12', '10.00', {
            transactionId: 'tx',
            closingDate: '2026-11-28',
            dueDate: '2026-12-10',
          }),
        ],
        payments: [pay('p', '2026-12', '10.00')],
      });
      expect(hasCoveredInstallmentInClosedInvoice(l, 'tx')).toBe(true);
    });

    it.each([
      ['invoiceMonth', { ...DEC, invoiceMonth: '2026-13' }, /recorded\.invoiceMonth/],
      ['closingDate', { ...DEC, closingDate: '2026-11-25T00:00' }, /recorded\.closingDate/],
      ['dueDate', { ...DEC, dueDate: new Date() as unknown as string }, /recorded\.dueDate/],
    ])('formato inválido em %s lança', (_label, recorded, message) => {
      expect(() => ledger({ today: '2026-11-27', recordedDates: [recorded] })).toThrow(message);
    });

    it('sem recordedDates: mapa vazio (comportamento anterior)', () => {
      expect(ledger({ today: '2026-11-27' }).recordedDates.size).toBe(0);
    });
  });

  describe('D31: closedInvoiceDatesToRecord (snapshot antes de mudar os dias)', () => {
    // Pelos dias atuais (antigos) do cartão: fecha 25, vence 5. Hoje 27/11/2026.
    // Dias novos (salvo indicação): fecha 28, vence 10.
    const TODAY = '2026-11-27';
    const NEW_DAYS = { closingDay: 28, dueDay: 10 };

    it('grava os meses fechados com parcela, encargo ou pagamento, pelas datas vigentes (D25)', () => {
      const l = ledger({
        today: TODAY,
        installments: [
          // datas gravadas na parcela (dias mais antigos) prevalecem sobre os dias do cartão
          inst('oct', '2026-10', '10.00', { closingDate: '2026-09-24' }),
          inst('dec', '2026-12', '10.00'),
          inst('jan', '2027-01', '10.00'), // aberta (fecha 25/12): não grava
        ],
        charges: [charge('c', '2026-11', '5.00')],
        payments: [pay('p', '2026-09', '5.00')],
      });
      expect(closedInvoiceDatesToRecord(l, NEW_DAYS)).toEqual([
        { month: '2026-09', closingDate: '2026-08-25', dueDate: '2026-09-05' },
        { month: '2026-10', closingDate: '2026-09-24', dueDate: '2026-10-05' },
        { month: '2026-11', closingDate: '2026-10-25', dueDate: '2026-11-05' },
        { month: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
      ]);
    });

    it('não repete mês já gravado (nem com datas diferentes)', () => {
      const l = ledger({
        today: TODAY,
        installments: [inst('oct', '2026-10', '10.00'), inst('dec', '2026-12', '10.00')],
        recordedDates: [
          { invoiceMonth: '2026-10', closingDate: '2026-09-20', dueDate: '2026-10-01' },
          { invoiceMonth: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
        ],
      });
      expect(closedInvoiceDatesToRecord(l, NEW_DAYS)).toEqual([]);
    });

    it('grava a fatura fechada mais recente mesmo vazia (pelos dias atuais)', () => {
      expect(closedInvoiceDatesToRecord(ledger({ today: TODAY }), NEW_DAYS)).toEqual([
        { month: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
      ]);
      // véspera do fechamento de 2026-12: a mais recente fechada é 2026-11
      expect(closedInvoiceDatesToRecord(ledger({ today: '2026-11-24' }), NEW_DAYS)).toEqual([
        { month: '2026-11', closingDate: '2026-10-25', dueDate: '2026-11-05' },
      ]);
    });

    it('cartão que vence no mesmo mês do fechamento (fecha 5, vence 15)', () => {
      const l = ledger({
        card: { closingDay: 5, dueDay: 15, creditLimit: 0 },
        today: TODAY,
        payments: [pay('p', '2026-12', '1.00')], // 2026-12 fecha 05/12: aberta, não grava
      });
      expect(closedInvoiceDatesToRecord(l, NEW_DAYS)).toEqual([
        { month: '2026-11', closingDate: '2026-11-05', dueDate: '2026-11-15' },
      ]);
    });

    it('fechamento no dia de hoje conta como fechada', () => {
      const l = ledger({ today: '2026-11-25', installments: [inst('dec', '2026-12', '1.00')] });
      expect(closedInvoiceDatesToRecord(l, NEW_DAYS)).toEqual([
        { month: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
      ]);
    });

    describe('mês fechado que reabriria pelos dias novos (gravado mesmo vazio)', () => {
      // Cenário do business-rules §5: fecha 25/vence 5, hoje 26/11/2026; 2026-11 (fechou 25/10)
      // vazia, 2026-12 (fechou 25/11) com compra. Dias novos: fecha 27, vence 28 — a 2026-11
      // fecharia em 27/11 (> hoje), reabrindo.
      const T = '2026-11-26';
      const NEW = { closingDay: 27, dueDay: 28 };
      const before = () => ledger({ today: T, installments: [inst('dec', '2026-12', '10.00')] });

      it('grava a 2026-11 vazia (25/10, 05/11) além da 2026-12', () => {
        expect(closedInvoiceDatesToRecord(before(), NEW)).toEqual([
          { month: '2026-11', closingDate: '2026-10-25', dueDate: '2026-11-05' },
          { month: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
        ]);
      });

      it('depois da gravação, com os dias novos: 2026-11 continua fechada e D9 aponta 2027-01', () => {
        const recordedDates = closedInvoiceDatesToRecord(before(), NEW).map(
          ({ month, ...dates }) => ({ invoiceMonth: month, ...dates }),
        );
        const after = ledger({
          card: { ...NEW, creditLimit: '1000.00' },
          today: T,
          installments: [inst('dec', '2026-12', '10.00')],
          recordedDates,
        });
        expect(buildInvoiceView(after, '2026-11').status).toBe('closed');
        expect(currentOpenInvoiceMonth(after)).toBe('2027-01');
        expect(acceptsInvoiceEntries(after, '2027-01')).toBe(true);
        // sem gravar a 2026-11, ela reabriria (fecha 27/11) e seria a "aberta atual"
        const withoutNov = ledger({
          card: { ...NEW, creditLimit: '1000.00' },
          today: T,
          installments: [inst('dec', '2026-12', '10.00')],
          recordedDates: recordedDates.filter((r) => r.invoiceMonth !== '2026-11'),
        });
        expect(currentOpenInvoiceMonth(withoutNov)).toBe('2026-11');
      });

      it('mês fechado vazio que continua fechado pelos dias novos não é gravado', () => {
        // dias novos "fecha 20, vence 5": 2026-11 fecharia em 20/10 (≤ hoje) — não reabre
        expect(closedInvoiceDatesToRecord(before(), { closingDay: 20, dueDay: 5 })).toEqual([
          { month: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
        ]);
      });

      it('mês ainda aberto pelas datas vigentes não é gravado (mesmo que os dias novos o fechem)', () => {
        // 2027-01 fecha 25/12 (aberta); dias novos "fecha 1, vence 10": fecharia 01/01 — aberta
        // e, de qualquer forma, só se grava o que já está fechado
        expect(closedInvoiceDatesToRecord(before(), { closingDay: 1, dueDay: 10 })).toEqual([
          { month: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
        ]);
      });

      it('mês já gravado não é regravado', () => {
        const l = ledger({
          today: T,
          installments: [inst('dec', '2026-12', '10.00')],
          recordedDates: [
            { invoiceMonth: '2026-11', closingDate: '2026-10-20', dueDate: '2026-11-01' },
          ],
        });
        expect(closedInvoiceDatesToRecord(l, NEW)).toEqual([
          { month: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' },
        ]);
      });
    });
  });

  describe('installmentStates (resumo/listagens)', () => {
    it('devolve um mapa por id com status e valores de cada parcela', () => {
      const l = ledger({
        today: '2026-04-10',
        installments: [
          inst('a', '2026-03', '100.00'),
          inst('b', '2026-04', '100.00'),
          inst('c', '2026-05', '100.00'),
        ],
        payments: [pay('p', '2026-03', '150.00')],
      });
      expect(Object.fromEntries(installmentStates(l))).toEqual({
        a: { status: 'paid', coveredAmount: 100, remainingAmount: 0 },
        b: { status: 'overdue', coveredAmount: 50, remainingAmount: 50 },
        c: { status: 'pending', coveredAmount: 0, remainingAmount: 100 },
      });
    });
  });

  describe('invariantes (cenários aleatórios com seed fixa)', () => {
    /** mulberry32: gerador determinístico. */
    function rng(seed: number) {
      let a = seed;
      return () => {
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const MONTHS = ['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const money = (cents: number) => (cents / 100).toFixed(2);

    function scenario(seed: number): CardLedgerInput {
      const r = rng(seed);
      const int = (min: number, max: number) => min + Math.floor(r() * (max - min + 1));
      const pick = <T>(list: readonly T[]) => list[int(0, list.length - 1)];
      const card = {
        closingDay: int(1, 28),
        dueDay: int(1, 28),
        creditLimit: money(int(0, 3) * 50000),
      };
      const installments = Array.from({ length: int(0, 8) }, (_, i) =>
        inst(
          `i${i}`,
          pick(MONTHS),
          money(int(1, 30000)),
          {
            transactionId: `tx${int(0, 3)}`,
            number: int(1, 3),
            transactionCreatedAt: `2026-09-${pad(int(1, 28))}T00:00:00.000000Z`,
          },
          card,
        ),
      );
      const charges = Array.from({ length: int(0, 3) }, (_, i) =>
        charge(
          `c${i}`,
          pick(MONTHS),
          money(int(1, 5000)),
          `2026-09-${pad(int(1, 28))}T00:00:00.000000Z`,
        ),
      );
      const payments = Array.from({ length: int(0, 4) }, (_, i) =>
        pay(`p${i}`, pick(MONTHS), money(int(1, 40000)), r() < 0.2 ? null : '2026-10-01'),
      );
      const today = `${pick(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03', '2027-04'])}-${pad(int(1, 28))}`;
      return { card, installments, charges, payments, today };
    }

    const seeds = Array.from({ length: 200 }, (_, i) => i + 1);

    it.each(seeds)('seed %i', (seed) => {
      const input = scenario(seed);
      const l = buildCardLedger(input);
      const views = MONTHS.map((m) => buildInvoiceView(l, m));
      const cents = (v: number) => Math.round(v * 100);

      // Σ remaining(todos os meses) == outstanding
      expect(views.reduce((acc, v) => acc + cents(v.remaining), 0)).toBe(l.outstandingCents);
      expect(cents(cardBalance(l).outstanding)).toBe(l.outstandingCents);

      // parte coberta é prefixo da ordem
      const firstOpen = l.items.findIndex((i) => i.remainingCents > 0);
      if (firstOpen >= 0) {
        l.items.slice(0, firstOpen).forEach((i) => expect(i.remainingCents).toBe(0));
        l.items.slice(firstOpen + 1).forEach((i) => expect(i.coveredCents).toBe(0));
      }

      // Σ coberto + credit == P
      const covered = l.items.reduce((acc, i) => acc + i.coveredCents, 0);
      expect(covered + l.creditCents).toBe(l.paidCents);
      expect(views.reduce((acc, v) => acc + cents(v.coveredAmount), 0)).toBe(covered);

      // previousBalance(M) > 0 ⇒ nenhum item de M coberto
      for (const v of views) {
        if (v.previousBalance > 0) expect(v.coveredAmount).toBe(0);
        expect(cents(v.amountDue)).toBe(cents(v.previousBalance) + cents(v.remaining));
      }

      // coberto + restante == valor, por item
      l.items.forEach((i) => expect(i.coveredCents + i.remainingCents).toBe(i.amountCents));

      // status: paid ⇒ mês com itens e nada restante; mês sem itens nunca paid
      for (const v of views) {
        const hasItems = v.installments.length + v.charges.length > 0;
        if (v.status === 'paid') {
          expect(hasItems).toBe(true);
          expect(v.remaining).toBe(0);
        }
        if (!hasItems) expect(v.status).not.toBe('paid');
        if (v.status === 'partially_paid') expect(v.coveredAmount).toBeGreaterThan(0);
      }
    });
  });
});
