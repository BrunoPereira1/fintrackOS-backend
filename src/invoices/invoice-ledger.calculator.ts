/**
 * Razão (ledger) do cartão — regras puras, sem I/O nem relógio implícito.
 * Regras em docs/specs/2026-11-24-modelo-de-pagamento.md §2 (D5, D6, D9–D11, D17, D20–D22, D24, D25).
 *
 * - Datas são strings `YYYY-MM-DD` e meses `YYYY-MM`, comparáveis lexicograficamente.
 * - Decimais chegam como `string | number` (Postgres) e toda conta é feita em centavos.
 * - Timestamps de ordenação (`transactionCreatedAt`, `createdAt`) entram **exclusivamente** como
 *   `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, microssegundos — D25; no SQL:
 *   `to_char(x AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`) e são comparados como
 *   string. Formato diferente lança `Error` (erro de programação, não de usuário).
 * - Fatura `M` = mês do vencimento. Item de dívida: parcela (mês de `dueDate`) ou encargo
 *   (`invoiceMonth`). `P` = Σ de todos os pagamentos; item coberto ⇔ soma acumulada ≤ `P`.
 * - "Fechada" e "vencida" usam sempre as **datas da fatura** (`invoiceDatesOf`), nunca as da
 *   parcela isolada (D25).
 */
import { addMonths, invoiceDates } from '../common/invoice-dates';
import { sumCents, toCents } from '../common/money';
import { LedgerInstallmentStatus, LedgerInvoiceStatus } from './invoice-status';

export interface LedgerCardInput {
  closingDay: number;
  dueDay: number;
  creditLimit: string | number;
}

export interface LedgerInstallmentInput {
  id: string;
  transactionId: string;
  /** `transactions.created_at` como `YYYY-MM-DDTHH:MM:SS.ffffffZ` (ordem de lançamento, D5). */
  transactionCreatedAt: string;
  number: number;
  amount: string | number;
  dueDate: string;
  closingDate: string;
}

export interface LedgerChargeInput {
  id: string;
  invoiceMonth: string;
  amount: string | number;
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  createdAt: string;
}

export interface LedgerPaymentInput {
  id: string;
  invoiceMonth: string;
  amount: string | number;
  /** `null` só para pagamento legado (D18). */
  paidOn: string | null;
}

export interface CardLedgerInput {
  card: LedgerCardInput;
  installments: readonly LedgerInstallmentInput[];
  charges: readonly LedgerChargeInput[];
  payments: readonly LedgerPaymentInput[];
  /** Data de calendário de hoje (`Clock.today()`), `YYYY-MM-DD`. */
  today: string;
}

interface LedgerItemBase {
  id: string;
  invoiceMonth: string;
  amountCents: number;
  coveredCents: number;
  remainingCents: number;
}

export interface LedgerInstallmentItem extends LedgerItemBase {
  kind: 'installment';
  transactionId: string;
  number: number;
  dueDate: string;
  closingDate: string;
}

export interface LedgerChargeItem extends LedgerItemBase {
  kind: 'charge';
  createdAt: string;
}

export type LedgerItem = LedgerInstallmentItem | LedgerChargeItem;

export interface InvoiceDates {
  closingDate: string;
  dueDate: string;
}

export interface CardLedger {
  today: string;
  card: { closingDay: number; dueDay: number; creditLimitCents: number };
  /** Itens de dívida na ordem FIFO (D5), com a cobertura alocada. */
  items: readonly LedgerItem[];
  payments: readonly LedgerPaymentInput[];
  /** Datas gravadas por mês de fatura com parcelas (maior em caso de divergência). */
  storedDates: ReadonlyMap<string, InvoiceDates>;
  /** `P`: Σ de todos os pagamentos. */
  paidCents: number;
  debtCents: number;
  outstandingCents: number;
  creditCents: number;
}

export interface LedgerItemState {
  status: LedgerInstallmentStatus;
  coveredAmount: number;
  remainingAmount: number;
}

