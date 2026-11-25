/**
 * Forma de pagamento (business-rules §4). Só `credit_card` gera parcelas/fatura; as demais são
 * à vista, pagas na data da compra. Arquivo folha (sem entities) para regras puras; reexportado
 * por `entities/transaction.entity.ts`.
 */
export enum PaymentMethod {
  CREDIT_CARD = 'credit_card',
  PIX = 'pix',
  CASH = 'cash',
  DEBIT = 'debit',
  TRANSFER = 'transfer',
  BOLETO = 'boleto',
}
