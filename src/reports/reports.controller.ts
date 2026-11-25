import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TierGuard } from '../auth/guards/tier.guard';
import { RequiresTier } from '../auth/decorators/requires-tier.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Plan } from '../users/enums/plan.enum';
import { User } from '../users/entities/user.entity';
import { ReportsService } from './reports.service';
import { InvoiceParamsDto, MonthParamDto } from './dto/report-params.dto';
import { InvoiceResponseDto } from './dto/invoice-response.dto';
import { MonthlySummaryResponseDto } from './dto/monthly-summary-response.dto';
import { ReceivablesQueryDto, ReceivablesResponseDto } from './dto/receivables.dto';

// Sem @RequiresTier na classe: resumo e fatura não exigem plano (rebaixado lê o que já tem; a
// posse do cartão é checada no service); receivables exige PREMIUM (rebaixado recebe 403).
@ApiTags('reports')
@ApiBearerAuth('firebase-jwt')
@UseGuards(AuthGuard, TierGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  /** Fatura do cartão que vence no mês informado. */
  @Get('cards/:cardId/invoices/:month')
  @ApiOkResponse({ type: InvoiceResponseDto })
  getInvoice(@CurrentUser() user: User, @Param() params: InvoiceParamsDto) {
    return this.reportsService.getInvoice(user.id, params.cardId, params.month);
  }

  /** Resumo do mês em regime de caixa. */
  @Get('monthly-summary/:month')
  @ApiOkResponse({ type: MonthlySummaryResponseDto })
  getMonthlySummary(@CurrentUser() user: User, @Param() params: MonthParamDto) {
    return this.reportsService.getMonthlySummary(user.id, user.plan, params.month);
  }

  /** "Quem me deve": splits por contato. Premium (rebaixado recebe 403). */
  @Get('receivables')
  @RequiresTier(Plan.PREMIUM)
  @ApiOkResponse({ type: ReceivablesResponseDto })
  getReceivables(@CurrentUser() user: User, @Query() query: ReceivablesQueryDto) {
    return this.reportsService.getReceivables(user.id, query);
  }
}