export interface InvoiceView {
  month: string;
  closingDate: string;
  dueDate: string;
  status: LedgerInvoiceStatus;
  installmentsTotal: number;
  chargesTotal: number;
  paymentsTotal: number;
  coveredAmount: number;
  remaining: number;
  previousBalance: number;
  amountDue: number;
  installments: (LedgerItemState & {
    id: string;
    transactionId: string;
    number: number;
    amount: number;
    dueDate: string;
    closingDate: string;
  })[];
  charges: (LedgerItemState & { id: string; amount: number; createdAt: string })[];
  payments: { id: string; amount: number; paidOn: string | null; paidLate: boolean | null }[];
}

const fromCents = (cents: number) => cents / 100;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- validação de formato (D25) ----------

const TIMESTAMP_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertFormat(field: string, value: unknown, re: RegExp, expected: string): void {
  if (typeof value === 'string' && re.test(value)) return;
  const shown =
    typeof value === 'string' ? `"${value}"` : `${Object.prototype.toString.call(value)}`;
  throw new Error(`invoice-ledger: ${field} deve ser ${expected}; recebido ${shown}`);
}

const assertTimestamp = (field: string, v: unknown) =>
  assertFormat(field, v, TIMESTAMP_RE, 'string YYYY-MM-DDTHH:MM:SS.ffffffZ (UTC)');
const assertDate = (field: string, v: unknown) =>
  assertFormat(field, v, DATE_RE, 'string YYYY-MM-DD');
const assertMonth = (field: string, v: unknown) =>
  assertFormat(field, v, MONTH_RE, 'string YYYY-MM');

function validateInput(input: CardLedgerInput): void {
  assertDate('today', input.today);
  for (const i of input.installments) {
    assertTimestamp('installment.transactionCreatedAt', i.transactionCreatedAt);
    assertDate('installment.dueDate', i.dueDate);
    assertDate('installment.closingDate', i.closingDate);
  }
  for (const c of input.charges) {
    assertMonth('charge.invoiceMonth', c.invoiceMonth);
    assertTimestamp('charge.createdAt', c.createdAt);
  }
  for (const p of input.payments) {
    assertMonth('payment.invoiceMonth', p.invoiceMonth);
    if (p.paidOn !== null) assertDate('payment.paidOn', p.paidOn);
  }
}

// ---------- razão ----------

type UnallocatedItem =
  | Omit<LedgerInstallmentItem, 'coveredCents' | 'remainingCents'>
  | Omit<LedgerChargeItem, 'coveredCents' | 'remainingCents'>;

export function buildCardLedger(input: CardLedgerInput): CardLedger {
  validateInput(input);
  const { card, today } = input;

  const installments = [...input.installments]
    .map((i) => ({ ...i, invoiceMonth: i.dueDate.slice(0, 7) }))
    .sort(
      (a, b) =>
        compare(a.invoiceMonth, b.invoiceMonth) ||
        compare(a.transactionCreatedAt, b.transactionCreatedAt) ||
        compare(a.transactionId, b.transactionId) ||
        a.number - b.number,
    );
  const charges = [...input.charges].sort(
    (a, b) =>
      compare(a.invoiceMonth, b.invoiceMonth) ||
      compare(a.createdAt, b.createdAt) ||
      compare(a.id, b.id),
  );

  // Intercala por mês: no mesmo mês, parcelas antes dos encargos (D5)
  const ordered: UnallocatedItem[] = [];
  let c = 0;
  for (const i of installments) {
    while (c < charges.length && charges[c].invoiceMonth < i.invoiceMonth) {
      ordered.push(chargeItem(charges[c++]));
    }
    ordered.push({
      kind: 'installment',
      id: i.id,
      invoiceMonth: i.invoiceMonth,
      amountCents: toCents(i.amount),
      transactionId: i.transactionId,
      number: i.number,
      dueDate: i.dueDate,
      closingDate: i.closingDate,
    });
  }
  while (c < charges.length) ordered.push(chargeItem(charges[c++]));

  const paidCents = sumCents(input.payments, (p) => toCents(p.amount));
  let available = paidCents;
  const items = ordered.map((item): LedgerItem => {
    const coveredCents = Math.min(item.amountCents, available);
    available -= coveredCents;
    return { ...item, coveredCents, remainingCents: item.amountCents - coveredCents };
  });
  const debtCents = sumCents(items, (i) => i.amountCents);

  // Datas gravadas por mês; se divergirem (não deveria após D14), a maior de cada uma
  const storedDates = new Map<string, InvoiceDates>();
  for (const i of installments) {
    const prev = storedDates.get(i.invoiceMonth);
    storedDates.set(i.invoiceMonth, {
      closingDate: prev && prev.closingDate > i.closingDate ? prev.closingDate : i.closingDate,
      dueDate: prev && prev.dueDate > i.dueDate ? prev.dueDate : i.dueDate,
    });
  }

  return {
    today,
    card: {
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      creditLimitCents: toCents(card.creditLimit),
    },
    items,
    payments: input.payments,
    storedDates,
    paidCents,
    debtCents,
    outstandingCents: Math.max(debtCents - paidCents, 0),
    creditCents: Math.max(paidCents - debtCents, 0),
  };
}

