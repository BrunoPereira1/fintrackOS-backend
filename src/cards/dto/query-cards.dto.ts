import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

// Sem PaginationDto de propósito: GET /cards nunca foi paginado (poucos cartões por usuário) e
// paginar mudaria o contrato — exceção registrada em docs/knowledge/patterns.md
export class QueryCardsDto {
  /** Inclui cartões arquivados (D12). */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  // Query string chega como texto; outro valor que não 'true'/'false' falha no @IsBoolean (400)
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  includeArchived?: boolean;
}
