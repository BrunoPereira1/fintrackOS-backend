import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TierGuard } from '../auth/guards/tier.guard';
import { RequiresTier } from '../auth/decorators/requires-tier.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Plan } from '../users/enums/plan.enum';
import { User } from '../users/entities/user.entity';
import { AssetsService } from './assets.service';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { AssetResponseDto } from './dto/asset-response.dto';

@ApiTags('assets')
@ApiBearerAuth('firebase-jwt')
@UseGuards(AuthGuard, TierGuard)
@RequiresTier(Plan.INTERMEDIATE)
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Post()
  @ApiCreatedResponse({ type: AssetResponseDto })
  create(@CurrentUser() user: User, @Body() dto: CreateAssetDto) {
    return this.assetsService.create(user.id, dto);
  }

  @Get()
  @ApiOkResponse({ type: [AssetResponseDto] })
  findAll(@CurrentUser() user: User) {
    return this.assetsService.findAllByUser(user.id);
  }

  @Get(':id')
  @ApiOkResponse({ type: AssetResponseDto })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.assetsService.findOne(id, user.id);
  }

  @Patch(':id')
  @ApiOkResponse({ type: AssetResponseDto })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAssetDto,
  ) {
    return this.assetsService.update(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Asset marcado como vendido (soft delete)' })
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.assetsService.remove(id, user.id);
  }
}
