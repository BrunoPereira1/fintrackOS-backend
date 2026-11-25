import { ApiProperty } from '@nestjs/swagger';
import { PaymentMethod } from '../../transactions/entities/transaction.entity';

export class SummaryTotalsDto {
  @ApiProperty({
    example: 2362.74,
    description: 'Parcelas de cartão do mês + encargos do mês + à vista do mês',
  })
  spent!: number;
  @ApiProperty({ example: 1800, description: 'Parcelas de cartão com vencimento no mês' })
  cardInstallments!: number;
  @ApiProperty({
    example: 12.34,
    description: 'Encargos (juros/IOF/multa) lançados nas faturas do mês; fora de byCategory',
  })
  cardCharges!: number;
  @ApiProperty({
    example: 550.4,
    description:
      'Transações à vista (sem parcelas: pix, dinheiro, débito, transferência, boleto ou ' +
      'legado sem forma), pagas na data da compra',
  })
  upfront!: number;
}

/** Parcelas do mês por **valor** derivado (D21): parcialmente coberta conta nas duas partes. */
export class SummaryInstallmentsDto {
  @ApiProperty({ example: 900, description: 'Σ parte coberta pelos pagamentos de fatura' })
  paid!: number;
  @ApiProperty({ example: 900, description: 'Σ parte não coberta (inclui a vencida)' })
  pending!: number;
  @ApiProperty({ example: 0, description: 'Σ parte não coberta com vencimento antes de hoje' })
  overdue!: number;
}

export class CategoryAmountDto {
  @ApiProperty({ nullable: true, type: String, example: 'Mercado' }) category!: string | null;
  @ApiProperty({ example: 420.3 }) amount!: number;
}

export class CardAmountDto {
  @ApiProperty({ nullable: true, type: String, description: 'null = cartão removido' })
  cardId!: string | null;
  @ApiProperty({ nullable: true, type: String }) cardName!: string | null;
  @ApiProperty({ example: 980 }) amount!: number;
}

export class PaymentMethodAmountDto {
  @ApiProperty({
    enum: PaymentMethod,
    example: PaymentMethod.PIX,
    nullable: true,
    description: 'null = forma não informada (transação legada)',
  })
  paymentMethod!: PaymentMethod | null;
  @ApiProperty({ example: 320.5 }) amount!: number;
}

export class MonthlySummaryResponseDto {
  @ApiProperty({ example: '2026-03' }) month!: string;
  @ApiProperty({ type: SummaryTotalsDto }) totals!: SummaryTotalsDto;
  @ApiProperty({ type: SummaryInstallmentsDto }) installments!: SummaryInstallmentsDto;
  @ApiProperty({
    example: 1550.4,
    description:
      'Informativo: pagamentos de fatura com paidOn no mês (legado sem data fica fora) + à vista',
  })
  paidInMonth!: number;
  @ApiProperty({
    type: [CategoryAmountDto],
    description: 'Parcelas + à vista por categoria (Σ = spent − cardCharges)',
  })
  byCategory!: CategoryAmountDto[];
  @ApiProperty({ type: [CardAmountDto], description: 'Parcelas + encargos do mês por cartão' })
  byCard!: CardAmountDto[];
  @ApiProperty({
    type: [PaymentMethodAmountDto],
    description: 'Transações à vista do mês por forma de pagamento, do maior valor (Σ = upfront)',
  })
  byPaymentMethod!: PaymentMethodAmountDto[];
  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Splits pendentes das transações do mês (somente plano premium; senão null)',
  })
  receivablesPending!: number | null;
}
