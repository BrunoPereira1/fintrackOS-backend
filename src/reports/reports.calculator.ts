/**
 * Regras puras das visões (fatura e resumo mensal) — sem I/O nem relógio implícito.
 * Regras em docs/knowledge/business-rules.md §5 (fatura) e §7 (resumo) e na spec
 * 2026-11-24-modelo-de-pagamento §2 (razão do cartão). Datas são strings `YYYY-MM-DD` e meses
 * `YYYY-MM`, comparáveis lexicograficamente.
 */
import { PaymentMethod } from '../transactions/payment-method.enum';
import { addMonths } from '../common/invoice-dates';
import { sumCents, toCents } from '../common/money';
import { InvoiceView, LedgerItemState } from '../invoices/invoice-ledger.calculator';
import { InstallmentStateRow, resolveInstallmentState } from '../installments/installment-state';

/** Dados descritivos de uma parcela da fatura (o razão só tem valores e datas). */
export interface InvoiceItemDetail {
  installmentId: string;
  description: string;
  category: string | null;
  purchaseDate: string;
  totalInstallments: number;
}

/** Parcela com vencimento no mês (status gravado só vale para órfã — D18). */
export interface SummaryInstallmentRow extends InstallmentStateRow {
  category: string | null;
  cardName: string | null;
}

/** Encargo de fatura (D3) de um cartão do usuário. */
export interface SummaryChargeRow {
  cardId: string;
  cardName: string | null;
  invoiceMonth: string;
  amount: string | number;
}

/** Pagamento de fatura; `paidOn` null = legado (D18), fora do `paidInMonth` (D22). */
export interface SummaryPaymentRow {
  amount: string | number;
  paidOn: string | null;
}

/** Transação à vista (sem parcelas) do mês. `paymentMethod` null = legado sem forma informada. */
export interface SummaryTransactionRow {
  totalAmount: string | number;
  category: string | null;
  paymentMethod: PaymentMethod | null;
}

const fromCents = (cents: number) => cents / 100;

export function monthRange(month: string): { start: string; endExclusive: string } {
  return { start: `${month}-01`, endExclusive: `${addMonths(month, 1)}-01` };
}

/** Timestamp do razão (`...ffffffZ`, microssegundos) → ISO 8601 com milissegundos. */
const toIsoMillis = (ts: string) => `${ts.slice(0, 23)}Z`;

/**
 * Fatura do mês (§2): a visão do razão (`buildInvoiceView`) com o cartão e os dados descritivos
 * das parcelas (descrição, categoria, data da compra, total de parcelas) e dos encargos.
 */
export function buildInvoice(input: {
  card: { id: string; name: string };
  view: InvoiceView;
  details: ReadonlyMap<string, InvoiceItemDetail>;
  chargeDescriptions: ReadonlyMap<string, string | null>;
}) {
  const { card, view, details, chargeDescriptions } = input;
  return {
    cardId: card.id,
    cardName: card.name,
    month: view.month,
    closingDate: view.closingDate,
    dueDate: view.dueDate,
    status: view.status,
    previousBalance: view.previousBalance,
    installmentsTotal: view.installmentsTotal,
    chargesTotal: view.chargesTotal,
    paymentsTotal: view.paymentsTotal,
    coveredAmount: view.coveredAmount,
    remaining: view.remaining,
    amountDue: view.amountDue,
    // Ordem FIFO do razão (ordem de lançamento): a parte coberta é um prefixo. Detalhe ausente
    // (não deveria: mesmo snapshot) vira null
    items: view.installments.map((i) => {
      const d = details.get(i.id);
      return {
        installmentId: i.id,
        transactionId: i.transactionId,
        description: d?.description ?? null,
        category: d?.category ?? null,
        purchaseDate: d?.purchaseDate ?? null,
        number: i.number,
        totalInstallments: d?.totalInstallments ?? null,
        amount: i.amount,
        dueDate: i.dueDate,
        closingDate: i.closingDate,
        status: i.status,
        coveredAmount: i.coveredAmount,
        remainingAmount: i.remainingAmount,
      };
    }),
    charges: view.charges.map((c) => ({
      id: c.id,
      amount: c.amount,
      description: chargeDescriptions.get(c.id) ?? null,
      createdAt: toIsoMillis(c.createdAt),
      status: c.status,
      coveredAmount: c.coveredAmount,
      remainingAmount: c.remainingAmount,
    })),
    payments: view.payments,
  };
}

