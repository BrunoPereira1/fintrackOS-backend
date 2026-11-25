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
  Query,
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
import { SplitsService } from './splits.service';
import { CreateSplitDto } from './dto/create-split.dto';
import { UpdateSplitDto } from './dto/update-split.dto';
import { SplitResponseDto } from './dto/split-response.dto';
import { QuerySplitsDto } from './dto/query-splits.dto';
import { SplitMapper } from './split.mapper';

@ApiTags('splits')
@ApiBearerAuth('firebase-jwt')
// Plano por método: rebaixado ainda lê e marca como recebido (PATCH só muda status);
// criar/remover exige PREMIUM
@UseGuards(AuthGuard, TierGuard)
@Controller('splits')
export class SplitsController {
  constructor(private readonly splitsService: SplitsService) {}

  @Post()
  @RequiresTier(Plan.PREMIUM)
  @ApiCreatedResponse({ type: SplitResponseDto })
  async create(@CurrentUser() user: User, @Body() dto: CreateSplitDto) {
    return SplitMapper.toDto(await this.splitsService.create(user.id, dto));
  }

  @Get()
  @ApiOkResponse({ type: [SplitResponseDto] })
  async findAll(@CurrentUser() user: User, @Query() query: QuerySplitsDto) {
    const splits = await this.splitsService.findAllByTransaction(query.transactionId, user.id);
    return splits.map((s) => SplitMapper.toDto(s));
  }

  @Get(':id')
  @ApiOkResponse({ type: SplitResponseDto })
  async findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return SplitMapper.toDto(await this.splitsService.findOne(id, user.id));
  }

  @Patch(':id')
  @ApiOkResponse({ type: SplitResponseDto })
  async update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSplitDto,
  ) {
    return SplitMapper.toDto(await this.splitsService.update(id, user.id, dto));
  }

  @Delete(':id')
  @RequiresTier(Plan.PREMIUM)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.splitsService.remove(id, user.id);
  }
}
