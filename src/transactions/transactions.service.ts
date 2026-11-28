import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, EntityManager, Repository } from 'typeorm';
import { DateUtils } from 'typeorm/util/DateUtils';
import { PaymentMethod, Transaction } from './entities/transaction.entity';
import { Installment } from '../installments/entities/installment.entity';
import { TransactionItem } from './entities/transaction-item.entity';
import { CreateTransactionDto } from './dto/create-transaction.dto';
import { UpdateTransactionDto } from './dto/update-transaction.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { CardsService } from '../cards/cards.service';
import { InstallmentCalculatorService } from '../installments/installment-calculator.service';
import { ErrorMessages } from '../common/constants/error-messages';
import { Plan } from '../users/enums/plan.enum';
import { hasRequiredPlan } from '../auth/plan-access';
import { splitCents, sumCents, toCents } from '../common/money';
import { SplitStatus } from '../splits/entities/cost-split.entity';
import { CreditCard } from '../cards/entities/credit-card.entity';
import { mapTransactionConflict } from '../common/db-errors';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { CardInvoiceDatesService } from '../invoices/card-invoice-dates.service';
import {
  hasCoveredInstallmentInClosedInvoice,
  installmentsFallInClosedInvoice,
} from '../invoices/invoice-ledger.calculator';

const TX_RELATIONS = ['items', 'installments', 'splits', 'splits.contact'];

