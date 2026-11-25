import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsIn, IsOptional, IsUUID } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import {
  LEDGER_INSTALLMENT_STATUSES,
  LedgerInstallmentStatus,
} from '../../invoices/invoice-status';

export class QueryInstallmentsDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: LEDGER_INSTALLMENT_STATUSES,
    description: 'Filtra pelo status derivado (cartão: razão da fatura; órfã: gravado)',
  })
  @IsOptional()
  @IsIn(LEDGER_INSTALLMENT_STATUSES)
  status?: LedgerInstallmentStatus;

  @ApiPropertyOptional({ example: '2026-03-01' })
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-03-31' })
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @ApiPropertyOptional({ format: 'uuid', example: '3f1c2a9e-8b7d-4c6e-9a1b-2d3e4f5a6b7c' })
  @IsOptional()
  @IsUUID()
  cardId?: string;
}
