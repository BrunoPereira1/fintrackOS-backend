import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiNoContentResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { TierGuard } from '../auth/guards/tier.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from '../users/entities/user.entity';
import { CardInvoicesService } from './card-invoices.service';
import { CardInvoiceEntryParamsDto, CardInvoiceParamsDto } from './dto/card-invoice-params.dto';
import { CreateInvoicePaymentDto } from '../invoices/dto/create-invoice-payment.dto';
import { CreateInvoiceChargeDto } from '../invoices/dto/create-invoice-charge.dto';
import {
  InvoiceChargeResponseDto,
  InvoicePaymentResponseDto,
} from '../invoices/dto/invoice-entry-response.dto';

// Sem @RequiresTier: pagar, lançar encargo e desfazer valem para qualquer plano (D8 — sem isso
// o razão do rebaixado fica errado). A posse do cartão é verificada sob trava no service.
@ApiTags('cards')
@ApiBearerAuth('firebase-jwt')
@UseGuards(AuthGuard, TierGuard)
@Controller('cards/:cardId/invoices/:month')
export class CardInvoicesController {
  constructor(private readonly cardInvoicesService: CardInvoicesService) {}

  /** Pagamento (parcial, total ou a maior) da fatura que vence em `month` (D2, D7, D9). */
  @Post('payments')
  @ApiCreatedResponse({ type: InvoicePaymentResponseDto })
  addPayment(
    @CurrentUser() user: User,
    @Param() params: CardInvoiceParamsDto,
    @Body() dto: CreateInvoicePaymentDto,
  ) {
    return this.cardInvoicesService.addPayment(params.cardId, user.id, params.month, dto);
  }

  @Delete('payments/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removePayment(@CurrentUser() user: User, @Param() params: CardInvoiceEntryParamsDto) {
    return this.cardInvoicesService.removePayment(params.cardId, user.id, params.month, params.id);
  }

  /** Encargo (juros/IOF/multa/mora) informado pelo usuário (D3, D9). */
  @Post('charges')
  @ApiCreatedResponse({ type: InvoiceChargeResponseDto })
  addCharge(
    @CurrentUser() user: User,
    @Param() params: CardInvoiceParamsDto,
    @Body() dto: CreateInvoiceChargeDto,
  ) {
    return this.cardInvoicesService.addCharge(params.cardId, user.id, params.month, dto);
  }

  @Delete('charges/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  removeCharge(@CurrentUser() user: User, @Param() params: CardInvoiceEntryParamsDto) {
    return this.cardInvoicesService.removeCharge(params.cardId, user.id, params.month, params.id);
  }
}