export interface RunLockedOptions {
  /**
   * Trava também o cartão da transação (se houver), **antes** dela — ordem global
   * cartão → transação (architecture.md). Obrigatório em edição/exclusão de compra no cartão.
   */
  lockCard?: boolean;
  /**
   * D30: o ID da transação veio do **body** (ex.: `transactionId` em `POST /splits`) —
   * inexistente ou de outro usuário lança este erro (400 genérico) em vez de 404/403. A leitura e
   * a trava filtram por `id` **e** `user_id` (a linha alheia nunca é travada). Só a checagem de
   * posse é convertida; erros do `work` passam intactos.
   */
  onNotOwned?: () => Error;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    @InjectRepository(Transaction)
    private readonly transactionsRepo: Repository<Transaction>,
    @InjectRepository(TransactionItem)
    private readonly itemsRepo: Repository<TransactionItem>,
    private readonly cardsService: CardsService,
    private readonly calculator: InstallmentCalculatorService,
    private readonly ledgers: InvoiceLedgerQuery,
    private readonly invoiceDates: CardInvoiceDatesService,
  ) {}

  async create(userId: string, userPlan: Plan, dto: CreateTransactionDto): Promise<Transaction> {
    const { items, cardId, installmentsCount, paymentMethod, ...txData } = dto;

    // Transações simples são BASIC; vincular a cartão (e parcelar) exige o plano de cartões
    if (cardId && !hasRequiredPlan(userPlan, Plan.INTERMEDIATE)) {
      throw new ForbiddenException(ErrorMessages.PLAN_REQUIRED(Plan.INTERMEDIATE));
    }

    const resolvedPaymentMethod = resolvePaymentMethod(Boolean(cardId), paymentMethod);

    this.assertItemsMatchTotal(items, dto.totalAmount);

    if (!cardId && installmentsCount && installmentsCount > 1) {
      throw new UnprocessableEntityException(ErrorMessages.INSTALLMENTS_REQUIRE_CARD);
    }

    // D29: compra no cartão sempre tem parcelas (à vista = 1); sem cartão é 1x e total ≥ 0,01
    if (cardId) assertTotalCoversInstallments(dto.totalAmount, installmentsCount ?? 1);

    const build = (installments?: DeepPartial<Installment>[]) =>
      this.transactionsRepo.create({
        ...txData,
        userId,
        cardId: cardId ?? null,
        paymentMethod: resolvedPaymentMethod,
        items: items?.map((item) => this.itemsRepo.create(item)),
        installments,
      });

    const saved = cardId
      ? await this.inTransaction(async (em) => {
          // Sob a trava do cartão: arquivamento e mudança de dias (D14) não correm em paralelo
          // D30: posse antes do arquivamento — alheio e arquivado é 400, nunca 422
          const card = await this.lockBodyCard(em, cardId, userId);
          if (card.archivedAt) throw new UnprocessableEntityException(ErrorMessages.CARD_ARCHIVED);
          // Toda compra no cartão gera parcelas — à vista é 1 parcela — para entrar na fatura;
          // cada parcela já traz `closingDate` (D14) pelos dias atuais do cartão, exceto em mês
          // com datas gravadas por fatura (D31/D32, lidas sob a trava)
          const recordedDates = await this.invoiceDates.findRecorded(em, card.id, userId);
          const installments = this.calculator.calculate({
            totalAmount: dto.totalAmount,
            installmentsCount: installmentsCount ?? 1,
            purchaseDate: dto.date,
            card,
            recordedDates,
          });
          return em.getRepository(Transaction).save(build(installments));
        })
      : await this.transactionsRepo.save(build());
    this.logger.log(`Transaction ${saved.id} created for user ${userId}`);
    return saved;
  }

  async findAll(
    userId: string,
    query: QueryTransactionsDto,
  ): Promise<PaginatedResult<Transaction>> {
    const { page, limit, type, category, cardId, dateFrom, dateTo } = query;

    const qb = this.transactionsRepo
      .createQueryBuilder('t')
      .leftJoinAndSelect('t.items', 'items')
      .where('t.user_id = :userId', { userId })
      .orderBy('t.date', 'DESC');

    if (type) qb.andWhere('t.type = :type', { type });
    if (category) qb.andWhere('t.category = :category', { category });
    if (cardId) qb.andWhere('t.card_id = :cardId', { cardId });
    if (dateFrom) qb.andWhere('t.date >= :dateFrom', { dateFrom });
    if (dateTo) qb.andWhere('t.date <= :dateTo', { dateTo });

    const [data, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Carrega a transação com itens, parcelas e splits (com contato). Splits aparecem para
   * qualquer plano: o rebaixado lê o que já criou (business-rules §1).
   */
  async findOne(id: string, userId: string): Promise<Transaction> {
    return this.findOwned(id, userId, TX_RELATIONS);
  }

  /**
   * Executa `work` numa transação de banco com a linha da transação travada (`FOR UPDATE`),
   * já com posse verificada e relações recarregadas **depois** da trava. Serializa edição,
   * exclusão e criação de splits da mesma transação (evita somas e parcelas inconsistentes).
   *
   * Com `lockCard`, se a transação tiver cartão: lê `card_id` sem trava, trava o cartão
   * (`lockOwned`) e só então a transação, conferindo que o `card_id` não mudou — ordem global
   * cartão → transação. Sem `lockCard` (splits) trava só a transação: quem a segura nunca espera
   * pelo cartão, então não há ordem inversa. Deadlock/serialização → 409.
   */
  async runLocked<T>(
    id: string,
    userId: string,
    work: (tx: Transaction, em: EntityManager, card?: CreditCard) => Promise<T>,
    opts: RunLockedOptions = {},
  ): Promise<T> {
    // D30: ID do body → filtra também por user_id, para nunca travar a linha de outro usuário
    const where = opts.onNotOwned ? { id, userId } : { id };
    return this.inTransaction(async (em) => {
      const repo = em.getRepository(Transaction);
      let card: CreditCard | undefined;
      if (opts.lockCard) {
        const peek = await repo.findOne({
          where,
          select: { id: true, userId: true, cardId: true },
        });
        this.assertOwned(peek, userId, opts.onNotOwned);
        if (peek.cardId) card = await this.cardsService.lockOwned(em, peek.cardId, userId);
      }
      // FOR UPDATE não pode ir junto de LEFT JOIN no Postgres: trava primeiro, carrega depois
      const locked = await repo.findOne({ where, lock: { mode: 'pessimistic_write' } });
      this.assertOwned(locked, userId, opts.onNotOwned);
      if (opts.lockCard && (locked.cardId ?? undefined) !== card?.id) {
        // Defesa: hoje `cardId` é imutável e cartão não é apagado (D12), então não deveria
        // acontecer; se o cartão travado não for mais o da transação, o cliente tenta de novo
        throw new ConflictException(ErrorMessages.CONCURRENT_UPDATE);
      }
      const tx = (await repo.findOne({ where: { id }, relations: TX_RELATIONS })) as Transaction;
      return work(tx, em, card);
    });
  }

  /**
   * D30: `cardId` do body — `lockOwned` com `onNotOwned`: a trava filtra por `id` e `user_id`
   * (cartão alheio nunca é travado) e inexistente ou alheio respondem o mesmo 400 genérico, para
   * não virar oráculo de IDs.
   */
  private lockBodyCard(em: EntityManager, cardId: string, userId: string): Promise<CreditCard> {
    return this.cardsService.lockOwned(em, cardId, userId, {
      onNotOwned: () => new BadRequestException(ErrorMessages.TRANSACTION_INVALID_CARD),
    });
  }

  /** Transação de banco com deadlock/serialização convertidos em 409. */
  private inTransaction<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return mapTransactionConflict(() => this.transactionsRepo.manager.transaction(work));
  }

  private assertOwned(
    tx: Transaction | null,
    userId: string,
    onNotOwned?: () => Error,
  ): asserts tx is Transaction {
    if (tx && tx.userId === userId) return;
    if (onNotOwned) throw onNotOwned();
    if (!tx) throw new NotFoundException(ErrorMessages.NOT_FOUND.TRANSACTION);
    throw new ForbiddenException(ErrorMessages.ACCESS_DENIED);
  }

  private async findOwned(id: string, userId: string, relations: string[]): Promise<Transaction> {
    const tx = await this.transactionsRepo.findOne({ where: { id }, relations });
    this.assertOwned(tx, userId);
    return tx;
  }

  private assertItemsMatchTotal(
    items: { quantity?: number; unitPrice: number | string }[] | undefined,
    totalAmount: number | string,
  ): void {
    if (!items?.length) return;
    const itemsCents = sumCents(items, (i) => (i.quantity ?? 1) * toCents(i.unitPrice));
    if (itemsCents !== toCents(totalAmount)) {
      throw new UnprocessableEntityException(ErrorMessages.ITEMS_TOTAL_MISMATCH);
    }
  }

  /**
   * Atualiza a transação mantendo os valores consistentes:
   * - novo total precisa bater com a soma dos itens e não pode ficar abaixo dos splits;
   * - compra no cartão, sob a trava cartão → transação: bloqueada (422) se alguma parcela coberta
   *   já está em fatura fechada (D20). Mudança só de **valor** (D26) mantém mês e datas gravados
   *   das parcelas e redistribui os valores; mudança de **data** recalcula as parcelas pelos dias
   *   **atuais** do cartão (respeitando as datas gravadas por fatura — D32), trocando-as numa
   *   única transação de banco, e é bloqueada (422) se
   *   alguma cair em fatura fechada (D24). Cartão arquivado também edita (D12).
   */
  async update(id: string, userId: string, dto: UpdateTransactionDto): Promise<Transaction> {
    return this.runLocked(
      id,
      userId,
      async (tx, em, card) => {
        const txRepo = em.getRepository(Transaction);
        if (dto.paymentMethod !== undefined) assertPaymentMethodChange(tx, dto.paymentMethod);
        const totalChanged =
          dto.totalAmount !== undefined && toCents(dto.totalAmount) !== toCents(tx.totalAmount);
        const dateChanged =
          dto.date !== undefined && dto.date.slice(0, 10) !== toDateString(tx.date);

        if (totalChanged) {
          const newTotal = dto.totalAmount as number;
          if (tx.items?.length) this.assertItemsMatchTotal(tx.items, newTotal);
          const splitsCents = sumCents(tx.splits, (s) => toCents(s.assignedAmount));
          if (splitsCents > toCents(newTotal)) {
            throw new UnprocessableEntityException(ErrorMessages.SPLITS_EXCEED_TOTAL);
          }
          // D29 (só valor — D26 — ou com data): installmentsCount é imutável
          if (tx.installments?.length) {
            assertTotalCoversInstallments(newTotal, tx.installments.length);
          }
        }

        const mustRecalc = (totalChanged || dateChanged) && tx.installments?.length > 0;
        if (!mustRecalc) {
          Object.assign(tx, dto);
          return txRepo.save(tx);
        }

        // Órfã legada (cartão removido antes do arquivamento): sem dias para recalcular
        if (!card) {
          throw new UnprocessableEntityException(ErrorMessages.CARD_REQUIRED_FOR_RECALC);
        }

        // Razão lido sob a trava do cartão: nenhum pagamento entra entre a checagem e a troca
        const ledger = await this.ledgers.loadLedger(userId, card.id, em);
        if (!ledger) throw new NotFoundException(ErrorMessages.NOT_FOUND.CARD);
        if (hasCoveredInstallmentInClosedInvoice(ledger, tx.id)) {
          throw new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE);
        }

        // D26: só valor — as parcelas mantêm mês, fechamento e vencimento gravados; só os
        // valores são redistribuídos (nunca muda de fatura por edição de valor)
        if (!dateChanged) {
          Object.assign(tx, dto);
          redistributeAmounts(tx.installments, toCents(tx.totalAmount));
          return txRepo.save(tx);
        }

        const installments = this.calculator.calculate({
          totalAmount: dto.totalAmount ?? toCents(tx.totalAmount) / 100,
          installmentsCount: tx.installments[0].totalInstallments,
          purchaseDate: (dto.date as string).slice(0, 10),
          card,
          // D32: datas gravadas por fatura (D31), do razão lido sob a trava
          recordedDates: ledger.recordedDates,
        });

        // D24: nova data não põe parcela em fatura já fechada (o destino é protegido). Tirar
        // parcela não coberta de fatura fechada é permitido (D27: D20 já protege as cobertas)
        const recalculatedDates = installments.map((i) => ({ dueDate: toDateString(i.dueDate) }));
        if (installmentsFallInClosedInvoice(ledger, recalculatedDates)) {
          throw new UnprocessableEntityException(ErrorMessages.PURCHASE_DATE_IN_CLOSED_INVOICE);
        }

        await em.delete(Installment, { transactionId: tx.id });

        Object.assign(tx, dto);
        // Linhas novas: `id`/`transactionId` são preenchidos pelo cascade no save
        tx.installments = installments as Installment[];
        return txRepo.save(tx);
      },
      { lockCard: true },
    );
  }

  /** Bloqueada (409) enquanto alguém ainda deve parte da transação (split pendente). */
  async remove(id: string, userId: string): Promise<void> {
    // Compra no cartão sob a trava do cartão; excluir compra coberta realoca o pago (D13)
    await this.runLocked(
      id,
      userId,
      async (tx, em) => {
        if (tx.splits?.some((s) => s.status === SplitStatus.PENDING)) {
          throw new ConflictException(ErrorMessages.TRANSACTION_HAS_PENDING_SPLITS);
        }
        await em.getRepository(Transaction).remove(tx);
      },
      { lockCard: true },
    );
  }
}

