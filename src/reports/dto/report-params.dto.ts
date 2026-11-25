import { ApiProperty } from '@nestjs/swagger';
import { IsUUID, Matches } from 'class-validator';

const MONTH_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_MESSAGE = 'month must be in the format YYYY-MM';

export class MonthParamDto {
  @ApiProperty({ example: '2026-03', description: 'Mês no formato YYYY-MM' })
  @Matches(MONTH_REGEX, { message: MONTH_MESSAGE })
  month!: string;
}

export class InvoiceParamsDto extends MonthParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  cardId!: string;
}
