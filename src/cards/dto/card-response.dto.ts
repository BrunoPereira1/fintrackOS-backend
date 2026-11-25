import { ApiProperty } from '@nestjs/swagger';
import { CardBrand } from '../entities/credit-card.entity';

export class CardResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: CardBrand }) brand!: CardBrand;
  @ApiProperty() closingDay!: number;
  @ApiProperty() dueDay!: number;
  @ApiProperty() creditLimit!: number;
  @ApiProperty() userId!: string;
  /** Data de arquivamento (D12); `null` = ativo. */
  @ApiProperty({ nullable: true, type: Date }) archivedAt!: Date | null;
  /** Dívida em aberto do cartão (Σ itens não cobertos do razão, D11). */
  @ApiProperty({ example: 1250.9 }) outstanding!: number;
  /** Crédito (pago a maior), separado do limite (D11). */
  @ApiProperty({ example: 0 }) credit!: number;
  /** `creditLimit − outstanding` (nunca acima do limite); `null` quando `creditLimit = 0` (D11). */
  @ApiProperty({ example: 3749.1, nullable: true, type: Number }) availableLimit!: number | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
