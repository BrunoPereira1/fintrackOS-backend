/**
 * Regras puras de "quem me deve" — docs/knowledge/business-rules.md §6.
 * Sem I/O; datas como strings `YYYY-MM-DD`, decimais como string/number.
 */
import { SplitStatus } from '../splits/split-status.enum';
import { toCents } from '../common/money';
import { LedgerItemState } from '../invoices/invoice-ledger.calculator';
import { InstallmentStateRow, resolveInstallmentState } from '../installments/installment-state';

export type ReceivablesStatusFilter = 'pending' | 'paid' | 'all';

export interface ReceivableSplitRow {
  splitId: string;
  contactId: string;
  contactName: string;
  contactEmail: string | null;
  transactionId: string;
  description: string;
  transactionDate: string;
  assignedAmount: string | number;
  status: SplitStatus;
  /** ISO 8601 (timestamptz) ou null. */
  paidAt: string | null;
}

/** Parcela de uma compra com split; status gravado só vale para órfã (D18). */
export interface ReceivableInstallmentRow extends InstallmentStateRow {
  transactionId: string;
}

export interface InstallmentProgress {
  total: number;
  paid: number;
  remaining: number;
  nextDueDate: string | null;
}

const fromCents = (cents: number) => cents / 100;

function matchesFilter(status: SplitStatus, filter: ReceivablesStatusFilter): boolean {
  return filter === 'all' || status === (filter as string);
}

/** Progresso pelo status derivado: paga = totalmente coberta pelo razão (órfã: gravado). */
function installmentProgress(
  rows: readonly ReceivableInstallmentRow[] | undefined,
  states: ReadonlyMap<string, LedgerItemState>,
  today: string,
): InstallmentProgress | null {
  if (!rows?.length) return null; // pix/dinheiro: sem parcelas
  const unpaid = rows.filter((r) => resolveInstallmentState(r, states, today).status !== 'paid');
  const nextDueDate = unpaid.reduce<string | null>(
    (min, r) => (min === null || r.dueDate < min ? r.dueDate : min),
    null,
  );
  return {
    total: rows.length,
    paid: rows.length - unpaid.length,
    remaining: unpaid.length,
    nextDueDate,
  };
}

export function buildReceivables(input: {
  status: ReceivablesStatusFilter;
  splits: readonly ReceivableSplitRow[];
  installments: readonly ReceivableInstallmentRow[];
  installmentStates: ReadonlyMap<string, LedgerItemState>;
  today: string;
}) {
  const { status, splits, installments, installmentStates, today } = input;

  const installmentsByTx = new Map<string, ReceivableInstallmentRow[]>();
  for (const i of installments) {
    const list = installmentsByTx.get(i.transactionId) ?? [];
    list.push(i);
    installmentsByTx.set(i.transactionId, list);
  }

  const byContact = new Map<string, ReceivableSplitRow[]>();
  for (const s of splits) {
    const list = byContact.get(s.contactId) ?? [];
    list.push(s);
    byContact.set(s.contactId, list);
  }

  const contacts = [...byContact.values()]
    .map((rows) => {
      const pendingRows = rows.filter((r) => r.status === SplitStatus.PENDING);
      const pendingCents = pendingRows.reduce((acc, r) => acc + toCents(r.assignedAmount), 0);
      const paidCents = rows
        .filter((r) => r.status === SplitStatus.PAID)
        .reduce((acc, r) => acc + toCents(r.assignedAmount), 0);
      const listed = rows
        .filter((r) => matchesFilter(r.status, status))
        .sort(
          (a, b) =>
            a.transactionDate.localeCompare(b.transactionDate) ||
            a.splitId.localeCompare(b.splitId),
        );

      return {
        contactId: rows[0].contactId,
        name: rows[0].contactName,
        email: rows[0].contactEmail,
        pendingCents,
        paidCents,
        pendingCount: pendingRows.length,
        oldestPendingDate: pendingRows.map((r) => r.transactionDate).sort()[0] ?? null,
        splits: listed.map((r) => ({
          splitId: r.splitId,
          transactionId: r.transactionId,
          description: r.description,
          transactionDate: r.transactionDate,
          amount: fromCents(toCents(r.assignedAmount)),
          status: r.status,
          paidAt: r.paidAt,
          installments: installmentProgress(
            installmentsByTx.get(r.transactionId),
            installmentStates,
            today,
          ),
        })),
      };
    })
    // Contato aparece se tem split no filtro (pending: com algo pendente)
    .filter((c) => c.splits.length > 0)
    .sort(
      (a, b) =>
        b.pendingCents - a.pendingCents ||
        a.name.localeCompare(b.name, 'pt-BR') ||
        a.contactId.localeCompare(b.contactId),
    );

  const totals = contacts.reduce(
    (acc, c) => ({ pending: acc.pending + c.pendingCents, paid: acc.paid + c.paidCents }),
    { pending: 0, paid: 0 },
  );

  return {
    totals: { pending: fromCents(totals.pending), paid: fromCents(totals.paid) },
    contacts: contacts.map(({ pendingCents, paidCents, ...c }) => ({
      ...c,
      pending: fromCents(pendingCents),
      paid: fromCents(paidCents),
    })),
  };
}
