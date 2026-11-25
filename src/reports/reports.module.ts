import { Module } from '@nestjs/common';
import { CardsModule } from '../cards/cards.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

/**
 * Visões de leitura agregada: fatura, resumo mensal e "quem me deve". Status de parcela de
 * cartão, encargos e pagamentos vêm do razão (`InvoicesModule` → `InvoiceLedgerQuery`).
 * `Clock` vem do `ClockModule` global (registrado no `AppModule`).
 */
@Module({
  imports: [CardsModule, InvoicesModule],
  providers: [ReportsService],
  controllers: [ReportsController],
})
export class ReportsModule {}
