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
import { CardsService } from './cards.service';
import { CreateCardDto } from './dto/create-card.dto';
import { UpdateCardDto } from './dto/update-card.dto';
import { CardResponseDto } from './dto/card-response.dto';
import { QueryCardsDto } from './dto/query-cards.dto';

@ApiTags('cards')
@ApiBearerAuth('firebase-jwt')
// Plano por método: rebaixado ainda lê os cartões que tem; criar/editar/arquivar/reativar exige
// INTERMEDIATE
@UseGuards(AuthGuard, TierGuard)
@Controller('cards')
export class CardsController {
  constructor(private readonly cardsService: CardsService) {}

  @Post()
  @RequiresTier(Plan.INTERMEDIATE)
  @ApiCreatedResponse({ type: CardResponseDto })
  create(@CurrentUser() user: User, @Body() dto: CreateCardDto) {
    return this.cardsService.create(user.id, dto);
  }

  /** Cartões ativos (arquivados só com `?includeArchived=true`), com saldos (D11). */
  @Get()
  @ApiOkResponse({ type: [CardResponseDto] })
  findAll(@CurrentUser() user: User, @Query() query: QueryCardsDto) {
    return this.cardsService.findAllByUser(user.id, { includeArchived: query.includeArchived });
  }

  /** Cartão (inclusive arquivado) com saldos (D11). */
  @Get(':id')
  @ApiOkResponse({ type: CardResponseDto })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.cardsService.findOneWithBalance(id, user.id);
  }

  @Patch(':id')
  @RequiresTier(Plan.INTERMEDIATE)
  @ApiOkResponse({ type: CardResponseDto })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCardDto,
  ) {
    return this.cardsService.update(id, user.id, dto);
  }

  /** Arquiva o cartão (D12): sem exclusão física; histórico e faturas continuam. */
  @Delete(':id')
  @RequiresTier(Plan.INTERMEDIATE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.cardsService.archive(id, user.id);
  }

  /** Reativa um cartão arquivado (D12). */
  @Post(':id/restore')
  @RequiresTier(Plan.INTERMEDIATE)
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CardResponseDto })
  restore(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.cardsService.restore(id, user.id);
  }
}
