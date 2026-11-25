import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { DocumentType } from '../../users/enums/document-type.enum';
import { IsValidDocument } from '../../common/validators/document.validator';

export class RegisterDto {
  @ApiProperty({ example: 'bruno@exemplo.com' })
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiProperty({ example: 'Senha@123', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;

  @ApiPropertyOptional({ example: 'Bruno Silva' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  displayName?: string;

  @ApiProperty({ enum: DocumentType, example: 'cpf' })
  @IsEnum(DocumentType)
  documentType!: DocumentType;

  @ApiProperty({
    example: '123.456.789-09',
    description: 'CPF, CNPJ ou passaporte. Aceita com ou sem formatação.',
  })
  @IsString()
  @MaxLength(32)
  @IsValidDocument()
  document!: string;
}
