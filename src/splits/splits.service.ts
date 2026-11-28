import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CostSplit, SplitStatus } from './entities/cost-split.entity';
import { CreateSplitDto } from './dto/create-split.dto';
import { UpdateSplitDto } from './dto/update-split.dto';
import { TransactionsService } from '../transactions/transactions.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { ContactsService } from '../contacts/contacts.service';
import { Contact } from '../contacts/entities/contact.entity';
import { ErrorMessages } from '../common/constants/error-messages';
import { sumCents, toCents } from '../common/money';
import { isForeignKeyViolation } from '../common/db-errors';

@Injectable()
export class SplitsService {
  private readonly logger = new Logger(SplitsService.name);

  constructor(
    @InjectRepository(CostSplit)
    private readonly splitsRepo: Repository<CostSplit>,
    private readonly transactionsService: TransactionsService,
    private readonly contactsService: ContactsService,
  ) {}

  /**
   * Cria o split com a transação travada (`TransactionsService.runLocked`): a checagem
   * "Σ splits ≤ total" e o insert ficam atômicos frente a outros splits e à edição do total.
   * D30: `transactionId` vem do body — inexistente ou alheia → 400 genérico (`onNotOwned`).
   */
  async create(userId: string, dto: CreateSplitDto): Promise<CostSplit> {
    try {
      return await this.transactionsService.runLocked(
        dto.transactionId,
        userId,
        (tx, em) => this.createLocked(userId, dto, tx, em.getRepository(CostSplit)),
        { onNotOwned: () => new BadRequestException(ErrorMessages.SPLIT_INVALID_TRANSACTION) },
      );
    } catch (err) {
      // Contato removido entre a validação e o commit: a FK diferida falha no COMMIT
      if (isForeignKeyViolation(err, 'FK_cost_splits_contact')) {
        throw new BadRequestException(ErrorMessages.SPLIT_INVALID_CONTACT);
      }
      throw err;
    }
  }

  private async createLocked(
    userId: string,
    dto: CreateSplitDto,
    tx: Transaction,
    repo: Repository<CostSplit>,
  ): Promise<CostSplit> {
    // O item, se informado, precisa ser da mesma transação — senão seria possível vincular
    // o split a um item de outra transação/usuário (IDOR). Mesma resposta para item
    // inexistente ou alheio, para não virar oráculo de IDs.
    const item = dto.itemId ? tx.items?.find((i) => i.id === dto.itemId) : undefined;
    if (dto.itemId && !item) {
      throw new BadRequestException(ErrorMessages.SPLIT_ITEM_NOT_IN_TRANSACTION);
    }

    const contact = await this.findContactOrBadRequest(dto.contactId, userId);

    // O que foi atribuído a outras pessoas não pode passar do valor da compra (nem do item)
    const existing = await repo.find({ where: { transactionId: tx.id } });
    const newCents = toCents(dto.assignedAmount);
    const assignedCents = sumCents(existing, (s) => toCents(s.assignedAmount));
    if (assignedCents + newCents > toCents(tx.totalAmount)) {
      throw new UnprocessableEntityException(ErrorMessages.SPLITS_EXCEED_TOTAL);
    }
    if (item) {
      const itemCents = (item.quantity ?? 1) * toCents(item.unitPrice);
      const itemAssigned = sumCents(
        existing.filter((s) => s.itemId === item.id),
        (s) => toCents(s.assignedAmount),
      );
      if (itemAssigned + newCents > itemCents) {
        throw new UnprocessableEntityException(ErrorMessages.SPLITS_EXCEED_ITEM);
      }
    }

    const split = repo.create({
      contactId: contact.id,
      assignedAmount: dto.assignedAmount,
      transactionId: tx.id,
      itemId: dto.itemId ?? null,
    });

    const saved = await repo.save(split);
    saved.contact = contact;
    this.logger.log(`Split ${saved.id} created on tx ${dto.transactionId}`);
    return saved;
  }

  /**
   * O contato precisa ser do usuário. Mesma resposta (400) para inexistente ou alheio, como no
   * `itemId`, para não virar oráculo de IDs de outros usuários.
   */
  private async findContactOrBadRequest(contactId: string, userId: string): Promise<Contact> {
    try {
      return await this.contactsService.findOne(contactId, userId);
    } catch (err) {
      if (err instanceof NotFoundException || err instanceof ForbiddenException) {
        throw new BadRequestException(ErrorMessages.SPLIT_INVALID_CONTACT);
      }
      throw err;
    }
  }

  findAllByTransaction(transactionId: string, userId: string): Promise<CostSplit[]> {
    return this.splitsRepo
      .createQueryBuilder('s')
      .innerJoin('s.transaction', 't')
      .innerJoinAndSelect('s.contact', 'c', 'c.user_id = :userId', { userId })
      .where('s.transaction_id = :transactionId', { transactionId })
      .andWhere('t.user_id = :userId', { userId })
      .orderBy('c.name', 'ASC')
      .addOrderBy('s.id', 'ASC')
      .getMany();
  }

  async findOne(id: string, userId: string): Promise<CostSplit> {
    const split = await this.splitsRepo
      .createQueryBuilder('s')
      .innerJoin('s.transaction', 't')
      .innerJoinAndSelect('s.contact', 'c', 'c.user_id = :userId', { userId })
      .where('s.id = :id', { id })
      .andWhere('t.user_id = :userId', { userId })
      .getOne();

    if (!split) throw new NotFoundException(ErrorMessages.NOT_FOUND.SPLIT);
    return split;
  }

  /**
   * Muda o status sob a trava da transação (`runLocked` sem `lockCard`): não corre com a remoção
   * da transação (409 de split pendente) nem com a criação de splits.
   */
  async update(id: string, userId: string, dto: UpdateSplitDto): Promise<CostSplit> {
    return this.runOnLockedSplit(id, userId, async (split, repo) => {
      // paidAt só é preenchido na transição pending → paid (remarcar como pago preserva a data)
      if (dto.status === SplitStatus.PAID) {
        if (split.status !== SplitStatus.PAID || !split.paidAt) split.paidAt = new Date();
      } else {
        split.paidAt = null;
      }
      split.status = dto.status;
      const saved = await repo.save(split);
      this.logger.log(`Split ${id} updated to status "${dto.status}"`);
      return saved;
    });
  }

  /** Remove sob a trava da transação (mesmo motivo do `update`). */
  async remove(id: string, userId: string): Promise<void> {
    await this.runOnLockedSplit(id, userId, (split, repo) => repo.remove(split));
  }

  /**
   * Posse pelo join com o dono da transação (404) e, sob a trava da transação, o split **relido**
   * (relações recarregadas pelo `runLocked`). Se a transação ou o split sumiram entre a busca e
   * a trava (remoção concorrente) → 404 do split.
   */
  private async runOnLockedSplit<T>(
    id: string,
    userId: string,
    work: (split: CostSplit, repo: Repository<CostSplit>) => Promise<T>,
  ): Promise<T> {
    const { transactionId } = await this.findOne(id, userId);
    try {
      return await this.transactionsService.runLocked(transactionId, userId, (tx, em) => {
        const split = tx.splits?.find((s) => s.id === id);
        if (!split) throw new NotFoundException(ErrorMessages.NOT_FOUND.SPLIT);
        return work(split, em.getRepository(CostSplit));
      });
    } catch (err) {
      if (err instanceof NotFoundException) {
        throw new NotFoundException(ErrorMessages.NOT_FOUND.SPLIT);
      }
      throw err;
    }
  }
}
