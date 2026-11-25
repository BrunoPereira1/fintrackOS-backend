import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { CardInvoicesService } from './card-invoices.service';
import { CardsService } from './cards.service';
import { InvoiceEntriesService } from '../invoices/invoice-entries.service';
import { ErrorMessages } from '../common/constants/error-messages';

const USER_ID = 'user-uuid-1';
const CARD = { id: 'card-uuid-1', userId: USER_ID };
const CREATED = new Date('2026-03-15T12:00:00Z');

describe('CardInvoicesService', () => {
  let service: CardInvoicesService;
  let em: EntityManager;
  let dataSource: { transaction: jest.Mock };
  let cards: { lockOwned: jest.Mock };
  let entries: Record<'addPayment' | 'removePayment' | 'addCharge' | 'removeCharge', jest.Mock>;

  beforeEach(async () => {
    em = {} as EntityManager;
    dataSource = { transaction: jest.fn((work: (em: EntityManager) => unknown) => work(em)) };
    cards = { lockOwned: jest.fn().mockResolvedValue(CARD) };
    entries = {
      addPayment: jest.fn().mockResolvedValue({
        id: 'p1',
        cardId: CARD.id,
        invoiceMonth: '2026-03',
        amount: '150.50',
        paidOn: '2026-03-15',
        createdAt: CREATED,
      }),
      removePayment: jest.fn().mockResolvedValue(undefined),
      addCharge: jest.fn().mockResolvedValue({
        id: 'c1',
        cardId: CARD.id,
        invoiceMonth: '2026-03',
        amount: '12.30',
        description: null,
        createdAt: CREATED,
      }),
      removeCharge: jest.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        CardInvoicesService,
        { provide: DataSource, useValue: dataSource },
        { provide: CardsService, useValue: cards },
        { provide: InvoiceEntriesService, useValue: entries },
      ],
    }).compile();
    service = moduleRef.get(CardInvoicesService);
  });

  it('pagamento: transação → trava o cartão (posse) → grava com o mesmo em; resposta tipada', async () => {
    const result = await service.addPayment(CARD.id, USER_ID, '2026-03', { amount: 150.5 });

    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(cards.lockOwned).toHaveBeenCalledWith(em, CARD.id, USER_ID);
    expect(entries.addPayment).toHaveBeenCalledWith(em, CARD, '2026-03', { amount: 150.5 });
    expect(result).toEqual({
      id: 'p1',
      cardId: CARD.id,
      invoiceMonth: '2026-03',
      amount: 150.5,
      paidOn: '2026-03-15',
      createdAt: CREATED,
    });
  });

  it('desfazer pagamento e encargo passam pela trava do cartão', async () => {
    await service.removePayment(CARD.id, USER_ID, '2026-03', 'p1');
    await service.removeCharge(CARD.id, USER_ID, '2026-03', 'c1');
    expect(cards.lockOwned).toHaveBeenCalledTimes(2);
    expect(entries.removePayment).toHaveBeenCalledWith(em, CARD, '2026-03', 'p1');
    expect(entries.removeCharge).toHaveBeenCalledWith(em, CARD, '2026-03', 'c1');
  });

  it('encargo: grava com o cartão travado', async () => {
    const result = await service.addCharge(CARD.id, USER_ID, '2026-03', { amount: 12.3 });
    expect(entries.addCharge).toHaveBeenCalledWith(em, CARD, '2026-03', { amount: 12.3 });
    expect(result).toMatchObject({ id: 'c1', amount: 12.3, description: null });
  });

  it('cartão de outro usuário: lockOwned barra (403) e nada é gravado', async () => {
    cards.lockOwned.mockRejectedValue(new ForbiddenException(ErrorMessages.ACCESS_DENIED));
    await expect(service.addPayment(CARD.id, 'outro', '2026-03', { amount: 1 })).rejects.toThrow(
      ForbiddenException,
    );
    expect(entries.addPayment).not.toHaveBeenCalled();
  });

  it('cartão inexistente: lockOwned barra (404) e nada é gravado', async () => {
    cards.lockOwned.mockRejectedValue(new NotFoundException(ErrorMessages.NOT_FOUND.CARD));
    await expect(service.addCharge(CARD.id, USER_ID, '2026-03', { amount: 1 })).rejects.toThrow(
      NotFoundException,
    );
    expect(entries.addCharge).not.toHaveBeenCalled();
  });

  it('deadlock/serialização → 409', async () => {
    dataSource.transaction.mockRejectedValue(
      new QueryFailedError('SQL', [], Object.assign(new Error('pg'), { code: '40001' })),
    );
    await expect(service.addCharge(CARD.id, USER_ID, '2026-03', { amount: 1 })).rejects.toThrow(
      new ConflictException(ErrorMessages.CONCURRENT_UPDATE),
    );
  });
});