/**
 * Forma de pagamento na criação (business-rules §4): com cartão só `credit_card` (padrão); sem
 * cartão qualquer forma à vista, padrão `pix` (D15).
 */
function resolvePaymentMethod(hasCard: boolean, requested?: PaymentMethod): PaymentMethod {
  if (hasCard) {
    if (requested !== undefined && requested !== PaymentMethod.CREDIT_CARD) {
      throw new UnprocessableEntityException(ErrorMessages.CARD_REQUIRES_CREDIT_CARD_METHOD);
    }
    return PaymentMethod.CREDIT_CARD;
  }
  if (requested === PaymentMethod.CREDIT_CARD) {
    throw new UnprocessableEntityException(ErrorMessages.CREDIT_CARD_METHOD_REQUIRES_CARD);
  }
  return requested ?? PaymentMethod.PIX;
}

/**
 * Edição só entre formas à vista: compra de cartão (forma `credit_card`, com cartão ou com
 * parcelas — inclusive legado de cartão removido) não troca de forma, e nenhuma vira
 * `credit_card`. Reenviar a mesma forma não é troca.
 */
function assertPaymentMethodChange(tx: Transaction, requested: PaymentMethod): void {
  if (requested === tx.paymentMethod) return;
  const isCardPurchase =
    tx.paymentMethod === PaymentMethod.CREDIT_CARD ||
    tx.cardId != null ||
    (tx.installments?.length ?? 0) > 0;
  if (isCardPurchase || requested === PaymentMethod.CREDIT_CARD) {
    throw new UnprocessableEntityException(ErrorMessages.PAYMENT_METHOD_CHANGE_NOT_ALLOWED);
  }
}