function chargeItem(ch: LedgerChargeInput): UnallocatedItem {
  return {
    kind: 'charge',
    id: ch.id,
    invoiceMonth: ch.invoiceMonth,
    amountCents: toCents(ch.amount),
    createdAt: ch.createdAt,
  };
}

/** Dívida em aberto, crédito e limite disponível (D11: `creditLimit − dívida`, sem piso). */
export function cardBalance(ledger: CardLedger): {
  outstanding: number;
  credit: number;
  availableLimit: number | null;
} {
  const limit = ledger.card.creditLimitCents;
  return {
    outstanding: fromCents(ledger.outstandingCents),
    credit: fromCents(ledger.creditCents),
    // o crédito nunca eleva o limite acima de creditLimit
    availableLimit: limit === 0 ? null : fromCents(limit - ledger.outstandingCents),
  };
}

/**
 * Datas da fatura `month` (D25): as gravadas nas parcelas do mês (D14), a maior em caso de
 * divergência; sem parcelas, pelos dias atuais do cartão.
 */
export function invoiceDatesOf(ledger: CardLedger, month: string): InvoiceDates {
  return ledger.storedDates.get(month) ?? invoiceDates(month, ledger.card);
}

/** Status derivado (D6) e valores coberto/restante (D21) de um item, pelo vencimento da fatura. */
function itemState(ledger: CardLedger, item: LedgerItem): LedgerItemState {
  let status: LedgerInstallmentStatus;
  if (item.remainingCents === 0) status = 'paid';
  else if (invoiceDatesOf(ledger, item.invoiceMonth).dueDate < ledger.today) status = 'overdue';
  else status = 'pending';
  return {
    status,
    coveredAmount: fromCents(item.coveredCents),
    remainingAmount: fromCents(item.remainingCents),
  };
}

/** Status e valores de cada parcela do razão, por id (resumo, listagens, receivables). */
export function installmentStates(ledger: CardLedger): Map<string, LedgerItemState> {
  const map = new Map<string, LedgerItemState>();
  for (const item of ledger.items) {
    if (item.kind === 'installment') map.set(item.id, itemState(ledger, item));
  }
  return map;
}

const isClosed = (ledger: CardLedger, month: string) =>
  invoiceDatesOf(ledger, month).closingDate <= ledger.today;

/** Fatura aberta atual: o menor mês com `closingDate > hoje` (D9). */
export function currentOpenInvoiceMonth(ledger: CardLedger): string {
  // O fechamento da fatura M cai em M ou M−1, então começar em mês(hoje) − 1 é seguro.
  let month = addMonths(ledger.today.slice(0, 7), -1);
  while (isClosed(ledger, month)) month = addMonths(month, 1);
  return month;
}

/** D9: pagamento/encargo só em fatura já fechada ou na fatura aberta atual. */
export function acceptsInvoiceEntries(ledger: CardLedger, month: string): boolean {
  assertMonth('month', month);
  return isClosed(ledger, month) || month === currentOpenInvoiceMonth(ledger);
}

