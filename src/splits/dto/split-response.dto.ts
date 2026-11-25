import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SplitStatus } from '../entities/cost-split.entity';

export class SplitContactDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) email!: string | null;
}

export class SplitResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() contactId!: string;
  @ApiProperty({ type: SplitContactDto }) contact!: SplitContactDto;
  @ApiProperty() assignedAmount!: number;
  @ApiProperty({ enum: SplitStatus }) status!: SplitStatus;
  @ApiPropertyOptional({ type: Date, nullable: true }) paidAt!: Date | null;
  @ApiProperty() transactionId!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) itemId!: string | null;
}
