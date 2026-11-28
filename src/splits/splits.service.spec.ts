import { Test, TestingModule } from '@nestjs/testing';
import { QueryFailedError } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ErrorMessages } from '../common/constants/error-messages';
import { SplitsService } from './splits.service';
import { CostSplit, SplitStatus } from './entities/cost-split.entity';
import { RunLockedOptions, TransactionsService } from '../transactions/transactions.service';
import { Transaction } from '../transactions/entities/transaction.entity';
import { ContactsService } from '../contacts/contacts.service';
import { Contact } from '../contacts/entities/contact.entity';

const USER_ID = 'user-uuid-1';
const TX_ID = 'tx-uuid-1';
const CONTACT_ID = 'contact-uuid-1';

const mockContact = (): Contact =>
  ({
    id: CONTACT_ID,
    name: 'João',
    email: 'joao@email.com',
    phone: '11 99999-0000',
    userId: USER_ID,
  }) as Contact;

const mockSplit = (): CostSplit =>
  ({
    id: 'split-uuid-1',
    contactId: CONTACT_ID,
    assignedAmount: 50,
    status: SplitStatus.PENDING,
    paidAt: null,
    transactionId: TX_ID,
    itemId: null,
  }) as CostSplit;

const ITEM_ID = 'item-uuid-1';

// Valores decimais como chegam do Postgres (string)
const mockTx = (): Transaction =>
  ({
    id: TX_ID,
    userId: USER_ID,
    totalAmount: '200.00',
    items: [{ id: ITEM_ID, quantity: 2, unitPrice: '40.00' }], // item = R$ 80
  }) as unknown as Transaction;

