import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Contact } from './entities/contact.entity';
import { ContactsService } from './contacts.service';
import { ContactsController } from './contacts.controller';

// Não importa SplitsModule (splits ─► contacts; o inverso criaria ciclo).
@Module({
  imports: [TypeOrmModule.forFeature([Contact])],
  providers: [ContactsService],
  controllers: [ContactsController],
  exports: [ContactsService],
})
export class ContactsModule {}
