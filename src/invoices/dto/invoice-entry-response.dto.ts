import { ApiProperty } from '@nestjs/swagger';
import { toCents } from '../../common/money';
import { InvoicePayment } from '../entities/invoice-payment.entity';
import { InvoiceCharge } from '../entities/invoice-charge.entity';

export class InvoicePaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() cardId!: string;
  @ApiProperty({ example: '2026-03' }) invoiceMonth!: string;
  @ApiProperty({ example: 1250.9 }) amount!: number;
  @ApiProperty({ example: '2026-03-15', nullable: true, type: String }) paidOn!: string | null;
  @ApiProperty() createdAt!: Date;

  static from(p: InvoicePayment): InvoicePaymentResponseDto {
    return {
      id: p.id,
      cardId: p.cardId,
      invoiceMonth: p.invoiceMonth,
      amount: toCents(p.amount) / 100,
      paidOn: p.paidOn,
      createdAt: p.createdAt,
    };
  }
}

export class InvoiceChargeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() cardId!: string;
  @ApiProperty({ example: '2026-03' }) invoiceMonth!: string;
  @ApiProperty({ example: 37.12 }) amount!: number;
  @ApiProperty({ example: 'Juros do rotativo', nullable: true, type: String })
  description!: string | null;
  @ApiProperty() createdAt!: Date;

  static from(c: InvoiceCharge): InvoiceChargeResponseDto {
    return {
      id: c.id,
      cardId: c.cardId,
      invoiceMonth: c.invoiceMonth,
      amount: toCents(c.amount) / 100,
      description: c.description,
      createdAt: c.createdAt,
    };
  }
}
