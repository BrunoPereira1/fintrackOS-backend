import { InstallmentStatus } from '../installments/installment-status.enum';
import { SplitStatus } from '../splits/entities/cost-split.entity';
import { LedgerItemState } from '../invoices/invoice-ledger.calculator';
import {
  buildReceivables,
  ReceivableInstallmentRow,
  ReceivableSplitRow,
} from './receivables.calculator';

const split = (over: Partial<ReceivableSplitRow>): ReceivableSplitRow => ({
  splitId: 's-1',
  contactId: 'c-ana',
  contactName: 'Ana',
  contactEmail: 'ana@x.com',
  transactionId: 't-1',
  description: 'Jantar',
  transactionDate: '2026-03-01',
  assignedAmount: '10.00',
  status: SplitStatus.PENDING,
  paidAt: null,
  ...over,
});

const TODAY = '2026-03-08';
const noLedger = { installmentStates: new Map<string, LedgerItemState>(), today: TODAY };

let seq = 0;
const inst = (over: Partial<ReceivableInstallmentRow>): ReceivableInstallmentRow => ({
  id: `i-${++seq}`,
  transactionId: 't-card',
  cardId: 'card-1',
  status: InstallmentStatus.PENDING,
  amount: '100.00',
  dueDate: '2026-04-05',
  ...over,
});
const state = (status: LedgerItemState['status'], covered = 0, remaining = 0): LedgerItemState => ({
  status,
  coveredAmount: covered,
  remainingAmount: remaining,
});