/**
 * D29: o total precisa dar ao menos 1 centavo por parcela — senão haveria parcela de R$ 0,00
 * (ex.: R$ 0,02 em 3x). Total em centavos == número de parcelas é aceito.
 */
function assertTotalCoversInstallments(totalAmount: number | string, count: number): void {
  if (toCents(totalAmount) < count) {
    throw new UnprocessableEntityException(ErrorMessages.TOTAL_LESS_THAN_INSTALLMENTS);
  }
}

/**
 * D26: redistribui `totalCents` entre as parcelas pela regra da calculadora (floor em centavos,
 * resto na última — `splitCents`), pela ordem do número da parcela, sem tocar nas datas.
 */
function redistributeAmounts(installments: Installment[], totalCents: number): void {
  const ordered = [...installments].sort((a, b) => a.number - b.number);
  const parts = splitCents(totalCents, ordered.length);
  ordered.forEach((installment, i) => {
    installment.amount = parts[i] / 100;
  });
}

/**
 * Coluna `date` chega do driver como 'YYYY-MM-DD'; em memória pode ser `Date` — nesse caso usa
 * a data local, mesmo critério do TypeORM ao gravar (`DateUtils.mixedDateToDateString`).
 */
function toDateString(value: Date | string): string {
  return typeof value === 'string' ? value.slice(0, 10) : DateUtils.mixedDateToDateString(value);
}