/** Agrupa somando centavos e devolve ordenado do maior para o menor valor. */
function groupSum<K>(entries: readonly { key: K; cents: number }[]): { key: K; cents: number }[] {
  const map = new Map<K, number>();
  for (const e of entries) map.set(e.key, (map.get(e.key) ?? 0) + e.cents);
  return [...map.entries()]
    .map(([key, cents]) => ({ key, cents }))
    .sort((a, b) => b.cents - a.cents);
}

/**
 * Resumo do mês em regime de caixa (§7, D16, D21–D23):
 * - parcelas com vencimento no mês, com totais **por valor** derivado (coberto / não coberto /
 *   não coberto vencido) — de cartão pelo razão (`installmentStates`), órfã pelo gravado (D18);
 * - `cardCharges` = encargos lançados nas faturas do mês: entram em `spent` e `byCard`, não em
 *   `byCategory` (Σ byCategory = spent − cardCharges);
 * - `paidInMonth` (informativo) = pagamentos de fatura com `paidOn` no mês (legado null fora) +
 *   à vista do mês.
 */
export function buildMonthlySummary(input: {
  month: string;
  today: string;
  installments: readonly SummaryInstallmentRow[];
  installmentStates: ReadonlyMap<string, LedgerItemState>;
  charges: readonly SummaryChargeRow[];
  invoicePayments: readonly SummaryPaymentRow[];
  transactions: readonly SummaryTransactionRow[];
  /** Valores dos splits pendentes do mês; `null` quando o plano não inclui splits. */
  receivablesPending: readonly (string | number)[] | null;
}) {
  const { month, today, installments, transactions, receivablesPending } = input;
  const { start, endExclusive } = monthRange(month);
  const charges = input.charges.filter((c) => c.invoiceMonth === month);

  const cardCents = sumCents(installments, (i) => toCents(i.amount));
  const chargesCents = sumCents(charges, (c) => toCents(c.amount));
  const upfrontCents = sumCents(transactions, (t) => toCents(t.totalAmount));

  let paidCents = 0;
  let pendingCents = 0;
  let overdueCents = 0;
  for (const row of installments) {
    const s = resolveInstallmentState(row, input.installmentStates, today);
    const remaining = toCents(s.remainingAmount);
    paidCents += toCents(s.coveredAmount);
    pendingCents += remaining;
    if (s.status === 'overdue') overdueCents += remaining;
  }

  const invoicePaidCents = sumCents(
    input.invoicePayments.filter(
      (p) => p.paidOn !== null && p.paidOn >= start && p.paidOn < endExclusive,
    ),
    (p) => toCents(p.amount),
  );

  const byCategory = groupSum([
    ...installments.map((i) => ({ key: i.category, cents: toCents(i.amount) })),
    ...transactions.map((t) => ({ key: t.category, cents: toCents(t.totalAmount) })),
  ]).map((g) => ({ category: g.key, amount: fromCents(g.cents) }));

  // Só o que é pago à vista (sem parcelas): o cartão já aparece em cardInstallments/byCard
  const byPaymentMethod = groupSum(
    transactions.map((t) => ({ key: t.paymentMethod, cents: toCents(t.totalAmount) })),
  ).map((g) => ({ paymentMethod: g.key, amount: fromCents(g.cents) }));

  const cardNames = new Map<string | null, string | null>();
  for (const c of charges) cardNames.set(c.cardId, c.cardName);
  for (const i of installments) cardNames.set(i.cardId, i.cardName);
  const byCard = groupSum([
    ...installments.map((i) => ({ key: i.cardId, cents: toCents(i.amount) })),
    ...charges.map((c) => ({ key: c.cardId as string | null, cents: toCents(c.amount) })),
  ]).map((g) => ({
    cardId: g.key,
    cardName: cardNames.get(g.key) ?? null,
    amount: fromCents(g.cents),
  }));

  return {
    month,
    totals: {
      spent: fromCents(cardCents + chargesCents + upfrontCents),
      cardInstallments: fromCents(cardCents),
      cardCharges: fromCents(chargesCents),
      upfront: fromCents(upfrontCents),
    },
    installments: {
      paid: fromCents(paidCents),
      pending: fromCents(pendingCents),
      overdue: fromCents(overdueCents),
    },
    paidInMonth: fromCents(invoicePaidCents + upfrontCents),
    byCategory,
    byCard,
    byPaymentMethod,
    receivablesPending:
      receivablesPending === null
        ? null
        : fromCents(sumCents(receivablesPending, (v) => toCents(v))),
  };
}
