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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TierGuard } from '../auth/guards/tier.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { TransactionsService } from './transactions.service';
import { ContactMapper } from '../contacts/contact.mapper';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { TransactionResponseDto } from './dto/transaction-response.dto';

@ApiTags('transactions')
@ApiBearerAuth('firebase-jwt')
// Sem @RequiresTier na classe: transações simples são BASIC. A exigência de INTERMEDIATE
// para cartão/parcelas e de PREMIUM para splits é aplicada no service.
@UseGuards(AuthGuard, TierGuard)
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post()
  @ApiCreatedResponse({ type: TransactionResponseDto })
  @ApiBadRequestResponse({
    description:
      'Dados inválidos, ou cartão inexistente ou de outro usuário (resposta genérica, D30)',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Regra violada: itens ≠ total, forma de pagamento incompatível, parcelas sem cartão, cartão arquivado ou total menor que o número de parcelas em centavos (D29)',
  })
  create(@CurrentUser() user: User, @Body() dto: CreateTransactionDto) {
    return this.transactionsService.create(user.id, user.plan, dto);
  }

  @Get()
  @ApiOkResponse({ type: [TransactionResponseDto] })
  findAll(@CurrentUser() user: User, @Query() query: QueryTransactionsDto) {
    return this.transactionsService.findAll(user.id, query);
  }

  @Get(':id')
  @ApiOkResponse({ type: TransactionResponseDto })
  async findOne(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    const tx = await this.transactionsService.findOne(id, user.id);
    // Splits com o contato resumido: sem telefone nem userId
    if (!tx.splits) return tx;
    return {
      ...tx,
      splits: tx.splits.map(({ contact, ...split }) => ({
        ...split,
        contact: ContactMapper.toSummary(contact),
      })),
    };
  }

  @Patch(':id')
  @ApiOkResponse({ type: TransactionResponseDto })
  @ApiUnprocessableEntityResponse({
    description:
      'Regra violada: itens/splits ≠ novo total, total menor que o número de parcelas em centavos (D29), parcela coberta ou nova data em fatura fechada, troca de forma de pagamento não permitida',
  })
  update(
    @CurrentUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTransactionDto,
  ) {
    return this.transactionsService.update(id, user.id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  remove(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    return this.transactionsService.remove(id, user.id);
  }
}
