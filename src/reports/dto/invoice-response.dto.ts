import { ApiProperty } from '@nestjs/swagger';
import {
  LEDGER_INSTALLMENT_STATUSES,
  LEDGER_INVOICE_STATUSES,
  LedgerInstallmentStatus,
  LedgerInvoiceStatus,
} from '../../invoices/invoice-status';

const ITEM_STATUS_DESCRIPTION =
  'Derivado do razão: paid = totalmente coberto pelos pagamentos (FIFO); overdue = não ' +
  'totalmente coberto e vencimento da fatura antes de hoje; senão pending';

export class InvoiceItemDto {
  @ApiProperty() installmentId!: string;
  @ApiProperty() transactionId!: string;
  @ApiProperty({ example: 'Geladeira', nullable: true, type: String })
  description!: string | null;
  @ApiProperty({ nullable: true, type: String }) category!: string | null;
  @ApiProperty({ example: '2026-02-10', nullable: true, type: String })
  purchaseDate!: string | null;
  @ApiProperty({ example: 2 }) number!: number;
  @ApiProperty({ example: 10, nullable: true, type: Number }) totalInstallments!: number | null;
  @ApiProperty({ example: 120.5 }) amount!: number;
  @ApiProperty({ example: '2026-03-05' }) dueDate!: string;
  @ApiProperty({ example: '2026-02-25' }) closingDate!: string;
  @ApiProperty({ enum: LEDGER_INSTALLMENT_STATUSES, description: ITEM_STATUS_DESCRIPTION })
  status!: LedgerInstallmentStatus;
  @ApiProperty({ example: 100, description: 'Parte coberta pelos pagamentos (D21)' })
  coveredAmount!: number;
  @ApiProperty({ example: 20.5, description: 'Parte ainda não coberta (D21)' })
  remainingAmount!: number;
}

export class InvoiceChargeItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 37.12 }) amount!: number;
  @ApiProperty({ example: 'Juros do rotativo', nullable: true, type: String })
  description!: string | null;
  @ApiProperty({ example: '2026-03-12T09:30:00.654Z' }) createdAt!: string;
  @ApiProperty({ enum: LEDGER_INSTALLMENT_STATUSES, description: ITEM_STATUS_DESCRIPTION })
  status!: LedgerInstallmentStatus;
  @ApiProperty({ example: 0 }) coveredAmount!: number;
  @ApiProperty({ example: 37.12 }) remainingAmount!: number;
}

export class InvoicePaymentItemDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 500 }) amount!: number;
  @ApiProperty({
    example: '2026-03-18',
    nullable: true,
    type: String,
    description: 'null = pagamento legado migrado (D18)',
  })
  paidOn!: string | null;
  @ApiProperty({
    nullable: true,
    type: Boolean,
    description: 'paidOn depois do vencimento desta fatura (informativo); null no legado',
  })
  paidLate!: boolean | null;
}

export class InvoiceResponseDto {
  @ApiProperty() cardId!: string;
  @ApiProperty() cardName!: string;
  @ApiProperty({ example: '2026-03', description: 'Mês do vencimento' }) month!: string;
  @ApiProperty({ example: '2026-02-25' }) closingDate!: string;
  @ApiProperty({ example: '2026-03-05' }) dueDate!: string;
  @ApiProperty({
    enum: LEDGER_INVOICE_STATUSES,
    description:
      'paid (tem itens, todos cobertos) → open (antes do fechamento) → closed (até o ' +
      'vencimento) → partially_paid (vencida com algo coberto) → unpaid (vencida sem nada coberto)',
  })
  status!: LedgerInvoiceStatus;
  @ApiProperty({
    example: 0,
    description: 'Σ não coberto das faturas anteriores; só depois do vencimento da anterior (D10)',
  })
  previousBalance!: number;
  @ApiProperty({ example: 1250.9, description: 'Σ parcelas do mês' }) installmentsTotal!: number;
  @ApiProperty({ example: 37.12, description: 'Σ encargos do mês' }) chargesTotal!: number;
  @ApiProperty({ example: 500, description: 'Σ pagamentos lançados nesta fatura' })
  paymentsTotal!: number;
  @ApiProperty({ example: 500, description: 'Σ coberto dos itens do mês' })
  coveredAmount!: number;
  @ApiProperty({ example: 788.02, description: 'Σ não coberto dos itens do mês' })
  remaining!: number;
  @ApiProperty({ example: 788.02, description: 'previousBalance + remaining' })
  amountDue!: number;
  @ApiProperty({ type: [InvoiceItemDto], description: 'Parcelas na ordem de alocação (FIFO)' })
  items!: InvoiceItemDto[];
  @ApiProperty({ type: [InvoiceChargeItemDto] }) charges!: InvoiceChargeItemDto[];
  @ApiProperty({ type: [InvoicePaymentItemDto] }) payments!: InvoicePaymentItemDto[];
}
