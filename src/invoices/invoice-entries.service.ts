import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { Clock } from '../common/clock';
import { ErrorMessages } from '../common/constants/error-messages';
import { acceptsInvoiceEntries } from './invoice-ledger.calculator';
import { InvoiceLedgerQuery } from './invoice-ledger.query';
import { InvoicePayment } from './entities/invoice-payment.entity';
import { InvoiceCharge } from './entities/invoice-charge.entity';
import { CreateInvoicePaymentDto } from './dto/create-invoice-payment.dto';
import { CreateInvoiceChargeDto } from './dto/create-invoice-charge.dto';

/** Cartão **já verificado (posse) e travado** pelo chamador, na mesma transação de `em`. */
export interface LockedCard {
  id: string;
  userId: string;
}

/**
 * Grava/remove pagamentos e encargos de fatura (spec 2026-11-24-modelo-de-pagamento D2, D3, D7,
 * D8, D9). Não verifica posse nem trava: recebe o cartão já travado (`CardsService.lockOwned`) e
 * o `em` da transação — o razão de D9 é lido com o mesmo `em`, sob a trava.
 */
@Injectable()
export class InvoiceEntriesService {
  private readonly logger = new Logger(InvoiceEntriesService.name);

  constructor(
    private readonly ledgers: InvoiceLedgerQuery,
    private readonly clock: Clock,
  ) {}

  async addPayment(
    em: EntityManager,
    card: LockedCard,
    month: string,
    dto: CreateInvoicePaymentDto,
  ): Promise<InvoicePayment> {
    const today = this.clock.today();
    const paidOn = dto.paidOn ?? today;
    // D7: datas `YYYY-MM-DD` comparam lexicograficamente
    if (paidOn > today) throw new BadRequestException(ErrorMessages.PAYMENT_DATE_IN_FUTURE);
    await this.assertAcceptsEntries(em, card, month, today);

    const repo = em.getRepository(InvoicePayment);
    const saved = await repo.save(
      repo.create({
        userId: card.userId,
        cardId: card.id,
        invoiceMonth: month,
        amount: dto.amount,
        paidOn,
      }),
    );
    this.logger.log(`Invoice payment ${saved.id} added to card ${card.id} (${month})`);
    return saved;
  }

  /** Desfazer (D8): sempre permitido, sem D9 — só o lançamento daquele usuário/cartão/mês. */
  async removePayment(
    em: EntityManager,
    card: LockedCard,
    month: string,
    id: string,
  ): Promise<void> {
    const { affected } = await em
      .getRepository(InvoicePayment)
      .delete({ id, userId: card.userId, cardId: card.id, invoiceMonth: month });
    if (!affected) throw new NotFoundException(ErrorMessages.NOT_FOUND.INVOICE_PAYMENT);
    this.logger.log(`Invoice payment ${id} removed from card ${card.id} (${month})`);
  }

  async addCharge(
    em: EntityManager,
    card: LockedCard,
    month: string,
    dto: CreateInvoiceChargeDto,
  ): Promise<InvoiceCharge> {
    await this.assertAcceptsEntries(em, card, month);

    const repo = em.getRepository(InvoiceCharge);
    const saved = await repo.save(
      repo.create({
        userId: card.userId,
        cardId: card.id,
        invoiceMonth: month,
        amount: dto.amount,
        description: dto.description ?? null,
      }),
    );
    this.logger.log(`Invoice charge ${saved.id} added to card ${card.id} (${month})`);
    return saved;
  }

  async removeCharge(
    em: EntityManager,
    card: LockedCard,
    month: string,
    id: string,
  ): Promise<void> {
    const { affected } = await em
      .getRepository(InvoiceCharge)
      .delete({ id, userId: card.userId, cardId: card.id, invoiceMonth: month });
    if (!affected) throw new NotFoundException(ErrorMessages.NOT_FOUND.INVOICE_CHARGE);
    this.logger.log(`Invoice charge ${id} removed from card ${card.id} (${month})`);
  }

  /** D9: só fatura já fechada ou a fatura aberta atual (datas da fatura, D25). */
  private async assertAcceptsEntries(
    em: EntityManager,
    card: LockedCard,
    month: string,
    today?: string,
  ): Promise<void> {
    const ledger = await this.ledgers.loadLedger(card.userId, card.id, em, today);
    if (!ledger) throw new NotFoundException(ErrorMessages.NOT_FOUND.CARD);
    if (!acceptsInvoiceEntries(ledger, month)) {
      throw new UnprocessableEntityException(ErrorMessages.INVOICE_NOT_ACCEPTING_ENTRIES);
    }
  }
}
