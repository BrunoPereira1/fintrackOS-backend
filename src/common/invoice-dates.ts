/**
 * Datas de fatura de cartão — regra pura (docs/knowledge/business-rules.md §5).
 * Fatura `YYYY-MM` = mês do **vencimento**. Datas são strings `YYYY-MM-DD`.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM` → mês absoluto (ano*12 + mês 0–11). */
function absMonth(month: string): number {
  const [year, m] = month.split('-').map(Number);
  return year * 12 + m - 1;
}

function monthOf(abs: number): string {
  return `${Math.floor(abs / 12)}-${pad((abs % 12) + 1)}`;
}

/** Soma `delta` meses a `YYYY-MM` (atravessa o ano). */
export function addMonths(month: string, delta: number): string {
  return monthOf(absMonth(month) + delta);
}

/**
 * Datas da fatura que **vence** em `month` pelos dias **atuais** do cartão: fecha no mesmo
 * mês quando `dueDay > closingDay`, senão no mês anterior (ex.: fecha 25, vence 5).
 * Dias do cartão são 1–28 (DTO), então a data sempre existe.
 */
export function invoiceDates(
  month: string,
  card: { closingDay: number; dueDay: number },
): { closingDate: string; dueDate: string } {
  const due = absMonth(month);
  const closing = card.dueDay > card.closingDay ? due : due - 1;
  return {
    closingDate: `${monthOf(closing)}-${pad(card.closingDay)}`,
    dueDate: `${monthOf(due)}-${pad(card.dueDay)}`,
  };
}