/** D20: alguma parcela da transação coberta (total ou parcialmente) em fatura já fechada. */
export function hasCoveredInstallmentInClosedInvoice(
  ledger: CardLedger,
  transactionId: string,
): boolean {
  return ledger.items.some(
    (i) =>
      i.kind === 'installment' &&
      i.transactionId === transactionId &&
      i.coveredCents > 0 &&
      isClosed(ledger, i.invoiceMonth),
  );
}

/**
 * D24: alguma parcela **recalculada** (fatura = mês do `dueDate`) cai em fatura já fechada?
 * Usa as datas da fatura de destino (D25) do razão atual.
 */
export function installmentsFallInClosedInvoice(
  ledger: CardLedger,
  recalculated: readonly { dueDate: string }[],
): boolean {
  return recalculated.some((i) => {
    assertDate('dueDate', i.dueDate);
    return isClosed(ledger, i.dueDate.slice(0, 7));
  });
}

/** Visão da fatura `month` (§2). */
export function buildInvoiceView(ledger: CardLedger, month: string): InvoiceView {
  assertMonth('month', month);
  const { today } = ledger;
  const { closingDate, dueDate } = invoiceDatesOf(ledger, month);
  const items = ledger.items.filter((i) => i.invoiceMonth === month);
  const installments = items.filter((i): i is LedgerInstallmentItem => i.kind === 'installment');
  const charges = items.filter((i): i is LedgerChargeItem => i.kind === 'charge');

  const remainingCents = sumCents(items, (i) => i.remainingCents);
  const coveredCents = sumCents(items, (i) => i.coveredCents);

  // D10: saldo anterior só depois que a fatura anterior venceu
  const previousDue = invoiceDatesOf(ledger, addMonths(month, -1)).dueDate;
  const previousBalanceCents =
    previousDue < today
      ? sumCents(
          ledger.items.filter((i) => i.invoiceMonth < month),
          (i) => i.remainingCents,
        )
      : 0;

  let status: LedgerInvoiceStatus;
  if (items.length > 0 && remainingCents === 0) status = 'paid';
  else if (today < closingDate) status = 'open';
  else if (today <= dueDate) status = 'closed';
  else if (items.length === 0) status = previousBalanceCents > 0 ? 'unpaid' : 'closed';
  else status = items.some((i) => i.coveredCents > 0) ? 'partially_paid' : 'unpaid';

  const payments = ledger.payments
    .filter((p) => p.invoiceMonth === month)
    .map((p) => ({
      id: p.id,
      amount: fromCents(toCents(p.amount)),
      paidOn: p.paidOn,
      paidLate: p.paidOn === null ? null : p.paidOn > dueDate,
    }))
    .sort((a, b) => compare(a.paidOn ?? '', b.paidOn ?? '') || compare(a.id, b.id));

  return {
    month,
    closingDate,
    dueDate,
    status,
    installmentsTotal: fromCents(sumCents(installments, (i) => i.amountCents)),
    chargesTotal: fromCents(sumCents(charges, (i) => i.amountCents)),
    paymentsTotal: fromCents(sumCents(payments, (p) => toCents(p.amount))),
    coveredAmount: fromCents(coveredCents),
    remaining: fromCents(remainingCents),
    previousBalance: fromCents(previousBalanceCents),
    amountDue: fromCents(previousBalanceCents + remainingCents),
    installments: installments.map((i) => ({
      id: i.id,
      transactionId: i.transactionId,
      number: i.number,
      amount: fromCents(i.amountCents),
      dueDate: i.dueDate,
      closingDate: i.closingDate,
      ...itemState(ledger, i),
    })),
    // Encargo vence com a fatura em que foi lançado
    charges: charges.map((ch) => ({
      id: ch.id,
      amount: fromCents(ch.amountCents),
      createdAt: ch.createdAt,
      ...itemState(ledger, ch),
    })),
    payments,
  };
}
