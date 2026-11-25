import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CardsService } from './cards.service';
import { CreditCard } from './entities/credit-card.entity';
import { mapTransactionConflict } from '../common/db-errors';
import { InvoiceEntriesService } from '../invoices/invoice-entries.service';
import { CreateInvoicePaymentDto } from '../invoices/dto/create-invoice-payment.dto';
import { CreateInvoiceChargeDto } from '../invoices/dto/create-invoice-charge.dto';
import {
  InvoiceChargeResponseDto,
  InvoicePaymentResponseDto,
} from '../invoices/dto/invoice-entry-response.dto';

/**
 * Pagamentos e encargos de fatura (D2, D3, D7–D9): orquestra `transação de banco → trava do
 * cartão com posse (404/403) → InvoiceEntriesService`, com o mesmo `em`. Qualquer plano (D8);
 * cartão arquivado também aceita (D12). Deadlock/serialização → 409.
 */
@Injectable()
export class CardInvoicesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cardsService: CardsService,
    private readonly entries: InvoiceEntriesService,
  ) {}

  async addPayment(
    cardId: string,
    userId: string,
    month: string,
    dto: CreateInvoicePaymentDto,
  ): Promise<InvoicePaymentResponseDto> {
    const saved = await this.withLockedCard(cardId, userId, (em, card) =>
      this.entries.addPayment(em, card, month, dto),
    );
    return InvoicePaymentResponseDto.from(saved);
  }

  removePayment(cardId: string, userId: string, month: string, id: string): Promise<void> {
    return this.withLockedCard(cardId, userId, (em, card) =>
      this.entries.removePayment(em, card, month, id),
    );
  }

  async addCharge(
    cardId: string,
    userId: string,
    month: string,
    dto: CreateInvoiceChargeDto,
  ): Promise<InvoiceChargeResponseDto> {
    const saved = await this.withLockedCard(cardId, userId, (em, card) =>
      this.entries.addCharge(em, card, month, dto),
    );
    return InvoiceChargeResponseDto.from(saved);
  }

  removeCharge(cardId: string, userId: string, month: string, id: string): Promise<void> {
    return this.withLockedCard(cardId, userId, (em, card) =>
      this.entries.removeCharge(em, card, month, id),
    );
  }

  private withLockedCard<T>(
    cardId: string,
    userId: string,
    work: (em: EntityManager, card: CreditCard) => Promise<T>,
  ): Promise<T> {
    return mapTransactionConflict(() =>
      this.dataSource.transaction(async (em) =>
        work(em, await this.cardsService.lockOwned(em, cardId, userId)),
      ),
    );
  }
}
