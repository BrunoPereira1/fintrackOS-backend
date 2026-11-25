import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TierGuard } from '../auth/guards/tier.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { InstallmentsService } from './installments.service';
import { QueryInstallmentsDto } from './dto/query-installments.dto';
import { UpdateInstallmentDto } from './dto/update-installment.dto';
import {
  InstallmentResponseDto,
  PaginatedInstallmentsResponseDto,
} from './dto/installment-response.dto';

@ApiTags('installments')
@ApiBearerAuth('firebase-jwt')
// Sem plano mínimo: parcelas só existem se o usuário já teve cartão (INTERMEDIATE). Rebaixado
// continua lendo. Status derivado do razão da fatura; o PATCH só vale para órfã legada (D18).
@UseGuards(AuthGuard, TierGuard)
@Controller('installments')
export class InstallmentsController {
  constructor(private readonly installmentsService: InstallmentsService) {}

  @Get()
  @ApiOkResponse({ type: PaginatedInstallmentsResponseDto })
  findAll(@CurrentUser() user: User, @Query() query: QueryInstallmentsDto) {
    return this.installmentsService.findAll(user.id, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: InstallmentResponseDto })
  @ApiNotFoundResponse({ description: 'Parcela inexistente ou de outro usuário' })
  findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.installmentsService.findOne(id, user.id);
  }

  /** Marca paga/pendente só parcela órfã legada (transação sem cartão — D18). */
  @Patch(':id')
  @ApiOkResponse({ type: InstallmentResponseDto })
  @ApiNotFoundResponse({ description: 'Parcela inexistente ou de outro usuário' })
  @ApiUnprocessableEntityResponse({
    description:
      'Parcela de cartão: registre o pagamento na fatura (POST /cards/:cardId/invoices/:month/payments)',
  })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInstallmentDto,
  ) {
    return this.installmentsService.update(id, user.id, dto);
  }
}
