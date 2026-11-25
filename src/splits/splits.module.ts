import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CostSplit } from './entities/cost-split.entity';
import { SplitsService } from './splits.service';
import { SplitsController } from './splits.controller';
import { TransactionsModule } from '../transactions/transactions.module';
import { ContactsModule } from '../contacts/contacts.module';

@Module({
  imports: [TypeOrmModule.forFeature([CostSplit]), TransactionsModule, ContactsModule],
  providers: [SplitsService],
  controllers: [SplitsController],
})
export class SplitsModule {}
