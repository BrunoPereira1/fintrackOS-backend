import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Não estende `PaginationDto`: a lista é sempre limitada aos splits de uma única transação
 * (Σ splits ≤ total da transação), então não cresce sem limite.
 */
export class QuerySplitsDto {
  @ApiProperty({
    format: 'uuid',
    example: '2b0d1c1e-8f1a-4c39-9d6e-0e0f7c2a9b11',
    description: 'Transação cujos splits serão listados',
  })
  @IsUUID()
  transactionId!: string;
}
