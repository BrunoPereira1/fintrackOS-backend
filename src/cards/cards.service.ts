import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { CreditCard } from './entities/credit-card.entity';
import { CreateCardDto } from './dto/create-card.dto';
import { UpdateCardDto } from './dto/update-card.dto';
import { CardResponseDto } from './dto/card-response.dto';
import { ErrorMessages } from '../common/constants/error-messages';
import { Clock } from '../common/clock';
import { toCents } from '../common/money';
import { mapTransactionConflict } from '../common/db-errors';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { buildCardLedger, cardBalance, CardLedger } from '../invoices/invoice-ledger.calculator';
import { InstallmentsService } from '../installments/installments.service';
import { CardInvoiceDatesService } from '../invoices/card-invoice-dates.service';

@Injectable()
export class CardsService {
  private readonly logger = new Logger(CardsService.name);

  constructor(
    @InjectRepository(CreditCard)
    private readonly cardsRepo: Repository<CreditCard>,
    private readonly ledgers: InvoiceLedgerQuery,
    private readonly installmentsService: InstallmentsService,
    private readonly invoiceDates: CardInvoiceDatesService,
    private readonly clock: Clock,
  ) {}

  async create(userId: string, dto: CreateCardDto): Promise<CardResponseDto> {
    const card = this.cardsRepo.create({ ...dto, userId });
    this.logger.log(`Creating card for user ${userId}`);
    const saved = await this.cardsRepo.save(card);
    // Cartão novo não tem lançamentos: razão vazio, sem consulta
    return this.toResponse(saved);
  }