describe('buildReceivables', () => {
  it('agrupa por contato somando em centavos, separando pendente e pago', () => {
    const result = buildReceivables({
      ...noLedger,
      status: 'all',
      splits: [
        split({ splitId: 'a', assignedAmount: '0.01' }),
        split({ splitId: 'b', assignedAmount: '0.02' }),
        split({
          splitId: 'c',
          assignedAmount: '33.33',
          status: SplitStatus.PAID,
          paidAt: '2026-03-10T12:00:00.000Z',
        }),
      ],
      installments: [],
    });

    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({
      contactId: 'c-ana',
      name: 'Ana',
      email: 'ana@x.com',
      pending: 0.03,
      paid: 33.33,
      pendingCount: 2,
      oldestPendingDate: '2026-03-01',
    });
    expect(result.totals).toEqual({ pending: 0.03, paid: 33.33 });
  });

  it('filtro pending (padrão): só contatos com pendência e só splits pendentes na lista', () => {
    const result = buildReceivables({
      ...noLedger,
      status: 'pending',
      splits: [
        split({ splitId: 'a', assignedAmount: '20.00' }),
        split({ splitId: 'b', assignedAmount: '5.00', status: SplitStatus.PAID }),
        split({ splitId: 'q', contactId: 'c-bia', contactName: 'Bia', status: SplitStatus.PAID }),
      ],
      installments: [],
    });

    expect(result.contacts.map((c) => c.contactId)).toEqual(['c-ana']);
    expect(result.contacts[0].splits.map((s) => s.splitId)).toEqual(['a']);
    // somas do contato são históricas, independem do filtro da lista
    expect(result.contacts[0]).toMatchObject({ pending: 20, paid: 5 });
    expect(result.totals).toEqual({ pending: 20, paid: 5 });
  });

  it('filtro paid: contatos com algum split pago e lista só com pagos (com paidAt)', () => {
    const result = buildReceivables({
      ...noLedger,
      status: 'paid',
      splits: [
        split({ splitId: 'a' }),
        split({
          splitId: 'q',
          contactId: 'c-bia',
          contactName: 'Bia',
          status: SplitStatus.PAID,
          paidAt: '2026-03-02T00:00:00.000Z',
        }),
      ],
      installments: [],
    });

    expect(result.contacts.map((c) => c.contactId)).toEqual(['c-bia']);
    expect(result.contacts[0].splits).toEqual([
      expect.objectContaining({ splitId: 'q', status: 'paid', paidAt: '2026-03-02T00:00:00.000Z' }),
    ]);
    expect(result.contacts[0].oldestPendingDate).toBeNull();
  });

  it('ordena contatos por pendente desc, depois nome, depois id; splits por data asc, depois id', () => {
    const result = buildReceivables({
      ...noLedger,
      status: 'pending',
      splits: [
        split({ splitId: 'z', contactId: 'c-3', contactName: 'Carla', assignedAmount: '10.00' }),
        split({ splitId: 'y', contactId: 'c-2', contactName: 'Bruno', assignedAmount: '10.00' }),
        split({ splitId: 'x', contactId: 'c-1', contactName: 'Zé', assignedAmount: '50.00' }),
        split({
          splitId: 'b2',
          contactId: 'c-1',
          contactName: 'Zé',
          transactionDate: '2026-01-01',
        }),
        split({
          splitId: 'b1',
          contactId: 'c-1',
          contactName: 'Zé',
          transactionDate: '2026-01-01',
        }),
        split({
          splitId: 'a0',
          contactId: 'c-1',
          contactName: 'Zé',
          transactionDate: '2025-12-31',
        }),
      ],
      installments: [],
    });

    expect(result.contacts.map((c) => c.name)).toEqual(['Zé', 'Bruno', 'Carla']);
    expect(result.contacts[0].splits.map((s) => s.splitId)).toEqual(['a0', 'b1', 'b2', 'x']);
    expect(result.contacts[0].oldestPendingDate).toBe('2025-12-31');
  });

  it('split de compra no cartão: progresso pelo razão (status gravado ignorado); pix → null', () => {
    const result = buildReceivables({
      ...noLedger,
      status: 'pending',
      splits: [
        split({ splitId: 'card', transactionId: 't-card', assignedAmount: '600.00' }),
        split({ splitId: 'pix', transactionId: 't-pix', transactionDate: '2026-03-02' }),
      ],
      installments: [
        inst({ id: 'a', dueDate: '2026-02-05' }),
        inst({ id: 'b', dueDate: '2026-03-05', status: InstallmentStatus.PAID }),
        inst({ id: 'c', dueDate: '2026-05-05' }),
        inst({ id: 'd', dueDate: '2026-04-05' }),
        inst({ id: 'x', transactionId: 'outra', dueDate: '2026-01-01' }),
      ],
      installmentStates: new Map([
        ['a', state('paid', 100, 0)],
        ['b', state('overdue', 40, 60)], // gravada paid, mas só parcialmente coberta
        ['c', state('pending', 0, 100)],
        ['d', state('pending', 0, 100)],
      ]),
    });

    const [card, pix] = result.contacts[0].splits;
    expect(card.amount).toBe(600); // valor cheio, sem pro-rata
    expect(card.installments).toEqual({
      total: 4,
      paid: 1,
      remaining: 3,
      nextDueDate: '2026-03-05',
    });
    expect(pix.installments).toBeNull();
  });

  it('parcelas órfãs (compra de cartão removido) usam o status gravado (D18)', () => {
    const result = buildReceivables({
      ...noLedger,
      status: 'pending',
      splits: [split({ transactionId: 't-card' })],
      installments: [
        inst({ cardId: null, dueDate: '2026-02-05', status: InstallmentStatus.PAID }),
        inst({ cardId: null, dueDate: '2026-03-05', status: InstallmentStatus.OVERDUE }),
        inst({ cardId: null, dueDate: '2026-04-05' }),
      ],
    });
    expect(result.contacts[0].splits[0].installments).toEqual({
      total: 3,
      paid: 1,
      remaining: 2,
      nextDueDate: '2026-03-05',
    });
  });

  it('compra com todas as parcelas cobertas: remaining 0 e nextDueDate null', () => {
    const result = buildReceivables({
      ...noLedger,
      status: 'pending',
      splits: [split({ transactionId: 't-card' })],
      installments: [inst({ id: 'a' })],
      installmentStates: new Map([['a', state('paid', 100, 0)]]),
    });
    expect(result.contacts[0].splits[0].installments).toEqual({
      total: 1,
      paid: 1,
      remaining: 0,
      nextDueDate: null,
    });
  });

  it('sem splits: lista vazia e totais zerados', () => {
    expect(
      buildReceivables({
        ...noLedger,
        status: 'pending',
        splits: [],
        installments: [],
      }),
    ).toEqual({
      totals: { pending: 0, paid: 0 },
      contacts: [],
    });
  });
});
