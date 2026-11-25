import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EntityManager } from 'typeorm';
import { Clock } from '../common/clock';
import { ErrorMessages } from '../common/constants/error-messages';
import { buildCardLedger } from './invoice-ledger.calculator';
import { InvoiceLedgerQuery } from './invoice-ledger.query';
import { InvoiceEntriesService } from './invoice-entries.service';
import { InvoicePayment } from './entities/invoice-payment.entity';

const USER_ID = 'user-uuid-1';
const CARD = { id: 'card-uuid-1', userId: USER_ID };
const TODAY = '2026-03-15';

// Fecha 10, vence 17. Hoje 15/03: a fatura 2026-03 fechou em 10/03; a aberta atual é 2026-04
// (fecha 10/04). 2026-05 em diante ainda não aceita lançamentos (D9).
const ledger = () =>
  buildCardLedger({
    card: { closingDay: 10, dueDay: 17, creditLimit: '1000.00' },
    installments: [],
    charges: [],
    payments: [],
    today: TODAY,
  });

describe('InvoiceEntriesService', () => {
  let service: InvoiceEntriesService;
  let ledgers: { loadLedger: jest.Mock };
  let paymentsRepo: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let chargesRepo: { create: jest.Mock; save: jest.Mock; delete: jest.Mock };
  let em: EntityManager;

  const repoMock = () => ({
    create: jest.fn((x: object) => x),
    save: jest.fn((x: object) => Promise.resolve({ id: 'new-id', ...x })),
    delete: jest.fn().mockResolvedValue({ affected: 1 }),
  });

  beforeEach(async () => {
    paymentsRepo = repoMock();
    chargesRepo = repoMock();
    ledgers = { loadLedger: jest.fn().mockResolvedValue(ledger()) };
    em = {
      getRepository: jest.fn((entity: unknown) =>
        entity === InvoicePayment ? paymentsRepo : chargesRepo,
      ),
    } as unknown as EntityManager;

    const moduleRef = await Test.createTestingModule({
      providers: [
        InvoiceEntriesService,
        { provide: InvoiceLedgerQuery, useValue: ledgers },
        { provide: Clock, useValue: { today: () => TODAY } },
      ],
    }).compile();
    service = moduleRef.get(InvoiceEntriesService);
  });

  describe('addPayment', () => {
    it('grava o pagamento no cartão/mês com paidOn padrão = hoje, lendo o razão com o mesmo em', async () => {
      const saved = await service.addPayment(em, CARD, '2026-03', { amount: 150.5 });

      expect(ledgers.loadLedger).toHaveBeenCalledWith(USER_ID, CARD.id, em, TODAY);
      expect(paymentsRepo.save).toHaveBeenCalledWith({
        userId: USER_ID,
        cardId: CARD.id,
        invoiceMonth: '2026-03',
        amount: 150.5,
        paidOn: TODAY,
      });
      expect(saved.id).toBe('new-id');
    });

    it('aceita paidOn = hoje e no passado (sem limite inferior, D22)', async () => {
      await service.addPayment(em, CARD, '2026-04', { amount: 10, paidOn: TODAY });
      await service.addPayment(em, CARD, '2026-03', { amount: 10, paidOn: '2020-01-01' });
      expect(paymentsRepo.save).toHaveBeenCalledTimes(2);
    });

    it('D7: paidOn depois de hoje → 400, sem gravar', async () => {
      await expect(
        service.addPayment(em, CARD, '2026-03', { amount: 10, paidOn: '2026-03-16' }),
      ).rejects.toThrow(new BadRequestException(ErrorMessages.PAYMENT_DATE_IN_FUTURE));
      expect(paymentsRepo.save).not.toHaveBeenCalled();
    });

    it('D9: fatura fechada e fatura aberta atual aceitam; a seguinte → 422', async () => {
      await service.addPayment(em, CARD, '2026-01', { amount: 10 });
      await service.addPayment(em, CARD, '2026-04', { amount: 10 });
      await expect(service.addPayment(em, CARD, '2026-05', { amount: 10 })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.INVOICE_NOT_ACCEPTING_ENTRIES),
      );
      expect(paymentsRepo.save).toHaveBeenCalledTimes(2);
    });

    it('razão do cartão ausente (não deveria: cartão já verificado) → 404', async () => {
      ledgers.loadLedger.mockResolvedValue(undefined);
      await expect(service.addPayment(em, CARD, '2026-03', { amount: 10 })).rejects.toThrow(
        new NotFoundException(ErrorMessages.NOT_FOUND.CARD),
      );
    });
  });

  describe('removePayment', () => {
    it('apaga só o lançamento daquele usuário/cartão/mês', async () => {
      await service.removePayment(em, CARD, '2026-03', 'pay-1');
      expect(paymentsRepo.delete).toHaveBeenCalledWith({
        id: 'pay-1',
        userId: USER_ID,
        cardId: CARD.id,
        invoiceMonth: '2026-03',
      });
    });

    it('nada apagado (outro cartão/mês/usuário ou inexistente) → 404', async () => {
      paymentsRepo.delete.mockResolvedValue({ affected: 0 });
      await expect(service.removePayment(em, CARD, '2026-02', 'pay-1')).rejects.toThrow(
        new NotFoundException(ErrorMessages.NOT_FOUND.INVOICE_PAYMENT),
      );
    });

    it('desfazer não depende de D9 (sempre permitido, D8)', async () => {
      await service.removePayment(em, CARD, '2027-01', 'pay-1');
      expect(ledgers.loadLedger).not.toHaveBeenCalled();
    });
  });

  describe('addCharge', () => {
    it('grava o encargo com descrição opcional (null se omitida)', async () => {
      await service.addCharge(em, CARD, '2026-03', { amount: 12.34 });
      await service.addCharge(em, CARD, '2026-04', { amount: 1, description: 'IOF' });
      expect(chargesRepo.save).toHaveBeenNthCalledWith(1, {
        userId: USER_ID,
        cardId: CARD.id,
        invoiceMonth: '2026-03',
        amount: 12.34,
        description: null,
      });
      expect(chargesRepo.save).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ invoiceMonth: '2026-04', description: 'IOF' }),
      );
    });

    it('D9: mês além da fatura aberta atual → 422', async () => {
      await expect(service.addCharge(em, CARD, '2026-05', { amount: 1 })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.INVOICE_NOT_ACCEPTING_ENTRIES),
      );
      expect(chargesRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('removeCharge', () => {
    it('apaga só o encargo daquele usuário/cartão/mês', async () => {
      await service.removeCharge(em, CARD, '2026-03', 'ch-1');
      expect(chargesRepo.delete).toHaveBeenCalledWith({
        id: 'ch-1',
        userId: USER_ID,
        cardId: CARD.id,
        invoiceMonth: '2026-03',
      });
    });

    it('nada apagado → 404', async () => {
      chargesRepo.delete.mockResolvedValue({ affected: 0 });
      await expect(service.removeCharge(em, CARD, '2026-03', 'ch-1')).rejects.toThrow(
        new NotFoundException(ErrorMessages.NOT_FOUND.INVOICE_CHARGE),
      );
    });
  });
});