  /** Cartões do usuário com saldos (D11) calculados em lote; arquivados só se pedido (D12). */
  async findAllByUser(
    userId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<CardResponseDto[]> {
    const cards = await this.cardsRepo.find({
      where: opts.includeArchived ? { userId } : { userId, archivedAt: IsNull() },
      order: { createdAt: 'DESC' },
    });
    return this.withBalances(userId, cards);
  }

  /** Posse do cartão (inclusive arquivado). Usado por outros módulos para validar `cardId`. */
  async findOne(id: string, userId: string): Promise<CreditCard> {
    const card = await this.cardsRepo.findOne({ where: { id } });
    if (!card) throw new NotFoundException(ErrorMessages.NOT_FOUND.CARD);
    if (card.userId !== userId) throw new ForbiddenException(ErrorMessages.ACCESS_DENIED);
    return card;
  }

  async findOneWithBalance(id: string, userId: string): Promise<CardResponseDto> {
    const card = await this.findOne(id, userId);
    return (await this.withBalances(userId, [card]))[0];
  }

  /**
   * Trava a linha do cartão (`FOR UPDATE`) na transação de `em` e verifica a posse (404/403).
   * Ordem global de travas: **cartão → transação** (architecture.md).
   *
   * D30 — `onNotOwned` (ID veio do **body**): o `SELECT ... FOR UPDATE` filtra por `id` **e**
   * `user_id`, então a linha de outro usuário nunca é travada (sem canal de tempo); nada
   * encontrado (inexistente ou alheio) → lança `onNotOwned()`. Sem ele (rotas `:id`), trava por
   * `id` e responde 404/403.
   */
  async lockOwned(
    em: EntityManager,
    id: string,
    userId: string,
    opts: { onNotOwned?: () => Error } = {},
  ): Promise<CreditCard> {
    const repo = em.getRepository(CreditCard);
    const lock = { mode: 'pessimistic_write' } as const;
    if (opts.onNotOwned) {
      const owned = await repo.findOne({ where: { id, userId }, lock });
      if (!owned) throw opts.onNotOwned();
      return owned;
    }
    const card = await repo.findOne({ where: { id }, lock });
    if (!card) throw new NotFoundException(ErrorMessages.NOT_FOUND.CARD);
    if (card.userId !== userId) throw new ForbiddenException(ErrorMessages.ACCESS_DENIED);
    return card;
  }

  /**
   * Edita o cartão sob a trava. Se `closingDay`/`dueDay` mudarem: D31 — antes de tudo, grava as
   * datas vigentes das faturas já fechadas (lidas com os dias antigos, ainda no banco); D14 — as
   * parcelas de faturas ainda não fechadas recebem as novas datas do mesmo mês de fatura (via
   * `InstallmentsService`). Tudo na mesma transação.
   */
  async update(id: string, userId: string, dto: UpdateCardDto): Promise<CardResponseDto> {
    const today = this.clock.today(); // o mesmo "hoje" em D31, no reagendamento D14 e nos saldos
    const saved = await this.inTransaction(async (em) => {
      const card = await this.lockOwned(em, id, userId);
      const daysChanged =
        (dto.closingDay !== undefined && dto.closingDay !== card.closingDay) ||
        (dto.dueDay !== undefined && dto.dueDay !== card.dueDay);
      // D31: antes de salvar os dias novos — o razão é lido do banco com os dias antigos; os
      // dias novos (dto mesclado com os atuais) decidem quais meses fechados reabririam
      if (daysChanged) {
        const newDays = {
          closingDay: dto.closingDay ?? card.closingDay,
          dueDay: dto.dueDay ?? card.dueDay,
        };
        await this.invoiceDates.recordClosedInvoices(em, card.id, userId, newDays, today);
      }
      Object.assign(card, dto);
      if (daysChanged) {
        await this.installmentsService.rescheduleOpenInvoices(
          em,
          card.id,
          userId,
          { closingDay: card.closingDay, dueDay: card.dueDay },
          today,
        );
      }
      return em.getRepository(CreditCard).save(card);
    });
    return (await this.withBalances(userId, [saved], today))[0];
  }

  /**
   * Remover cartão = **arquivar** (D12): sai das listas e não aceita compra nova; histórico,
   * faturas, saldo e pagamentos continuam. Idempotente (mantém a data do 1º arquivamento).
   */
  async archive(id: string, userId: string): Promise<void> {
    await this.inTransaction(async (em) => {
      const card = await this.lockOwned(em, id, userId);
      if (card.archivedAt) return;
      card.archivedAt = new Date();
      await em.getRepository(CreditCard).save(card);
      this.logger.log(`Card ${id} archived by user ${userId}`);
    });
  }

  /** Reativa um cartão arquivado (D12). Idempotente. */
  async restore(id: string, userId: string): Promise<CardResponseDto> {
    const card = await this.inTransaction(async (em) => {
      const locked = await this.lockOwned(em, id, userId);
      if (!locked.archivedAt) return locked;
      locked.archivedAt = null;
      const saved = await em.getRepository(CreditCard).save(locked);
      this.logger.log(`Card ${id} restored by user ${userId}`);
      return saved;
    });
    return (await this.withBalances(userId, [card]))[0];
  }

  /** Transação de banco com deadlock/serialização convertidos em 409. */
  private inTransaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return mapTransactionConflict(() => this.cardsRepo.manager.transaction(work));
  }

  /** Saldos (D11) de vários cartões com uma única carga em lote do razão (sem N+1). */
  private async withBalances(
    userId: string,
    cards: CreditCard[],
    today = this.clock.today(),
  ): Promise<CardResponseDto[]> {
    if (cards.length === 0) return [];
    const ledgers = await this.ledgers.loadLedgers(userId, {
      cardIds: cards.map((c) => c.id),
      today,
    });
    return cards.map((card) => this.toResponse(card, ledgers.get(card.id), today));
  }

  private toResponse(
    card: CreditCard,
    ledger?: CardLedger,
    today = this.clock.today(),
  ): CardResponseDto {
    const balance = cardBalance(
      ledger ??
        buildCardLedger({
          card,
          installments: [],
          charges: [],
          payments: [],
          today,
        }),
    );
    return {
      id: card.id,
      name: card.name,
      brand: card.brand,
      closingDay: card.closingDay,
      dueDay: card.dueDay,
      // decimal chega do Postgres como string: responde número, como os saldos
      creditLimit: toCents(card.creditLimit) / 100,
      userId: card.userId,
      archivedAt: card.archivedAt ?? null,
      ...balance,
      createdAt: card.createdAt,
      updatedAt: card.updatedAt,
    };
  }
}
