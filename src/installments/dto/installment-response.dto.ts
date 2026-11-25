import { ApiProperty } from '@nestjs/swagger';
import {
  LEDGER_INSTALLMENT_STATUSES,
  LedgerInstallmentStatus,
} from '../../invoices/invoice-status';

export class InstallmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 2 }) number!: number;
  @ApiProperty({ example: 10 }) totalInstallments!: number;
  @ApiProperty({ example: 120.5 }) amount!: number;
  @ApiProperty({ example: '2026-03-17' }) dueDate!: string;
  @ApiProperty({ example: '2026-03-10', description: 'Fechamento da fatura da parcela' })
  closingDate!: string;
  @ApiProperty() transactionId!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'null = parcela órfã legada (cartão removido antes do arquivamento)',
  })
  cardId!: string | null;
  @ApiProperty({
    enum: LEDGER_INSTALLMENT_STATUSES,
    description:
      'Derivado: parcela de cartão pelo razão da fatura (paid = totalmente coberta; overdue = ' +
      'não coberta e fatura vencida); órfã legada pelo status gravado (pending vencida → overdue)',
  })
  status!: LedgerInstallmentStatus;
  @ApiProperty({ example: 100, description: 'Parte coberta pelos pagamentos de fatura' })
  coveredAmount!: number;
  @ApiProperty({ example: 20.5, description: 'Parte ainda não coberta' })
  remainingAmount!: number;
}

export class PaginatedInstallmentsResponseDto {
  @ApiProperty({ type: [InstallmentResponseDto] }) data!: InstallmentResponseDto[];
  @ApiProperty({ example: 42 }) total!: number;
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
}
