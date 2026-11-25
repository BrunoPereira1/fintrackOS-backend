import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { InstallmentStatus } from '../installment-status.enum';

/** Só para parcela órfã legada (D18); parcela de cartão → 422 (pagamento é da fatura). */
export class UpdateInstallmentDto {
  @ApiProperty({ enum: InstallmentStatus, example: InstallmentStatus.PAID })
  @IsEnum(InstallmentStatus)
  status!: InstallmentStatus;
}
