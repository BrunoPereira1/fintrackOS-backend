import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager, IsNull, QueryFailedError } from 'typeorm';
import { CardsService } from './cards.service';
import { CreditCard, CardBrand } from './entities/credit-card.entity';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { buildCardLedger } from '../invoices/invoice-ledger.calculator';
import { InstallmentsService } from '../installments/installments.service';
import { Clock } from '../common/clock';
import { ErrorMessages } from '../common/constants/error-messages';

const USER_ID = 'user-uuid-1';
const OTHER_USER_ID = 'user-uuid-2';
const TODAY = '2026-03-15';

const mockCard = (over: Partial<CreditCard> = {}): CreditCard =>
  ({
    id: 'card-uuid-1',
    name: 'Nubank',
    brand: CardBrand.VISA,
    closingDay: 10,
    dueDay: 17,
    creditLimit: '5000.00' as unknown as number,
    userId: USER_ID,
    archivedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  }) as CreditCard;

/** Razão com R$ 300 de dívida e R$ 100 pagos → outstanding 200. */
const ledgerWithDebt = () =>
  buildCardLedger({
    card: { closingDay: 10, dueDay: 17, creditLimit: '5000.00' },
    installments: [
      {
        id: 'i1',
        transactionId: 't1',
        transactionCreatedAt: '2026-01-05T10:00:00.000000Z',
        number: 1,
        amount: '300.00',
        dueDate: '2026-02-17',
        closingDate: '2026-02-10',
      },
    ],
    charges: [],
    payments: [{ id: 'p1', invoiceMonth: '2026-02', amount: '100.00', paidOn: '2026-02-15' }],
    today: TODAY,
  });

