import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Transaction } from './entities/transaction.entity';
import { TransactionItem } from './entities/transaction-item.entity';
import { TransactionsService } from './transactions.service';
import { TransactionsController } from './transactions.controller';
import { CardsModule } from '../cards/cards.module';
import { InstallmentsModule } from '../installments/installments.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, TransactionItem]),
    CardsModule,
    InstallmentsModule,
    // Razão do cartão (D20/D24) lido sob a trava do cartão; invoices não importa transactions
    InvoicesModule,
  ],
  providers: [TransactionsService],
  controllers: [TransactionsController],
  exports: [TransactionsService],
})
export class TransactionsModule {}
