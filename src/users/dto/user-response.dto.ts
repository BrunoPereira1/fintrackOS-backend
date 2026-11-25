import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Plan } from '../enums/plan.enum';
import { DocumentType } from '../enums/document-type.enum';
import { PreferredLanguage } from '../entities/user.entity';

export class UserResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty({ enum: Plan }) plan!: Plan;
  @ApiProperty({ enum: PreferredLanguage }) preferredLanguage!: PreferredLanguage;
  @ApiProperty({
    example: 'google.com',
    description: "Provider do primeiro login: 'password', 'google.com', 'apple.com'…",
  })
  authProvider!: string;
  @ApiPropertyOptional({ enum: DocumentType }) documentType!: DocumentType | null;
  @ApiPropertyOptional({
    example: '12345678909',
    description: 'Documento normalizado (somente dígitos para CPF/CNPJ)',
  })
  document!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
