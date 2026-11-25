import { ApiProperty } from '@nestjs/swagger';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsString,
  Max,
  Min,
  MaxLength,
  MinLength,
} from 'class-validator';
import { AssetType } from '../entities/asset.entity';
import { MAX_ASSET_DECIMAL } from '../../common/money-limits';

export class CreateAssetDto {
  @ApiProperty({ example: 'PETR4' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiProperty({ enum: AssetType })
  @IsEnum(AssetType)
  type!: AssetType;

  @ApiProperty({ example: 37.42, minimum: 0, maximum: MAX_ASSET_DECIMAL })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(MAX_ASSET_DECIMAL)
  averagePrice!: number;

  @ApiProperty({ example: 100, minimum: 0, maximum: MAX_ASSET_DECIMAL })
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(MAX_ASSET_DECIMAL)
  currentQuantity!: number;

  @ApiProperty({ example: '2026-01-15' })
  @IsDateString()
  acquisitionDate!: string;
}
