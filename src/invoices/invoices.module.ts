import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InvoicePayment } from './entities/invoice-payment.entity';
import { InvoiceCharge } from './entities/invoice-charge.entity';
import { InvoiceLedgerQuery } from './invoice-ledger.query';
import { InvoiceEntriesService } from './invoice-entries.service';
import { CardInvoiceDate } from './entities/card-invoice-date.entity';
import { CardInvoiceDatesService } from './card-invoice-dates.service';

/**
 * Razão do cartão: pagamentos/encargos de fatura, datas gravadas por fatura (D31) e a leitura em
 * lote do ledger. Não importa módulos de domínio (sem ciclo); `Clock` vem do `ClockModule`
 * global. Rotas ficam em `cards` (`CardInvoicesController`), que verifica posse e trava o cartão
 * antes de chamar este módulo.
 */
@Module({
  imports: [TypeOrmModule.forFeature([InvoicePayment, InvoiceCharge, CardInvoiceDate])],
  providers: [InvoiceLedgerQuery, InvoiceEntriesService, CardInvoiceDatesService],
  exports: [InvoiceLedgerQuery, InvoiceEntriesService, CardInvoiceDatesService],
})
export class InvoicesModule {}
