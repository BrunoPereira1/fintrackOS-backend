import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { SplitStatus } from '../entities/cost-split.entity';

export class UpdateSplitDto {
  @ApiProperty({ enum: SplitStatus })
  @IsEnum(SplitStatus)
  status!: SplitStatus;
}
