import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';

export class CardInvoiceParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  cardId!: string;

  @ApiProperty({ example: '2026-03', description: 'Mês da fatura (vencimento), YYYY-MM' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be in the format YYYY-MM' })
  month!: string;
}

export class CardInvoiceEntryParamsDto extends CardInvoiceParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  id!: string;
}
