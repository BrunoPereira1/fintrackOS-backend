import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { PreferredLanguage } from '../entities/user.entity';
import { DocumentType } from '../enums/document-type.enum';
import { IsValidDocument } from '../../common/validators/document.validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Bruno Silva' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({ enum: PreferredLanguage })
  @IsOptional()
  @IsEnum(PreferredLanguage)
  preferredLanguage?: PreferredLanguage;

  @ApiPropertyOptional({ enum: DocumentType, example: 'cpf' })
  @IsOptional()
  @IsEnum(DocumentType)
  documentType?: DocumentType;

  @ApiPropertyOptional({
    example: '123.456.789-09',
    description: 'CPF, CNPJ ou passaporte. Aceita com ou sem formatação.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @IsValidDocument()
  document?: string;
}
