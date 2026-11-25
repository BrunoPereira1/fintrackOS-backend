import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsNumber, IsOptional, Matches, Max, Min } from 'class-validator';
import { MAX_MONEY } from '../../common/money-limits';

export class CreateInvoicePaymentDto {
  @ApiProperty({ example: 1250.9, minimum: 0.01, maximum: MAX_MONEY })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY)
  amount!: number;

  /** Data de calendário do pagamento; padrão hoje, nunca depois de hoje (D7). */
  @ApiPropertyOptional({
    example: '2026-03-15',
    description: 'Data de calendário (YYYY-MM-DD), ≤ hoje. Padrão: hoje',
  })
  @IsOptional()
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'paidOn must be a calendar date in YYYY-MM-DD format',
  })
  paidOn?: string;
}
