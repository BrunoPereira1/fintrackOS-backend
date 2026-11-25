import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreditCard } from './entities/credit-card.entity';
import { CardsService } from './cards.service';
import { CardsController } from './cards.controller';
import { CardInvoicesService } from './card-invoices.service';
import { CardInvoicesController } from './card-invoices.controller';
import { InvoicesModule } from '../invoices/invoices.module';
import { InstallmentsModule } from '../installments/installments.module';

// cards ─► invoices (razão, pagamentos/encargos), installments (D14: reagendar parcelas sob a
// trava do cartão). Nenhum dos dois importa cards: sem ciclo.
@Module({
  imports: [TypeOrmModule.forFeature([CreditCard]), InvoicesModule, InstallmentsModule],
  providers: [CardsService, CardInvoicesService],
  controllers: [CardsController, CardInvoicesController],
  // Só o service: outros módulos validam posse via CardsService.findOne, não pelo repositório
  exports: [CardsService],
})
export class CardsModule {}
