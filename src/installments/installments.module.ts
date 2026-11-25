import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Installment } from './entities/installment.entity';
import { InstallmentsService } from './installments.service';
import { InstallmentsController } from './installments.controller';
import { InstallmentCalculatorService } from './installment-calculator.service';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  // invoices: razão do cartão para o status derivado (InvoiceLedgerQuery); Clock é global
  imports: [TypeOrmModule.forFeature([Installment]), InvoicesModule],
  providers: [InstallmentsService, InstallmentCalculatorService],
  controllers: [InstallmentsController],
  exports: [InstallmentsService, InstallmentCalculatorService],
})
export class InstallmentsModule {}
