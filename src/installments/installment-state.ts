/**
 * Status de parcela para as visões (fatura, resumo, "quem me deve", listagem) — regra pura.
 * Spec 2026-11-24-modelo-de-pagamento §2, D6, D18, D21, D25:
 * - parcela de **cartão**: status e valores derivados do razão (`installmentStates`);
 * - parcela **órfã legada** (transação sem cartão): status **gravado** (D18), com `pending`
 *   vencida exibida como `overdue` (D6); valor coberto = tudo (paga) ou nada.
 */
import { InstallmentStatus } from './installment-status.enum';
import {
  CardLedger,
  installmentStates,
  LedgerItemState,
} from '../invoices/invoice-ledger.calculator';
import { toCents } from '../common/money';

export interface StoredInstallmentRow {
  status: InstallmentStatus;
  amount: string | number;
  /** `YYYY-MM-DD`. */
  dueDate: string;
}

export interface InstallmentStateRow extends StoredInstallmentRow {
  id: string;
  /** `null` = parcela órfã (transação sem cartão). */
  cardId: string | null;
}

/** D18: órfã legada usa o status gravado; `pending` com vencimento antes de hoje → `overdue`. */
export function orphanInstallmentState(row: StoredInstallmentRow, today: string): LedgerItemState {
  const amount = toCents(row.amount) / 100;
  if (row.status === InstallmentStatus.PAID) {
    return { status: 'paid', coveredAmount: amount, remainingAmount: 0 };
  }
  const overdue = row.status === InstallmentStatus.OVERDUE || row.dueDate < today;
  return { status: overdue ? 'overdue' : 'pending', coveredAmount: 0, remainingAmount: amount };
}

/**
 * Status de qualquer parcela: de cartão pelo razão (`states`, de `installmentStates`), órfã
 * pelo gravado. Parcela de cartão ausente do razão (não deveria acontecer: as leituras usam o
 * mesmo snapshot) conta como não coberta.
 */
export function resolveInstallmentState(
  row: InstallmentStateRow,
  states: ReadonlyMap<string, LedgerItemState>,
  today: string,
): LedgerItemState {
  if (row.cardId === null) return orphanInstallmentState(row, today);
  const state = states.get(row.id);
  if (state) return state;
  const amount = toCents(row.amount) / 100;
  return {
    status: row.dueDate < today ? 'overdue' : 'pending',
    coveredAmount: 0,
    remainingAmount: amount,
  };
}

/** Une os estados de parcela de vários razões (um por cartão). */
export function mergeInstallmentStates(
  ledgers: Iterable<CardLedger>,
): Map<string, LedgerItemState> {
  const merged = new Map<string, LedgerItemState>();
  for (const ledger of ledgers) for (const [id, s] of installmentStates(ledger)) merged.set(id, s);
  return merged;
}

export interface CoverageThreshold {
  cardId: string;
  /** Mês da fatura (`YYYY-MM`) da última parcela totalmente coberta. */
  month: string;
  transactionId: string;
  number: number;
}

/**
 * Parâmetros para derivar o status no SQL da listagem (`GET /installments`), sem carregar as
 * parcelas no service: por cartão, as parcelas **totalmente cobertas** formam um prefixo da
 * ordem FIFO (§2), então basta o limiar = chave `(mês, transação, número)` da última delas
 * (a ordem completa usa também `transactions.created_at`, lido no SQL). `pastDue` = meses de
 * fatura com vencimento (datas da fatura, D25) antes de hoje — parcela não coberta neles é
 * `overdue`.
 */
export function listingCoverage(ledgers: ReadonlyMap<string, CardLedger>): {
  covered: CoverageThreshold[];
  pastDue: { cardId: string; month: string }[];
} {
  const covered: CoverageThreshold[] = [];
  const pastDue: { cardId: string; month: string }[] = [];
  for (const [cardId, ledger] of ledgers) {
    let last: CoverageThreshold | undefined;
    for (const item of ledger.items) {
      if (item.kind !== 'installment') continue;
      if (item.remainingCents > 0) break; // fim do prefixo coberto
      last = {
        cardId,
        month: item.invoiceMonth,
        transactionId: item.transactionId,
        number: item.number,
      };
    }
    if (last) covered.push(last);
    for (const [month, dates] of [...ledger.storedDates].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (dates.dueDate < ledger.today) pastDue.push({ cardId, month });
    }
  }
  return { covered, pastDue };
}