describe('SplitsService', () => {
  let service: SplitsService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    remove: jest.Mock;
    find: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let txService: jest.Mocked<TransactionsService>;
  let contactsService: { findOne: jest.Mock };

  beforeEach(async () => {
    const qbMock = {
      innerJoin: jest.fn().mockReturnThis(),
      innerJoinAndSelect: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      getOne: jest.fn(),
      getMany: jest.fn(),
    };

    repo = {
      create: jest.fn(),
      save: jest.fn(),
      remove: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => qbMock),
    };
    // runLocked: executa o trabalho com a transação (posse via findOne) e um EntityManager
    // cujo repositório de splits é o mesmo mock `repo`. Como o real, troca o 404/403 da posse
    // pelo erro de `onNotOwned` quando informado (D30)
    const em = { getRepository: jest.fn(() => repo) };
    txService = {
      findOne: jest.fn(),
      runLocked: jest.fn(
        async (
          id: string,
          userId: string,
          work: (tx: unknown, m: unknown) => unknown,
          opts?: RunLockedOptions,
        ) => {
          let tx: Transaction;
          try {
            tx = await txService.findOne(id, userId);
          } catch (err) {
            const notOwned = err instanceof NotFoundException || err instanceof ForbiddenException;
            if (notOwned && opts?.onNotOwned) throw opts.onNotOwned();
            throw err;
          }
          return work(tx, em);
        },
      ),
    } as unknown as jest.Mocked<TransactionsService>;
    contactsService = { findOne: jest.fn().mockResolvedValue(mockContact()) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SplitsService,
        { provide: getRepositoryToken(CostSplit), useValue: repo },
        { provide: TransactionsService, useValue: txService },
        { provide: ContactsService, useValue: contactsService },
      ],
    }).compile();

    service = module.get(SplitsService);
  });

  describe('create — soma dos splits', () => {
    const existing = (amount: string, itemId: string | null = null) =>
      ({ ...mockSplit(), assignedAmount: amount, itemId }) as unknown as CostSplit;

    beforeEach(() => {
      txService.findOne.mockResolvedValue(mockTx());
      repo.create.mockImplementation((x) => x);
      repo.save.mockImplementation(async (x) => x);
    });

    it('aceita splits que completam exatamente o total da transação', async () => {
      repo.find.mockResolvedValue([existing('120.00'), existing('30.00')]);

      await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 50,
        transactionId: TX_ID,
      });

      expect(repo.find).toHaveBeenCalledWith({ where: { transactionId: TX_ID } });
      expect(repo.save).toHaveBeenCalled();
    });

    it('rejeita split que faria a soma ultrapassar o total da transação', async () => {
      repo.find.mockResolvedValue([existing('150.00')]);

      await expect(
        service.create(USER_ID, {
          contactId: CONTACT_ID,
          assignedAmount: 50.01,
          transactionId: TX_ID,
        }),
      ).rejects.toThrow(new UnprocessableEntityException(ErrorMessages.SPLITS_EXCEED_TOTAL));
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejeita split de item acima do valor do item (quantidade × preço)', async () => {
      repo.find.mockResolvedValue([existing('60.00', ITEM_ID), existing('100.00')]);

      await expect(
        service.create(USER_ID, {
          contactId: CONTACT_ID,
          assignedAmount: 20.01,
          transactionId: TX_ID,
          itemId: ITEM_ID,
        }),
      ).rejects.toThrow(new UnprocessableEntityException(ErrorMessages.SPLITS_EXCEED_ITEM));
    });

    it('aceita split de item que completa o valor do item', async () => {
      repo.find.mockResolvedValue([existing('60.00', ITEM_ID)]);

      await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 20,
        transactionId: TX_ID,
        itemId: ITEM_ID,
      });
      expect(repo.save).toHaveBeenCalled();
    });

    it('compra inteira para outra pessoa (split = total) é permitida', async () => {
      await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 200,
        transactionId: TX_ID,
      });
      expect(repo.save).toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('cria split após validar que a transação pertence ao usuário', async () => {
      const split = mockSplit();
      txService.findOne.mockResolvedValue(mockTx());
      repo.create.mockReturnValue(split);
      repo.save.mockResolvedValue(split);

      const result = await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 50,
        transactionId: TX_ID,
      });

      expect(txService.findOne).toHaveBeenCalledWith(TX_ID, USER_ID);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ itemId: null }));
      expect(result).toBe(split);
    });

    it('aceita itemId que pertence à transação', async () => {
      const split = { ...mockSplit(), itemId: ITEM_ID };
      txService.findOne.mockResolvedValue(mockTx());
      repo.create.mockReturnValue(split);
      repo.save.mockResolvedValue(split);

      const result = await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 50,
        transactionId: TX_ID,
        itemId: ITEM_ID,
      });

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ itemId: ITEM_ID }));
      expect(result).toBe(split);
    });

    it('rejeita itemId de outra transação (IDOR) sem gravar', async () => {
      txService.findOne.mockResolvedValue(mockTx());

      await expect(
        service.create(USER_ID, {
          contactId: CONTACT_ID,
          assignedAmount: 50,
          transactionId: TX_ID,
          itemId: 'item-de-outra-transacao',
        }),
      ).rejects.toThrow(BadRequestException);

      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('rejeita itemId quando a transação não tem itens', async () => {
      txService.findOne.mockResolvedValue({ ...mockTx(), items: [] } as unknown as Transaction);

      await expect(
        service.create(USER_ID, {
          contactId: CONTACT_ID,
          assignedAmount: 50,
          transactionId: TX_ID,
          itemId: ITEM_ID,
        }),
      ).rejects.toThrow(BadRequestException);
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('create — contato', () => {
    beforeEach(() => {
      txService.findOne.mockResolvedValue(mockTx());
      repo.create.mockImplementation((x) => x);
      repo.save.mockImplementation(async (x) => ({ id: 'split-uuid-9', ...x }));
    });

    it('valida o contato contra o usuário e grava contactId, devolvendo a relação contact', async () => {
      const result = await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 50,
        transactionId: TX_ID,
      });

      expect(contactsService.findOne).toHaveBeenCalledWith(CONTACT_ID, USER_ID);
      expect(repo.create).toHaveBeenCalledWith({
        contactId: CONTACT_ID,
        assignedAmount: 50,
        transactionId: TX_ID,
        itemId: null,
      });
      expect(result.contact).toEqual(mockContact());
    });

    it.each([
      ['inexistente', new NotFoundException('Contact not found')],
      ['de outro usuário', new ForbiddenException('Access denied')],
    ])('contato %s → 400 genérico, sem gravar', async (_, error) => {
      contactsService.findOne.mockRejectedValue(error);

      await expect(
        service.create(USER_ID, {
          contactId: CONTACT_ID,
          assignedAmount: 50,
          transactionId: TX_ID,
        }),
      ).rejects.toThrow(new BadRequestException(ErrorMessages.SPLIT_INVALID_CONTACT));
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('erro inesperado ao buscar o contato não vira 400', async () => {
      const boom = new Error('db down');
      contactsService.findOne.mockRejectedValue(boom);

      await expect(
        service.create(USER_ID, {
          contactId: CONTACT_ID,
          assignedAmount: 50,
          transactionId: TX_ID,
        }),
      ).rejects.toBe(boom);
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('D30: posse da transação do body vira 400 genérico (onNotOwned no runLocked)', async () => {
      await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 50,
        transactionId: TX_ID,
      });

      const opts = txService.runLocked.mock.calls[0][3];
      expect(opts?.lockCard).toBeFalsy(); // splits travam só a transação
      expect(opts?.onNotOwned?.()).toEqual(
        new BadRequestException(ErrorMessages.SPLIT_INVALID_TRANSACTION),
      );
    });

    it.each([
      ['inexistente', new NotFoundException(ErrorMessages.NOT_FOUND.TRANSACTION)],
      ['de outro usuário', new ForbiddenException(ErrorMessages.ACCESS_DENIED)],
    ])(
      'D30: transação %s → 400 genérico antes de validar o contato, sem gravar',
      async (_, error) => {
        txService.findOne.mockRejectedValue(error);

        await expect(
          service.create(USER_ID, {
            contactId: CONTACT_ID,
            assignedAmount: 50,
            transactionId: TX_ID,
          }),
        ).rejects.toThrow(new BadRequestException(ErrorMessages.SPLIT_INVALID_TRANSACTION));
        expect(contactsService.findOne).not.toHaveBeenCalled();
        expect(repo.save).not.toHaveBeenCalled();
      },
    );
  });

  describe('leitura — relação contact', () => {
    it('findOne carrega o contato e filtra pelo dono da transação', async () => {
      const qb = repo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ ...mockSplit(), contact: mockContact() });

      const result = await service.findOne('split-uuid-1', USER_ID);

      expect(qb.innerJoinAndSelect).toHaveBeenCalledWith('s.contact', 'c', 'c.user_id = :userId', {
        userId: USER_ID,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('t.user_id = :userId', { userId: USER_ID });
      expect(result.contact.id).toBe(CONTACT_ID);
    });

    it('findOne → 404 quando não é do usuário', async () => {
      const qb = repo.createQueryBuilder();
      qb.getOne.mockResolvedValue(null);
      await expect(service.findOne('split-uuid-1', USER_ID)).rejects.toThrow(NotFoundException);
    });

    it('findAllByTransaction carrega o contato e ordena pelo nome dele', async () => {
      const qb = repo.createQueryBuilder();
      qb.getMany.mockResolvedValue([]);

      await service.findAllByTransaction(TX_ID, USER_ID);

      expect(qb.innerJoinAndSelect).toHaveBeenCalledWith('s.contact', 'c', 'c.user_id = :userId', {
        userId: USER_ID,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('t.user_id = :userId', { userId: USER_ID });
      expect(qb.orderBy).toHaveBeenCalledWith('c.name', 'ASC');
    });
  });

  describe('create — concorrência', () => {
    it('valida e grava com a transação travada (runLocked)', async () => {
      txService.findOne.mockResolvedValue(mockTx());
      repo.create.mockImplementation((x) => x);
      repo.save.mockImplementation(async (x) => x);

      await service.create(USER_ID, {
        contactId: CONTACT_ID,
        assignedAmount: 10,
        transactionId: TX_ID,
      });

      expect(txService.runLocked).toHaveBeenCalledWith(
        TX_ID,
        USER_ID,
        expect.any(Function),
        expect.objectContaining({ onNotOwned: expect.any(Function) }),
      );
    });

    it('contato removido em paralelo (FK diferida no commit) → 400 genérico, não 500', async () => {
      txService.findOne.mockResolvedValue(mockTx());
      repo.create.mockImplementation((x) => x);
      repo.save.mockRejectedValue(
        new QueryFailedError(
          'SQL',
          [],
          Object.assign(new Error('pg'), { code: '23503', constraint: 'FK_cost_splits_contact' }),
        ),
      );

      await expect(
        service.create(USER_ID, {
          contactId: CONTACT_ID,
          assignedAmount: 10,
          transactionId: TX_ID,
        }),
      ).rejects.toThrow(new BadRequestException(ErrorMessages.SPLIT_INVALID_CONTACT));
    });
  });

  describe('update/remove — sob a trava da transação', () => {
    // split localizado (posse via join com o dono da transação) e relido sob a trava
    const lockedTx = (splits: CostSplit[]) => ({ ...mockTx(), splits }) as unknown as Transaction;

    beforeEach(() => {
      repo
        .createQueryBuilder()
        .getOne.mockResolvedValue({ ...mockSplit(), contact: mockContact() });
      repo.save.mockImplementation(async (x) => x);
    });

    it('update trava a transação do split (runLocked sem lockCard) e grava a versão relida', async () => {
      const fresh = { ...mockSplit(), contact: mockContact() };
      txService.findOne.mockResolvedValue(lockedTx([fresh]));

      const result = await service.update('split-uuid-1', USER_ID, { status: SplitStatus.PAID });

      expect(txService.runLocked).toHaveBeenCalledWith(TX_ID, USER_ID, expect.any(Function));
      expect(repo.save).toHaveBeenCalledWith(fresh);
      expect(result).toMatchObject({ status: SplitStatus.PAID, contact: mockContact() });
    });

    it('remove trava a transação do split e remove a versão relida', async () => {
      const fresh = mockSplit();
      txService.findOne.mockResolvedValue(lockedTx([fresh]));

      await service.remove('split-uuid-1', USER_ID);

      expect(txService.runLocked).toHaveBeenCalledWith(TX_ID, USER_ID, expect.any(Function));
      expect(repo.remove).toHaveBeenCalledWith(fresh);
    });

    it.each([
      [
        'update',
        (s: SplitsService) => s.update('split-uuid-1', USER_ID, { status: SplitStatus.PAID }),
      ],
      ['remove', (s: SplitsService) => s.remove('split-uuid-1', USER_ID)],
    ])(
      '%s: split apagado antes da trava (transação removida em paralelo) → 404 do split',
      async (_m, run) => {
        txService.findOne.mockResolvedValue(lockedTx([]));
        await expect(run(service)).rejects.toThrow(
          new NotFoundException(ErrorMessages.NOT_FOUND.SPLIT),
        );
        expect(repo.save).not.toHaveBeenCalled();
        expect(repo.remove).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'update',
        (s: SplitsService) => s.update('split-uuid-1', USER_ID, { status: SplitStatus.PAID }),
      ],
      ['remove', (s: SplitsService) => s.remove('split-uuid-1', USER_ID)],
    ])(
      '%s: transação removida antes da trava → 404 do split (não da transação)',
      async (_m, run) => {
        txService.findOne.mockRejectedValue(
          new NotFoundException(ErrorMessages.NOT_FOUND.TRANSACTION),
        );
        await expect(run(service)).rejects.toThrow(
          new NotFoundException(ErrorMessages.NOT_FOUND.SPLIT),
        );
      },
    );

    it('split de outro usuário → 404 sem travar nada', async () => {
      repo.createQueryBuilder().getOne.mockResolvedValue(null);
      await expect(service.remove('split-uuid-1', USER_ID)).rejects.toThrow(NotFoundException);
      expect(txService.runLocked).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    // sob a trava, a transação recarregada traz o mesmo split que a busca inicial
    beforeEach(() => {
      txService.findOne.mockImplementation(
        async () =>
          ({
            ...mockTx(),
            splits: [await repo.createQueryBuilder().getOne()],
          }) as unknown as Transaction,
      );
    });

    it('remarcar como PAID preserva a data do pagamento original', async () => {
      const paidAt = new Date('2026-03-10T12:00:00Z');
      const qb = repo.createQueryBuilder();
      qb.getOne.mockResolvedValue({ ...mockSplit(), status: SplitStatus.PAID, paidAt });
      repo.save.mockImplementation(async (x) => x);

      await service.update('split-uuid-1', USER_ID, { status: SplitStatus.PAID });

      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ paidAt }));
    });

    it('define paidAt ao marcar como PAID', async () => {
      const split = mockSplit();
      const qb = repo.createQueryBuilder();
      qb.getOne.mockResolvedValue(split);
      repo.save.mockResolvedValue({ ...split, status: SplitStatus.PAID, paidAt: new Date() });

      await service.update('split-uuid-1', USER_ID, { status: SplitStatus.PAID });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SplitStatus.PAID, paidAt: expect.any(Date) }),
      );
    });

    it('limpa paidAt ao reverter para PENDING', async () => {
      const split = { ...mockSplit(), status: SplitStatus.PAID, paidAt: new Date() };
      const qb = repo.createQueryBuilder();
      qb.getOne.mockResolvedValue(split);
      repo.save.mockResolvedValue({ ...split, status: SplitStatus.PENDING, paidAt: null });

      await service.update('split-uuid-1', USER_ID, { status: SplitStatus.PENDING });

      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: SplitStatus.PENDING, paidAt: null }),
      );
    });
  });
});
