import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaymentMethod, TransactionType } from '../entities/transaction.entity';
import { MAX_ITEM_QUANTITY, MAX_MONEY } from '../../common/money-limits';

export class CreateTransactionItemDto {
  @ApiProperty({ example: 'Arroz 5kg' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiProperty({ example: 2, default: 1, minimum: 1, maximum: MAX_ITEM_QUANTITY })
  @IsInt()
  @Min(1)
  @Max(MAX_ITEM_QUANTITY)
  quantity: number = 1;

  @ApiProperty({ example: 24.9, minimum: 0, maximum: MAX_MONEY })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY)
  unitPrice!: number;
}

export class CreateTransactionDto {
  @ApiProperty({ example: 'Supermercado Extra' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  description!: string;

  @ApiProperty({ example: 250.9, minimum: 0.01, maximum: MAX_MONEY })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY)
  totalAmount!: number;

  /** Data de calendário, sem hora nem fuso (hora/fuso deslocariam o dia e a fatura). */
  @ApiProperty({ example: '2026-04-01', description: 'Data de calendário (YYYY-MM-DD)' })
  @IsDateString({ strict: true })
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'date must be a calendar date in YYYY-MM-DD format',
  })
  date!: string;

  @ApiProperty({ enum: TransactionType })
  @IsEnum(TransactionType)
  type!: TransactionType;

  @ApiPropertyOptional({ example: 'Alimentação' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  category?: string;

  @ApiPropertyOptional({ example: '9a3f2c1d-4b5e-4f60-8a7b-1c2d3e4f5a6b' })
  @IsOptional()
  @IsUUID()
  cardId?: string;

  /** Com cartão: omitido ⇒ credit_card (outro valor → 422). Sem cartão: omitido ⇒ pix. */
  @ApiPropertyOptional({
    enum: PaymentMethod,
    example: PaymentMethod.PIX,
    description:
      'Com cardId: credit_card (padrão). Sem cardId: pix (padrão), cash, debit, transfer ou boleto',
  })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  /** Validado sempre que presente; "> 1 sem cartão" é regra de negócio (422 no service). */
  @ApiPropertyOptional({ example: 3, minimum: 1, maximum: 48 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(48)
  installmentsCount?: number;

  @ApiPropertyOptional({ type: [CreateTransactionItemDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateTransactionItemDto)
  items?: CreateTransactionItemDto[];
}
