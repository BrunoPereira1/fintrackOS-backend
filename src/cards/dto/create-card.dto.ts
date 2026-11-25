import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNumber, IsString, Max, Min, MaxLength, MinLength } from 'class-validator';
import { CardBrand } from '../entities/credit-card.entity';
import { MAX_MONEY } from '../../common/money-limits';

export class CreateCardDto {
  @ApiProperty({ example: 'Nubank Platinum' })
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @ApiProperty({ enum: CardBrand })
  @IsEnum(CardBrand)
  brand!: CardBrand;

  @ApiProperty({ example: 10, minimum: 1, maximum: 28 })
  @IsInt()
  @Min(1)
  @Max(28)
  closingDay!: number;

  @ApiProperty({ example: 17, minimum: 1, maximum: 28 })
  @IsInt()
  @Min(1)
  @Max(28)
  dueDay!: number;

  @ApiProperty({ example: 5000, minimum: 0, maximum: MAX_MONEY })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY)
  creditLimit!: number;
}
