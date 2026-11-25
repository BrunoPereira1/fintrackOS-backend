import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MAX_MONEY } from '../../common/money-limits';

export class CreateInvoiceChargeDto {
  @ApiProperty({ example: 37.12, minimum: 0.01, maximum: MAX_MONEY })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY)
  amount!: number;

  /** Texto livre do usuário (juros, IOF, multa...). Nunca vai para log. */
  @ApiPropertyOptional({ example: 'Juros do rotativo', maxLength: 255 })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
