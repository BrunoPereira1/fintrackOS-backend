/**
 * Status **gravado** da parcela (coluna `installments.status`). Arquivo folha, sem entities, para
 * regras puras (`installment-state.ts`, calculadoras) não importarem a entity (spec
 * 2026-11-24-modelo-de-pagamento §5). Reexportado por `entities/installment.entity.ts`.
 */
export enum InstallmentStatus {
  PENDING = 'pending',
  PAID = 'paid',
  OVERDUE = 'overdue',
}
