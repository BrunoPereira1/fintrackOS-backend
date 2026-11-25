import { ApiProperty } from '@nestjs/swagger';
import { AssetType, AssetStatus } from '../entities/asset.entity';

export class AssetResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: AssetType }) type!: AssetType;
  @ApiProperty({ enum: AssetStatus }) status!: AssetStatus;
  @ApiProperty() averagePrice!: number;
  @ApiProperty() currentQuantity!: number;
  @ApiProperty() acquisitionDate!: Date;
  @ApiProperty() userId!: string;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
