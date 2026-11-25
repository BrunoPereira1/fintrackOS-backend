import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MAX_MONEY } from '../../common/money-limits';

export class CreateSplitDto {
  @ApiProperty({
    example: '0b6c1a52-3a9e-4c55-8f0e-2f1f5a3e9c11',
    description: 'Contato do próprio usuário que deve esta parte',
  })
  @IsUUID()
  contactId!: string;

  @ApiProperty({ example: 75.5, minimum: 0.01, maximum: MAX_MONEY })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY)
  assignedAmount!: number;

  @ApiProperty({ example: '6f1c1d2e-8b8a-4c1e-9b1a-1a2b3c4d5e6f' })
  @IsUUID()
  transactionId!: string;

  @ApiPropertyOptional({
    example: '3d2c1b0a-9e8f-4a7b-8c6d-5e4f3a2b1c0d',
    description: 'Item da mesma transação (opcional)',
  })
  @IsOptional()
  @IsUUID()
  itemId?: string;
}
