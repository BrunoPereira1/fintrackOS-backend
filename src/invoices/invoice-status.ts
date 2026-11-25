/**
 * Status derivados do razão do cartão (spec 2026-11-24-modelo-de-pagamento §2).
 * Arquivo folha: não importa entities, para poder ser usado por DTOs e calculadoras
 * de qualquer módulo sem criar dependência de domínio.
 */

/** Status derivado de uma parcela de cartão (D6/D21). */
export const LEDGER_INSTALLMENT_STATUSES = ['pending', 'paid', 'overdue'] as const;
export type LedgerInstallmentStatus = (typeof LEDGER_INSTALLMENT_STATUSES)[number];

/** Status derivado da fatura de um mês (§2, precedência paid → open → closed → partially_paid → unpaid). */
export const LEDGER_INVOICE_STATUSES = [
  'open',
  'closed',
  'paid',
  'partially_paid',
  'unpaid',
] as const;
export type LedgerInvoiceStatus = (typeof LEDGER_INVOICE_STATUSES)[number];