describe('CardsService', () => {
  let service: CardsService;
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let emRepo: { findOne: jest.Mock; save: jest.Mock };
  let em: EntityManager;
  let ledgers: { loadLedgers: jest.Mock };
  let installments: { rescheduleOpenInvoices: jest.Mock };

  let clock: { today: jest.Mock };
  beforeEach(async () => {
    clock = { today: jest.fn(() => TODAY) };
    emRepo = {
      findOne: jest.fn(),
      save: jest.fn((c: CreditCard) => Promise.resolve(c)),
    };
    em = { getRepository: jest.fn(() => emRepo) } as unknown as EntityManager;
    repo = {
      create: jest.fn(),
      save: jest.fn(),
      find: jest.fn(),
      findOne: jest.fn(),
      manager: { transaction: jest.fn((work: (em: EntityManager) => unknown) => work(em)) },
    };
    ledgers = { loadLedgers: jest.fn().mockResolvedValue(new Map()) };
    installments = { rescheduleOpenInvoices: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CardsService,
        { provide: getRepositoryToken(CreditCard), useValue: repo },
        { provide: InvoiceLedgerQuery, useValue: ledgers },
        { provide: InstallmentsService, useValue: installments },
        { provide: Clock, useValue: clock },
      ],
    }).compile();

    service = module.get(CardsService);
  });

  describe('create', () => {
    it('creates and saves a card, returning balances of an empty ledger', async () => {
      const card = mockCard();
      repo.create.mockReturnValue(card);
      repo.save.mockResolvedValue(card);

      const result = await service.create(USER_ID, {
        name: 'Nubank',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 5000,
      });

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
      expect(result).toMatchObject({
        id: card.id,
        creditLimit: 5000,
        archivedAt: null,
        outstanding: 0,
        credit: 0,
        availableLimit: 5000,
      });
    });
  });

  describe('findAllByUser', () => {
    it('lista só ativos por padrão e calcula saldos em lote (uma carga para todos)', async () => {
      const a = mockCard({ id: 'a' });
      const b = mockCard({ id: 'b', creditLimit: '0.00' as unknown as number });
      repo.find.mockResolvedValue([a, b]);
      ledgers.loadLedgers.mockResolvedValue(new Map([['a', ledgerWithDebt()]]));

      const result = await service.findAllByUser(USER_ID);

      expect(repo.find).toHaveBeenCalledWith({
        where: { userId: USER_ID, archivedAt: IsNull() },
        order: { createdAt: 'DESC' },
      });
      expect(ledgers.loadLedgers).toHaveBeenCalledTimes(1);
      expect(ledgers.loadLedgers).toHaveBeenCalledWith(USER_ID, {
        cardIds: ['a', 'b'],
        today: TODAY,
      });
      expect(result.map((c) => [c.id, c.outstanding, c.credit, c.availableLimit])).toEqual([
        ['a', 200, 0, 4800],
        // sem razão carregado (sem lançamentos) e limite 0 → availableLimit null (D11)
        ['b', 0, 0, null],
      ]);
    });

    it('includeArchived=true lista também os arquivados', async () => {
      repo.find.mockResolvedValue([]);
      await service.findAllByUser(USER_ID, { includeArchived: true });
      expect(repo.find).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        order: { createdAt: 'DESC' },
      });
      expect(ledgers.loadLedgers).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('returns the card when owner matches (inclusive arquivado)', async () => {
      repo.findOne.mockResolvedValue(mockCard({ archivedAt: new Date() }));
      const result = await service.findOne('card-uuid-1', USER_ID);
      expect(result.id).toBe('card-uuid-1');
    });

    it('throws NotFoundException when card not found', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('bad-id', USER_ID)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when card belongs to another user', async () => {
      repo.findOne.mockResolvedValue(mockCard());
      await expect(service.findOne('card-uuid-1', OTHER_USER_ID)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('findOneWithBalance', () => {
    it('devolve o cartão com saldos do razão', async () => {
      repo.findOne.mockResolvedValue(mockCard());
      ledgers.loadLedgers.mockResolvedValue(new Map([['card-uuid-1', ledgerWithDebt()]]));
      const result = await service.findOneWithBalance('card-uuid-1', USER_ID);
      expect(result).toMatchObject({ outstanding: 200, credit: 0, availableLimit: 4800 });
      expect(ledgers.loadLedgers).toHaveBeenCalledWith(USER_ID, {
        cardIds: ['card-uuid-1'],
        today: TODAY,
      });
    });
  });

  describe('lockOwned', () => {
    it('trava com FOR UPDATE pelo em informado', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      const card = await service.lockOwned(em, 'card-uuid-1', USER_ID);
      expect(card.id).toBe('card-uuid-1');
      expect(emRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'card-uuid-1' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('404 quando não existe', async () => {
      emRepo.findOne.mockResolvedValue(null);
      await expect(service.lockOwned(em, 'x', USER_ID)).rejects.toThrow(
        new NotFoundException(ErrorMessages.NOT_FOUND.CARD),
      );
    });

    it('403 quando é de outro usuário', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      await expect(service.lockOwned(em, 'card-uuid-1', OTHER_USER_ID)).rejects.toThrow(
        new ForbiddenException(ErrorMessages.ACCESS_DENIED),
      );
    });
  });

  describe('update', () => {
    it('sem mudar dias: salva sob a trava e não mexe nas parcelas', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      const result = await service.update('card-uuid-1', USER_ID, { name: 'Novo', closingDay: 10 });
      expect(emRepo.save).toHaveBeenCalledWith(expect.objectContaining({ name: 'Novo' }));
      expect(installments.rescheduleOpenInvoices).not.toHaveBeenCalled();
      expect(result.name).toBe('Novo');
    });

    it('D14: mudou closingDay/dueDay → ajusta parcelas de faturas não fechadas, no mesmo em', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      await service.update('card-uuid-1', USER_ID, { dueDay: 5 });
      expect(installments.rescheduleOpenInvoices).toHaveBeenCalledWith(
        em,
        'card-uuid-1',
        USER_ID,
        { closingDay: 10, dueDay: 5 },
        TODAY,
      );
      // um único "hoje" para o reagendamento D14 e para os saldos da resposta
      expect(ledgers.loadLedgers).toHaveBeenCalledWith(USER_ID, {
        cardIds: ['card-uuid-1'],
        today: TODAY,
      });
      expect(clock.today).toHaveBeenCalledTimes(1);
    });

    it('403 para cartão de outro usuário, sem gravar', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      await expect(service.update('card-uuid-1', OTHER_USER_ID, { closingDay: 1 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(emRepo.save).not.toHaveBeenCalled();
      expect(installments.rescheduleOpenInvoices).not.toHaveBeenCalled();
    });

    it('deadlock na transação → 409', async () => {
      repo.manager.transaction.mockRejectedValue(
        new QueryFailedError('SQL', [], Object.assign(new Error('pg'), { code: '40P01' })),
      );
      await expect(service.update('card-uuid-1', USER_ID, { dueDay: 5 })).rejects.toThrow(
        new ConflictException(ErrorMessages.CONCURRENT_UPDATE),
      );
    });
  });

  describe('archive (D12)', () => {
    it('arquiva com archived_at = agora, sob a trava', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      await service.archive('card-uuid-1', USER_ID);
      expect(emRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(emRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ archivedAt: expect.any(Date) }),
      );
    });

    it('já arquivado: idempotente, mantém a data original', async () => {
      emRepo.findOne.mockResolvedValue(mockCard({ archivedAt: new Date('2026-01-02') }));
      await service.archive('card-uuid-1', USER_ID);
      expect(emRepo.save).not.toHaveBeenCalled();
    });

    it('cartão de outro usuário → 403', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      await expect(service.archive('card-uuid-1', OTHER_USER_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expect(emRepo.save).not.toHaveBeenCalled();
    });

    it('cartão inexistente → 404', async () => {
      emRepo.findOne.mockResolvedValue(null);
      await expect(service.archive('x', USER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('restore', () => {
    it('reativa (archived_at = null) e devolve o cartão com saldos', async () => {
      emRepo.findOne.mockResolvedValue(mockCard({ archivedAt: new Date('2026-01-02') }));
      const result = await service.restore('card-uuid-1', USER_ID);
      expect(emRepo.save).toHaveBeenCalledWith(expect.objectContaining({ archivedAt: null }));
      expect(result.archivedAt).toBeNull();
      expect(result.availableLimit).toBe(5000);
    });

    it('cartão inexistente → 404', async () => {
      emRepo.findOne.mockResolvedValue(null);
      await expect(service.restore('x', USER_ID)).rejects.toThrow(NotFoundException);
    });

    it('cartão de outro usuário → 403, sem gravar', async () => {
      emRepo.findOne.mockResolvedValue(mockCard({ archivedAt: new Date('2026-01-02') }));
      await expect(service.restore('card-uuid-1', OTHER_USER_ID)).rejects.toThrow(
        ForbiddenException,
      );
      expect(emRepo.save).not.toHaveBeenCalled();
    });

    it('cartão ativo: idempotente, não grava', async () => {
      emRepo.findOne.mockResolvedValue(mockCard());
      const result = await service.restore('card-uuid-1', USER_ID);
      expect(emRepo.save).not.toHaveBeenCalled();
      expect(result.archivedAt).toBeNull();
    });
  });
});
