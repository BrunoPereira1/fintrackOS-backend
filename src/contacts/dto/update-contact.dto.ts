import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsString, Matches, MaxLength, ValidateIf } from 'class-validator';
import { CreateContactDto } from './create-contact.dto';

export class UpdateContactDto extends PartialType(OmitType(CreateContactDto, ['name'] as const)) {
  // `name` é NOT NULL: no PATCH pode faltar, mas `null` precisa falhar (o @IsOptional do
  // PartialType deixaria passar). `email`/`phone` aceitam null para limpar o campo.
  @ApiPropertyOptional({ example: 'João Silva' })
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Matches(/\S/, { message: 'name must not be blank' })
  @MaxLength(255)
  name?: string;
}
