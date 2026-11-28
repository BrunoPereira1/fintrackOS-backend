import { InstallmentStatus } from './installment-status.enum';
import {
  listingCoverage,
  orphanInstallmentState,
  resolveInstallmentState,
} from './installment-state';
import {
  buildCardLedger,
  installmentStates,
  LedgerInstallmentInput,
} from '../invoices/invoice-ledger.calculator';

const TODAY = '2026-03-15';
const ts = (n: number) => `2026-01-0${n}T10:00:00.000000Z`;
const inst = (over: Partial<LedgerInstallmentInput>): LedgerInstallmentInput => ({
  id: 'i',
  transactionId: 't1',
  transactionCreatedAt: ts(1),
  number: 1,
  amount: '100.00',
  dueDate: '2026-02-17',
  closingDate: '2026-02-10',
  ...over,
});

describe('installment-state', () => {
  describe('orphanInstallmentState (D18: órfã usa o status gravado)', () => {
    it.each([
      [InstallmentStatus.PAID, '2026-01-01', 'paid', 100, 0],
      [InstallmentStatus.PENDING, '2026-03-14', 'overdue', 0, 100], // vencida calculada (D6)
      [InstallmentStatus.PENDING, '2026-03-15', 'pending', 0, 100], // vence hoje
      [InstallmentStatus.OVERDUE, '2026-04-01', 'overdue', 0, 100], // gravado continua
    ])('%s com vencimento %s → %s', (stored, dueDate, status, covered, remaining) => {
      expect(orphanInstallmentState({ status: stored, amount: '100.00', dueDate }, TODAY)).toEqual({
        status,
        coveredAmount: covered,
        remainingAmount: remaining,
      });
    });
  });

  describe('resolveInstallmentState', () => {
    const states = new Map([
      ['card-i', { status: 'paid' as const, coveredAmount: 10, remainingAmount: 0 }],
    ]);

    it('parcela de cartão usa o razão e ignora o status gravado', () => {
      expect(
        resolveInstallmentState(
          {
            id: 'card-i',
            cardId: 'c1',
            status: InstallmentStatus.PENDING,
            amount: '10.00',
            dueDate: '2026-01-01',
          },
          states,
          TODAY,
        ),
      ).toEqual({ status: 'paid', coveredAmount: 10, remainingAmount: 0 });
    });

    it('órfã (sem cartão) usa o status gravado mesmo se houver estado com o mesmo id', () => {
      expect(
        resolveInstallmentState(
          {
            id: 'card-i',
            cardId: null,
            status: InstallmentStatus.PENDING,
            amount: '10.00',
            dueDate: '2026-04-01',
          },
          states,
          TODAY,
        ),
      ).toEqual({ status: 'pending', coveredAmount: 0, remainingAmount: 10 });
    });

    it('parcela de cartão fora do razão (defensivo) conta como não coberta', () => {
      expect(
        resolveInstallmentState(
          {
            id: 'x',
            cardId: 'c1',
            status: InstallmentStatus.PAID,
            amount: '10.00',
            dueDate: '2026-03-01',
          },
          states,
          TODAY,
        ),
      ).toEqual({ status: 'overdue', coveredAmount: 0, remainingAmount: 10 });
    });
  });

  describe('listingCoverage (parâmetros do filtro SQL da listagem)', () => {
    const ledgerOf = (paid: string[], installments: LedgerInstallmentInput[]) =>
      buildCardLedger({
        card: { closingDay: 10, dueDay: 17, creditLimit: 1000 },
        installments,
        charges: [],
        payments: paid.map((amount, k) => ({
          id: `p${k}`,
          invoiceMonth: '2026-02',
          amount,
          paidOn: '2026-02-17',
        })),
        today: TODAY,
      });

    const installments = [
      inst({ id: 'a', transactionId: 't2', transactionCreatedAt: ts(2) }), // fev, 2ª lançada
      inst({ id: 'b', transactionId: 't1', transactionCreatedAt: ts(1) }), // fev, 1ª lançada
      inst({ id: 'c', dueDate: '2026-03-17', closingDate: '2026-03-10' }),
      inst({ id: 'd', dueDate: '2026-04-17', closingDate: '2026-04-10' }),
    ];

    it('limiar = última parcela totalmente coberta na ordem FIFO; parcial não entra', () => {
      // P = 250: b (100) e a (100) cobertas, c parcialmente (50)
      const ledger = ledgerOf(['250.00'], installments);
      const { covered, pastDue } = listingCoverage(new Map([['card-1', ledger]]));

      expect(covered).toEqual([
        { cardId: 'card-1', month: '2026-02', transactionId: 't2', number: 1 },
      ]);
      // fev (17/02) e mar (17/03 ≥ hoje? não: 17/03 > 15/03) → só fev vencida
      expect(pastDue).toEqual([{ cardId: 'card-1', month: '2026-02' }]);

      // coerente com o razão: tudo até o limiar está pago, o resto não
      const states = installmentStates(ledger);
      expect(['b', 'a', 'c', 'd'].map((id) => states.get(id)?.status)).toEqual([
        'paid',
        'paid',
        'pending',
        'pending',
      ]);
    });

    it('fatura que vence hoje não entra em pastDue (vencida é dueDate < hoje)', () => {
      const ledger = buildCardLedger({
        card: { closingDay: 10, dueDay: 15, creditLimit: 1000 },
        installments: [inst({ id: 'h', dueDate: '2026-03-15', closingDate: '2026-03-10' })],
        charges: [],
        payments: [],
        today: TODAY,
      });
      expect(listingCoverage(new Map([['card-1', ledger]])).pastDue).toEqual([]);
    });

    it('D31: pastDue usa o vencimento gravado por fatura, não o das parcelas', () => {
      // Parcela de mar gravada pelos dias novos (vence 20/03), mas a fatura 2026-03 tem datas
      // gravadas (fechou 05/03, venceu 12/03): hoje 15/03 ela já está vencida
      const ledger = buildCardLedger({
        card: { closingDay: 13, dueDay: 20, creditLimit: 1000 },
        installments: [inst({ id: 'm', dueDate: '2026-03-20', closingDate: '2026-03-13' })],
        charges: [],
        payments: [],
        recordedDates: [
          { invoiceMonth: '2026-03', closingDate: '2026-03-05', dueDate: '2026-03-12' },
        ],
        today: TODAY,
      });
      expect(listingCoverage(new Map([['card-1', ledger]])).pastDue).toEqual([
        { cardId: 'card-1', month: '2026-03' },
      ]);
      expect(installmentStates(ledger).get('m')?.status).toBe('overdue');
    });

    it('sem parcela totalmente coberta não há limiar para o cartão', () => {
      const ledger = ledgerOf(['99.99'], installments);
      expect(listingCoverage(new Map([['card-1', ledger]])).covered).toEqual([]);
    });

    it('vários cartões geram um limiar e meses vencidos por cartão', () => {
      const l1 = ledgerOf(['400.00'], installments);
      const l2 = ledgerOf(
        [],
        [inst({ id: 'z', dueDate: '2026-01-17', closingDate: '2026-01-10' })],
      );
      const { covered, pastDue } = listingCoverage(
        new Map([
          ['card-1', l1],
          ['card-2', l2],
        ]),
      );
      expect(covered).toEqual([
        { cardId: 'card-1', month: '2026-04', transactionId: 't1', number: 1 },
      ]);
      expect(pastDue).toEqual([
        { cardId: 'card-1', month: '2026-02' },
        { cardId: 'card-2', month: '2026-01' },
      ]);
    });
  });
});
