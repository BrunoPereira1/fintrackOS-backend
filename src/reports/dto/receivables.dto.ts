import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { ReceivablesStatusFilter } from '../receivables.calculator';

const STATUS_FILTERS: ReceivablesStatusFilter[] = ['pending', 'paid', 'all'];

export class ReceivablesQueryDto {
  @ApiPropertyOptional({ enum: STATUS_FILTERS, default: 'pending' })
  @IsOptional()
  @IsIn(STATUS_FILTERS)
  status: ReceivablesStatusFilter = 'pending';

  @ApiPropertyOptional({ format: 'uuid', description: 'Restringe a um contato' })
  @IsOptional()
  @IsUUID()
  contactId?: string;
}

/** Progresso pelo status derivado do razão (paga = totalmente coberta); órfã: gravado (D18). */
export class InstallmentProgressDto {
  @ApiProperty({ example: 6 }) total!: number;
  @ApiProperty({ example: 2, description: 'Parcelas totalmente cobertas' }) paid!: number;
  @ApiProperty({ example: 4, description: 'Parcelas não totalmente cobertas' })
  remaining!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    example: '2026-04-05',
    description: 'Menor vencimento entre as não totalmente cobertas',
  })
  nextDueDate!: string | null;
}

export class ReceivableSplitDto {
  @ApiProperty() splitId!: string;
  @ApiProperty() transactionId!: string;
  @ApiProperty() description!: string;
  @ApiProperty({ example: '2026-03-01' }) transactionDate!: string;
  @ApiProperty({ example: 600, description: 'Valor cheio do split' }) amount!: number;
  @ApiProperty({ enum: ['pending', 'paid'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, example: '2026-03-10T12:00:00.000Z' })
  paidAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: InstallmentProgressDto,
    description: 'Situação das parcelas da compra no cartão; null para pix/dinheiro',
  })
  installments!: InstallmentProgressDto | null;
}

export class ReceivableContactDto {
  @ApiProperty() contactId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) email!: string | null;
  @ApiProperty({ example: 150.5, description: 'Σ splits pendentes (histórico)' }) pending!: number;
  @ApiProperty({ example: 40, description: 'Σ splits pagos (histórico)' }) paid!: number;
  @ApiProperty({ example: 3 }) pendingCount!: number;
  @ApiProperty({ nullable: true, type: String, example: '2026-01-15' })
  oldestPendingDate!: string | null;
  @ApiProperty({ type: [ReceivableSplitDto], description: 'Splits conforme o filtro de status' })
  splits!: ReceivableSplitDto[];
}

export class ReceivablesTotalsDto {
  @ApiProperty() pending!: number;
  @ApiProperty() paid!: number;
}

export class ReceivablesResponseDto {
  @ApiProperty({ type: ReceivablesTotalsDto }) totals!: ReceivablesTotalsDto;
  @ApiProperty({ type: [ReceivableContactDto] }) contacts!: ReceivableContactDto[];
}
