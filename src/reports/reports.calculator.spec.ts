import { InstallmentStatus } from '../installments/installment-status.enum';
import { PaymentMethod } from '../transactions/entities/transaction.entity';
import { sumCents, toCents } from '../common/money';
import {
  buildCardLedger,
  buildInvoiceView,
  LedgerItemState,
} from '../invoices/invoice-ledger.calculator';
import {
  buildInvoice,
  buildMonthlySummary,
  monthRange,
  SummaryChargeRow,
  SummaryInstallmentRow,
  SummaryTransactionRow,
} from './reports.calculator';

describe('reports.calculator', () => {
  describe('monthRange', () => {
    it('devolve o primeiro dia do mês e o primeiro dia do mês seguinte (exclusivo)', () => {
      expect(monthRange('2026-02')).toEqual({ start: '2026-02-01', endExclusive: '2026-03-01' });
    });

    it('atravessa o ano em dezembro', () => {
      expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', endExclusive: '2027-01-01' });
    });
  });

  describe('buildInvoice (visão do razão + dados descritivos)', () => {
    const ledger = buildCardLedger({
      card: { closingDay: 10, dueDay: 17, creditLimit: 1000 },
      installments: [
        {
          id: 'i1',
          transactionId: 't1',
          transactionCreatedAt: '2026-02-01T12:00:00.123456Z',
          number: 2,
          amount: '60.00',
          dueDate: '2026-03-17',
          closingDate: '2026-03-10',
        },
      ],
      charges: [
        {
          id: 'ch1',
          invoiceMonth: '2026-03',
          amount: '5.00',
          createdAt: '2026-03-12T09:30:00.654321Z',
        },
      ],
      payments: [{ id: 'p1', invoiceMonth: '2026-03', amount: '40.00', paidOn: '2026-03-18' }],
      today: '2026-03-20',
    });
    const view = buildInvoiceView(ledger, '2026-03');

    it('junta cartão, totais do razão, itens com descrição e encargos com descrição', () => {
      const invoice = buildInvoice({
        card: { id: 'card-1', name: 'Nubank' },
        view,
        details: new Map([
          [
            'i1',
            {
              installmentId: 'i1',
              description: 'Geladeira',
              category: 'Casa',
              purchaseDate: '2026-01-20',
              totalInstallments: 3,
            },
          ],
        ]),
        chargeDescriptions: new Map([['ch1', 'Juros']]),
      });

      expect(invoice).toMatchObject({
        cardId: 'card-1',
        cardName: 'Nubank',
        month: '2026-03',
        closingDate: '2026-03-10',
        dueDate: '2026-03-17',
        status: 'partially_paid',
        previousBalance: 0,
        installmentsTotal: 60,
        chargesTotal: 5,
        paymentsTotal: 40,
        coveredAmount: 40,
        remaining: 25,
        amountDue: 25,
      });
      expect(invoice.items).toEqual([
        {
          installmentId: 'i1',
          transactionId: 't1',
          description: 'Geladeira',
          category: 'Casa',
          purchaseDate: '2026-01-20',
          number: 2,
          totalInstallments: 3,
          amount: 60,
          dueDate: '2026-03-17',
          closingDate: '2026-03-10',
          status: 'overdue',
          coveredAmount: 40,
          remainingAmount: 20,
        },
      ]);
      expect(invoice.charges).toEqual([
        {
          id: 'ch1',
          amount: 5,
          description: 'Juros',
          createdAt: '2026-03-12T09:30:00.654Z',
          status: 'overdue',
          coveredAmount: 0,
          remainingAmount: 5,
        },
      ]);
      expect(invoice.payments).toEqual([
        { id: 'p1', amount: 40, paidOn: '2026-03-18', paidLate: true },
      ]);
    });

    it('encargo sem descrição → null', () => {
      const invoice = buildInvoice({
        card: { id: 'card-1', name: 'Nubank' },
        view,
        details: new Map(),
        chargeDescriptions: new Map(),
      });
      expect(invoice.charges[0].description).toBeNull();
    });
  });

  describe('buildMonthlySummary (regime de caixa)', () => {
    const inst = (over: Partial<SummaryInstallmentRow>): SummaryInstallmentRow => ({
      id: 'i',
      amount: '100.00',
      status: InstallmentStatus.PENDING,
      dueDate: '2026-03-17',
      category: 'Casa',
      cardId: 'card-1',
      cardName: 'Nubank',
      ...over,
    });
    const tx = (over: Partial<SummaryTransactionRow>): SummaryTransactionRow => ({
      totalAmount: '50.00',
      category: 'Mercado',
      paymentMethod: PaymentMethod.PIX,
      ...over,
    });
    const state = (
      status: LedgerItemState['status'],
      coveredAmount: number,
      remainingAmount: number,
    ): LedgerItemState => ({ status, coveredAmount, remainingAmount });
    const base = {
      month: '2026-03',
      today: '2026-03-20',
      installmentStates: new Map<string, LedgerItemState>(),
      charges: [] as SummaryChargeRow[],
      invoicePayments: [],
      transactions: [] as SummaryTransactionRow[],
      installments: [] as SummaryInstallmentRow[],
      receivablesPending: null,
    };

    it('parcelas por valor derivado: coberta, parcialmente coberta, vencida e órfã gravada', () => {
      const summary = buildMonthlySummary({
        ...base,
        installments: [
          // status gravado de cartão é ignorado: vale o razão
          inst({ id: 'a', amount: '100.00', status: InstallmentStatus.PAID }),
          inst({ id: 'b', amount: '33.33', category: 'Mercado' }),
          inst({
            id: 'c',
            amount: '0.10',
            dueDate: '2026-03-25',
            category: null,
            cardId: 'card-2',
            cardName: 'Inter',
          }),
          // órfã legada (cartão removido): status gravado
          inst({
            id: 'd',
            amount: '9.90',
            cardId: null,
            cardName: null,
            status: InstallmentStatus.PAID,
          }),
          inst({ id: 'e', amount: '1.00', cardId: null, cardName: null, dueDate: '2026-03-01' }),
        ],
        installmentStates: new Map([
          ['a', state('overdue', 0, 100)],
          ['b', state('overdue', 13.33, 20)], // parcialmente coberta
          ['c', state('paid', 0.1, 0)],
        ]),
        transactions: [tx({ totalAmount: '50.00' }), tx({ totalAmount: '0.20', category: null })],
      });

      expect(summary.totals).toEqual({
        spent: 194.53,
        cardInstallments: 144.33,
        cardCharges: 0,
        upfront: 50.2,
      });
      // pago = 13.33 + 0.10 + 9.90; não coberto = 100 + 20 + 1; vencido = tudo não coberto
      expect(summary.installments).toEqual({ paid: 23.33, pending: 121, overdue: 121 });
      expect(summary.byCategory).toEqual([
        { category: 'Casa', amount: 110.9 },
        { category: 'Mercado', amount: 83.33 },
        { category: null, amount: 0.3 },
      ]);
      expect(summary.byCard).toEqual([
        { cardId: 'card-1', cardName: 'Nubank', amount: 133.33 },
        { cardId: null, cardName: null, amount: 10.9 },
        { cardId: 'card-2', cardName: 'Inter', amount: 0.1 },
      ]);
      expect(summary.receivablesPending).toBeNull();
    });

    it('cardCharges: encargos do mês entram em spent e byCard, não em byCategory (D23)', () => {
      const summary = buildMonthlySummary({
        ...base,
        installments: [inst({ id: 'a', amount: '100.00' })],
        installmentStates: new Map([['a', state('pending', 0, 100)]]),
        charges: [
          { cardId: 'card-1', cardName: 'Nubank', invoiceMonth: '2026-03', amount: '12.34' },
          { cardId: 'card-3', cardName: 'Só encargo', invoiceMonth: '2026-03', amount: '0.01' },
          { cardId: 'card-1', cardName: 'Nubank', invoiceMonth: '2026-04', amount: '999.00' }, // outro mês
        ],
        transactions: [tx({ totalAmount: '10.00' })],
      });

      expect(summary.totals).toEqual({
        spent: 122.35,
        cardInstallments: 100,
        cardCharges: 12.35,
        upfront: 10,
      });
      expect(summary.byCard).toEqual([
        { cardId: 'card-1', cardName: 'Nubank', amount: 112.34 },
        { cardId: 'card-3', cardName: 'Só encargo', amount: 0.01 },
      ]);
      expect(sumCents(summary.byCategory, (g) => toCents(g.amount))).toBe(
        toCents(summary.totals.spent) - toCents(summary.totals.cardCharges),
      );
      // encargo não é parcela
      expect(summary.installments).toEqual({ paid: 0, pending: 100, overdue: 0 });
    });

    it('paidInMonth: pagamentos de fatura com paidOn no mês (legado null fora) + à vista', () => {
      const summary = buildMonthlySummary({
        ...base,
        invoicePayments: [
          { amount: '100.00', paidOn: '2026-03-01' },
          { amount: '0.01', paidOn: '2026-03-31' },
          { amount: '50.00', paidOn: '2026-02-28' }, // fora
          { amount: '70.00', paidOn: '2026-04-01' }, // fora
          { amount: '999.00', paidOn: null }, // legado (D22)
        ],
        transactions: [tx({ totalAmount: '20.00' })],
      });
      expect(summary.paidInMonth).toBe(120.01);
      // pagamento não é gasto
      expect(summary.totals.spent).toBe(20);
    });

    it('byPaymentMethod: só transações à vista, agrupadas em centavos, null = legado', () => {
      const summary = buildMonthlySummary({
        ...base,
        installments: [inst({ amount: '999.00' })], // parcelas de cartão não entram
        transactions: [
          tx({ totalAmount: '0.10', paymentMethod: PaymentMethod.PIX }),
          tx({ totalAmount: '0.20', paymentMethod: PaymentMethod.PIX }),
          tx({ totalAmount: '80.00', paymentMethod: PaymentMethod.CASH }),
          tx({ totalAmount: '12.00', paymentMethod: null }),
          tx({ totalAmount: '7.50', paymentMethod: PaymentMethod.BOLETO }),
          tx({ totalAmount: '5.00', paymentMethod: null }),
        ],
      });

      expect(summary.totals.upfront).toBe(104.8);
      expect(summary.byPaymentMethod).toEqual([
        { paymentMethod: PaymentMethod.CASH, amount: 80 },
        { paymentMethod: null, amount: 17 },
        { paymentMethod: PaymentMethod.BOLETO, amount: 7.5 },
        { paymentMethod: PaymentMethod.PIX, amount: 0.3 },
      ]);
      expect(sumCents(summary.byPaymentMethod, (g) => toCents(g.amount))).toBe(
        toCents(summary.totals.upfront),
      );
    });

    it('mês sem movimento devolve zeros e listas vazias', () => {
      const summary = buildMonthlySummary({ ...base, receivablesPending: ['10.00', '5.50'] });
      expect(summary.totals).toEqual({ spent: 0, cardInstallments: 0, cardCharges: 0, upfront: 0 });
      expect(summary.installments).toEqual({ paid: 0, pending: 0, overdue: 0 });
      expect(summary.paidInMonth).toBe(0);
      expect(summary.byCategory).toEqual([]);
      expect(summary.byPaymentMethod).toEqual([]);
      expect(summary.byCard).toEqual([]);
      expect(summary.receivablesPending).toBe(15.5);
    });
  });
});
