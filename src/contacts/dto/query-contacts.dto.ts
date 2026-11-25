import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginationDto } from '../../common/dto/pagination.dto';

export class QueryContactsDto extends PaginationDto {
  @ApiPropertyOptional({
    example: 'joao',
    description: 'Filtra por parte do nome ou do e-mail (sem caixa)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  search?: string;
}
