import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, TransactionType } from '../entities/transaction.entity';

class TransactionItemResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty() unitPrice!: number;
}

export class TransactionResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() description!: string;
  @ApiProperty() totalAmount!: number;
  @ApiProperty() date!: Date;
  @ApiProperty({ enum: TransactionType }) type!: TransactionType;
  @ApiPropertyOptional() category?: string;
  @ApiProperty() userId!: string;
  @ApiPropertyOptional() cardId?: string | null;
  @ApiProperty({
    enum: PaymentMethod,
    example: PaymentMethod.PIX,
    nullable: true,
    description: 'null = transação legada sem forma informada',
  })
  paymentMethod!: PaymentMethod | null;
  @ApiProperty({ type: [TransactionItemResponseDto] }) items!: TransactionItemResponseDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
