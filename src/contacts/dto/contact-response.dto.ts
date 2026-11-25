import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ContactResponseDto {
  @ApiProperty({ example: '0b6c1a52-3a9e-4c55-8f0e-2f1f5a3e9c11' }) id!: string;
  @ApiProperty({ example: 'João Silva' }) name!: string;
  @ApiPropertyOptional({ type: String, nullable: true, example: 'joao@email.com' })
  email!: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, example: '+55 11 91234-5678' })
  phone!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedContactsResponseDto {
  @ApiProperty({ type: [ContactResponseDto] }) data!: ContactResponseDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
