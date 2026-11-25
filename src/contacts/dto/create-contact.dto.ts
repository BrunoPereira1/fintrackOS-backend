import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateContactDto {
  @ApiProperty({ example: 'João Silva' })
  @IsString()
  @Matches(/\S/, { message: 'name must not be blank' })
  @MaxLength(255)
  name!: string;

  @ApiPropertyOptional({ example: 'joao@email.com', description: 'Único por usuário (sem caixa)' })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({ example: '+55 11 91234-5678' })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;
}
