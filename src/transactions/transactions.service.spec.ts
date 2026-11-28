import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { TransactionsService } from './transactions.service';
import { PaymentMethod, Transaction, TransactionType } from './entities/transaction.entity';
import { TransactionItem } from './entities/transaction-item.entity';
import { CardsService } from '../cards/cards.service';
import { InstallmentCalculatorService } from '../installments/installment-calculator.service';
import { CreditCard } from '../cards/entities/credit-card.entity';
import { Plan } from '../users/enums/plan.enum';
import { QueryFailedError } from 'typeorm';
import { Installment } from '../installments/entities/installment.entity';
import { ErrorMessages } from '../common/constants/error-messages';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { CardInvoiceDatesService } from '../invoices/card-invoice-dates.service';
import {
  buildCardLedger,
  CardLedger,
  LedgerInstallmentInput,
  LedgerPaymentInput,
} from '../invoices/invoice-ledger.calculator';

const USER_ID = 'user-uuid-1';

const mockCard = (): CreditCard =>
  ({ id: 'card-uuid-1', userId: USER_ID, closingDay: 10, dueDay: 17 }) as CreditCard;

// Razão do cartão (fecha 10, vence 17) montado pela calculadora real; padrão: tudo em aberto
const ledgerOf = (
  opts: {
    today?: string;
    installments?: (Partial<LedgerInstallmentInput> & { dueDate: string; closingDate: string })[];
    payments?: Partial<LedgerPaymentInput>[];
  } = {},
): CardLedger =>
  buildCardLedger({
    card: { closingDay: 10, dueDay: 17, creditLimit: '5000.00' }, // decimal chega como string
    installments: (opts.installments ?? []).map((i, n) => ({
      id: `inst-${n + 1}`,
      transactionId: 'tx-uuid-1',
      transactionCreatedAt: '2026-01-05T12:00:00.000000Z',
      number: n + 1,
      amount: 100,
      ...i,
    })),
    charges: [],
    payments: (opts.payments ?? []).map((p, n) => ({
      id: `pay-${n + 1}`,
      invoiceMonth: '2026-03',
      amount: 100,
      paidOn: '2026-03-12',
      ...p,
    })),
    today: opts.today ?? '2026-01-01',
  });

const mockTx = (): Transaction =>
  ({
    id: 'tx-uuid-1',
    userId: USER_ID,
    description: 'Supermercado',
    totalAmount: 200,
    type: TransactionType.VARIABLE,
    date: new Date('2026-04-01'),
    items: [],
    installments: [],
    splits: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as Transaction;

describe('TransactionsService', () => {
  let service: TransactionsService;
  let txRepo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
    manager: { transaction: jest.Mock };
  };
  let em: { delete: jest.Mock; save: jest.Mock; getRepository: jest.Mock };
  let itemsRepo: { create: jest.Mock };
  let cardsService: jest.Mocked<CardsService>;
  let ledgers: { loadLedger: jest.Mock };
  let invoiceDates: { findRecorded: jest.Mock };
  let calculator: jest.Mocked<InstallmentCalculatorService>;

  beforeEach(async () => {
    txRepo = {
      create: jest.fn(),
      save: jest.fn(async (x) => x),
      findOne: jest.fn(),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(),
      manager: { transaction: jest.fn() },
    };
    em = {
      delete: jest.fn().mockResolvedValue({ affected: 3 }),
      save: jest.fn(async (_entity: unknown, value: unknown) => value),
      getRepository: jest.fn(() => txRepo),
    };
    txRepo.manager.transaction.mockImplementation(async (cb: (m: typeof em) => unknown) => cb(em));
    itemsRepo = { create: jest.fn() };
    cardsService = {
      findOne: jest.fn(),
      lockOwned: jest.fn().mockResolvedValue(mockCard()),
    } as unknown as jest.Mocked<CardsService>;
    ledgers = { loadLedger: jest.fn().mockResolvedValue(ledgerOf()) };
    invoiceDates = { findRecorded: jest.fn().mockResolvedValue(new Map()) };
    calculator = { calculate: jest.fn() } as unknown as jest.Mocked<InstallmentCalculatorService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionsService,
        { provide: getRepositoryToken(Transaction), useValue: txRepo },
        { provide: getRepositoryToken(TransactionItem), useValue: itemsRepo },
        { provide: CardsService, useValue: cardsService },
        { provide: InstallmentCalculatorService, useValue: calculator },
        { provide: InvoiceLedgerQuery, useValue: ledgers },
        { provide: CardInvoiceDatesService, useValue: invoiceDates },
      ],
    }).compile();

    service = module.get(TransactionsService);
  });

  describe('create', () => {
    it('cria transação simples sem cartão e sem parcelas', async () => {
      const tx = mockTx();
      txRepo.create.mockReturnValue(tx);
      txRepo.save.mockResolvedValue(tx);

      const result = await service.create(USER_ID, Plan.BASIC, {
        description: 'Supermercado',
        totalAmount: 200,
        date: '2026-04-01',
        type: TransactionType.VARIABLE,
      });

      expect(cardsService.lockOwned).not.toHaveBeenCalled();
      expect(calculator.calculate).not.toHaveBeenCalled();
      expect(result).toBe(tx);
    });

    it('calcula parcelas quando cardId e installmentsCount são informados', async () => {
      const tx = mockTx();
      txRepo.create.mockReturnValue(tx);
      txRepo.save.mockResolvedValue(tx);
      cardsService.lockOwned.mockResolvedValue(mockCard());
      calculator.calculate.mockReturnValue([]);

      await service.create(USER_ID, Plan.INTERMEDIATE, {
        description: 'TV',
        totalAmount: 1200,
        date: '2026-04-01',
        type: TransactionType.VARIABLE,
        cardId: 'card-uuid-1',
        installmentsCount: 12,
      });

      expect(cardsService.lockOwned).toHaveBeenCalledWith(em, 'card-uuid-1', USER_ID, {
        onNotOwned: expect.any(Function),
      });
      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 1200, installmentsCount: 12 }),
      );
    });

    it('repassa a data da compra como string (sem conversão de fuso)', async () => {
      txRepo.create.mockReturnValue(mockTx());
      cardsService.lockOwned.mockResolvedValue(mockCard());
      calculator.calculate.mockReturnValue([]);

      await service.create(USER_ID, Plan.INTERMEDIATE, {
        description: 'TV',
        totalAmount: 1200,
        date: '2026-01-11',
        type: TransactionType.VARIABLE,
        cardId: 'card-uuid-1',
        installmentsCount: 3,
      });

      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.objectContaining({ purchaseDate: '2026-01-11' }),
      );
    });

    it.each([undefined, 1])(
      'compra à vista no cartão (installmentsCount=%s) gera 1 parcela para entrar na fatura',
      async (installmentsCount) => {
        const installment = { number: 1, totalInstallments: 1, amount: 89.9 };
        txRepo.create.mockReturnValue(mockTx());
        cardsService.lockOwned.mockResolvedValue(mockCard());
        calculator.calculate.mockReturnValue([installment] as never);

        await service.create(USER_ID, Plan.INTERMEDIATE, {
          description: 'Farmácia',
          totalAmount: 89.9,
          date: '2026-04-01',
          type: TransactionType.VARIABLE,
          cardId: 'card-uuid-1',
          installmentsCount,
        });

        expect(calculator.calculate).toHaveBeenCalledWith(
          expect.objectContaining({ totalAmount: 89.9, installmentsCount: 1 }),
        );
        expect(txRepo.create).toHaveBeenCalledWith(
          expect.objectContaining({ installments: [installment] }),
        );
      },
    );

    it('lança UnprocessableEntityException se installmentsCount sem cardId', async () => {
      await expect(
        service.create(USER_ID, Plan.BASIC, {
          description: 'Erro',
          totalAmount: 100,
          date: '2026-04-01',
          type: TransactionType.VARIABLE,
          installmentsCount: 3,
        }),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('lança ForbiddenException se usuário BASIC informa cardId (cartões são INTERMEDIATE)', async () => {
      await expect(
        service.create(USER_ID, Plan.BASIC, {
          description: 'TV',
          totalAmount: 1200,
          date: '2026-04-01',
          type: TransactionType.VARIABLE,
          cardId: 'card-uuid-1',
          installmentsCount: 12,
        }),
      ).rejects.toThrow(new ForbiddenException('This feature requires the intermediate plan'));

      expect(cardsService.lockOwned).not.toHaveBeenCalled();
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('permite cardId para usuário PREMIUM', async () => {
      const tx = mockTx();
      txRepo.create.mockReturnValue(tx);
      txRepo.save.mockResolvedValue(tx);
      cardsService.lockOwned.mockResolvedValue(mockCard());

      await service.create(USER_ID, Plan.PREMIUM, {
        description: 'Mercado no cartão',
        totalAmount: 100,
        date: '2026-04-01',
        type: TransactionType.VARIABLE,
        cardId: 'card-uuid-1',
      });

      expect(cardsService.lockOwned).toHaveBeenCalledWith(em, 'card-uuid-1', USER_ID, {
        onNotOwned: expect.any(Function),
      });
      expect(txRepo.save).toHaveBeenCalled();
    });
    describe('com cartão: sob a trava do cartão', () => {
      const cardPurchase = {
        description: 'TV',
        totalAmount: 300,
        date: '2026-04-01',
        type: TransactionType.VARIABLE,
        cardId: 'card-uuid-1',
        installmentsCount: 3,
      };

      it('trava o cartão (com posse) e grava compra + parcelas na mesma transação de banco', async () => {
        const installments = [{ number: 1, closingDate: new Date(2026, 3, 10) }];
        txRepo.create.mockImplementation((x) => x);
        calculator.calculate.mockReturnValue(installments as never);

        await service.create(USER_ID, Plan.INTERMEDIATE, cardPurchase);

        expect(txRepo.manager.transaction).toHaveBeenCalled();
        expect(cardsService.lockOwned).toHaveBeenCalledWith(em, 'card-uuid-1', USER_ID, {
          onNotOwned: expect.any(Function),
        });
        expect(cardsService.findOne).not.toHaveBeenCalled();
        expect(em.getRepository).toHaveBeenCalledWith(Transaction);
        expect(txRepo.save).toHaveBeenCalledWith(expect.objectContaining({ installments }));
        expect(cardsService.lockOwned.mock.invocationCallOrder[0]).toBeLessThan(
          calculator.calculate.mock.invocationCallOrder[0],
        );
      });

      it('D32: lê as datas gravadas por fatura sob a trava (mesmo em) e repassa à calculadora', async () => {
        const recorded = new Map([
          ['2026-04', { closingDate: '2026-03-25', dueDate: '2026-04-05' }],
        ]);
        invoiceDates.findRecorded.mockResolvedValue(recorded);
        txRepo.create.mockImplementation((x) => x);
        calculator.calculate.mockReturnValue([] as never);

        await service.create(USER_ID, Plan.INTERMEDIATE, cardPurchase);

        expect(invoiceDates.findRecorded).toHaveBeenCalledWith(em, 'card-uuid-1', USER_ID);
        expect(calculator.calculate).toHaveBeenCalledWith(
          expect.objectContaining({ purchaseDate: '2026-04-01', recordedDates: recorded }),
        );
        expect(cardsService.lockOwned.mock.invocationCallOrder[0]).toBeLessThan(
          invoiceDates.findRecorded.mock.invocationCallOrder[0],
        );
      });

      it('cartão arquivado → 422 sem gravar (D12)', async () => {
        cardsService.lockOwned.mockResolvedValue({
          ...mockCard(),
          archivedAt: new Date('2026-03-01'),
        } as CreditCard);

        await expect(service.create(USER_ID, Plan.INTERMEDIATE, cardPurchase)).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.CARD_ARCHIVED),
        );
        expect(calculator.calculate).not.toHaveBeenCalled();
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      describe('D30: cardId do body inexistente ou alheio → 400 genérico', () => {
        it('trava com onNotOwned → 400 TRANSACTION_INVALID_CARD (where id + user_id em lockOwned)', async () => {
          txRepo.create.mockImplementation((x) => x);
          calculator.calculate.mockReturnValue([]);

          await service.create(USER_ID, Plan.INTERMEDIATE, cardPurchase);

          expect(cardsService.lockOwned).toHaveBeenCalledWith(em, 'card-uuid-1', USER_ID, {
            onNotOwned: expect.any(Function),
          });
          const [, , , opts] = cardsService.lockOwned.mock.calls[0];
          expect(opts?.onNotOwned?.()).toEqual(
            new BadRequestException(ErrorMessages.TRANSACTION_INVALID_CARD),
          );
        });

        // lockOwned com onNotOwned não encontra a linha (inexistente, alheio, alheio e arquivado
        // — nunca chega ao 422 CARD_ARCHIVED, que revelaria o estado) e lança o erro dele
        it('cartão não encontrado para o usuário → 400 sem gravar', async () => {
          cardsService.lockOwned.mockImplementation((_em, _id, _userId, opts) =>
            Promise.reject(opts?.onNotOwned?.() ?? new Error('sem onNotOwned')),
          );

          await expect(service.create(USER_ID, Plan.INTERMEDIATE, cardPurchase)).rejects.toThrow(
            new BadRequestException(ErrorMessages.TRANSACTION_INVALID_CARD),
          );
          expect(invoiceDates.findRecorded).not.toHaveBeenCalled();
          expect(calculator.calculate).not.toHaveBeenCalled();
          expect(txRepo.save).not.toHaveBeenCalled();
        });

        it('erro inesperado ao travar o cartão não vira 400', async () => {
          const boom = new Error('db down');
          cardsService.lockOwned.mockRejectedValue(boom);

          await expect(service.create(USER_ID, Plan.INTERMEDIATE, cardPurchase)).rejects.toBe(boom);
        });

        it('plano insuficiente continua 403 antes de olhar o cartão', async () => {
          await expect(service.create(USER_ID, Plan.BASIC, cardPurchase)).rejects.toThrow(
            new ForbiddenException(ErrorMessages.PLAN_REQUIRED(Plan.INTERMEDIATE)),
          );
          expect(cardsService.lockOwned).not.toHaveBeenCalled();
        });
      });

      describe('D29: total em centavos menor que o número de parcelas', () => {
        it('R$ 0,02 em 3x → 422 sem travar o cartão nem gravar', async () => {
          await expect(
            service.create(USER_ID, Plan.INTERMEDIATE, { ...cardPurchase, totalAmount: 0.02 }),
          ).rejects.toThrow(
            new UnprocessableEntityException(ErrorMessages.TOTAL_LESS_THAN_INSTALLMENTS),
          );
          expect(cardsService.lockOwned).not.toHaveBeenCalled();
          expect(calculator.calculate).not.toHaveBeenCalled();
          expect(txRepo.save).not.toHaveBeenCalled();
        });

        it('limite: R$ 0,03 em 3x (um centavo por parcela) é aceito', async () => {
          txRepo.create.mockImplementation((x) => x);
          calculator.calculate.mockReturnValue([]);

          await service.create(USER_ID, Plan.INTERMEDIATE, { ...cardPurchase, totalAmount: 0.03 });

          expect(calculator.calculate).toHaveBeenCalledWith(
            expect.objectContaining({ totalAmount: 0.03, installmentsCount: 3 }),
          );
          expect(txRepo.save).toHaveBeenCalled();
        });

        it('installmentsCount omitido no cartão conta como 1: R$ 0,01 é aceito', async () => {
          txRepo.create.mockImplementation((x) => x);
          calculator.calculate.mockReturnValue([]);
          const { installmentsCount: _omit, ...upfront } = cardPurchase;

          await service.create(USER_ID, Plan.INTERMEDIATE, { ...upfront, totalAmount: 0.01 });

          expect(calculator.calculate).toHaveBeenCalledWith(
            expect.objectContaining({ totalAmount: 0.01, installmentsCount: 1 }),
          );
        });
      });

      it('deadlock/serialização (40001) → 409', async () => {
        txRepo.manager.transaction.mockRejectedValue(
          new QueryFailedError('SQL', [], Object.assign(new Error('pg'), { code: '40001' })),
        );
        await expect(service.create(USER_ID, Plan.INTERMEDIATE, cardPurchase)).rejects.toThrow(
          new ConflictException(ErrorMessages.CONCURRENT_UPDATE),
        );
      });
    });
  });

  describe('findOne', () => {
    it('retorna a transação do usuário', async () => {
      txRepo.findOne.mockResolvedValue(mockTx());
      const result = await service.findOne('tx-uuid-1', USER_ID);
      expect(result.id).toBe('tx-uuid-1');
    });

    it('carrega itens, parcelas e splits com contato para qualquer plano (rebaixado lê)', async () => {
      txRepo.findOne.mockResolvedValue(mockTx());
      await service.findOne('tx-uuid-1', USER_ID);
      expect(txRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          relations: ['items', 'installments', 'splits', 'splits.contact'],
        }),
      );
    });

    it('lança NotFoundException se não encontrar', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(service.findOne('bad', USER_ID)).rejects.toThrow(NotFoundException);
    });

    it('lança ForbiddenException se transação pertence a outro usuário', async () => {
      txRepo.findOne.mockResolvedValue({ ...mockTx(), userId: 'other-user' });
      await expect(service.findOne('tx-uuid-1', USER_ID)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('consistência de valores no create', () => {
    const base = {
      description: 'Mercado',
      date: '2026-04-01',
      type: TransactionType.VARIABLE,
    };

    it('rejeita itens cuja soma difere do total', async () => {
      await expect(
        service.create(USER_ID, Plan.BASIC, {
          ...base,
          totalAmount: 100,
          items: [
            { name: 'Arroz', quantity: 2, unitPrice: 25 },
            { name: 'Feijão', quantity: 1, unitPrice: 40 },
          ],
        }),
      ).rejects.toThrow(new UnprocessableEntityException(ErrorMessages.ITEMS_TOTAL_MISMATCH));
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('aceita itens que somam exatamente o total (sem erro de ponto flutuante)', async () => {
      txRepo.create.mockReturnValue(mockTx());
      itemsRepo.create.mockImplementation((x) => x);

      await service.create(USER_ID, Plan.BASIC, {
        ...base,
        totalAmount: 0.3,
        items: [
          { name: 'A', quantity: 1, unitPrice: 0.1 },
          { name: 'B', quantity: 1, unitPrice: 0.2 },
        ],
      });
      expect(txRepo.save).toHaveBeenCalled();
    });

    it('sem itens não valida soma', async () => {
      txRepo.create.mockReturnValue(mockTx());
      await service.create(USER_ID, Plan.BASIC, { ...base, totalAmount: 100, items: [] });
      expect(txRepo.save).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    // parcela n vence em 2026-(n+2)-17 (coluna date chega como string)
    const pending = (n: number, total: number) =>
      ({
        id: `inst-${n}`,
        number: n,
        totalInstallments: total,
        status: 'pending',
        dueDate: `2026-${String(n + 2).padStart(2, '0')}-17`,
      }) as never;

    const cardTx = (overrides: Partial<Transaction> = {}): Transaction =>
      ({
        ...mockTx(),
        totalAmount: '300.00' as unknown as number, // decimal chega como string do Postgres
        date: '2026-01-05' as unknown as Date, // coluna date chega como string
        cardId: 'card-uuid-1',
        installments: [pending(1, 3), pending(2, 3), pending(3, 3)],
        splits: [],
        items: [],
        ...overrides,
      }) as Transaction;

    it('alteração que não envolve valor/data apenas salva, sem recalcular', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      txRepo.save.mockImplementation(async (x) => x);

      const result = await service.update('tx-uuid-1', USER_ID, { description: 'Novo nome' });

      expect(result.description).toBe('Novo nome');
      expect(calculator.calculate).not.toHaveBeenCalled();
      expect(em.delete).not.toHaveBeenCalled();
      // leitura e checagens acontecem depois de travar a linha da transação
      expect(txRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'tx-uuid-1' },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('mesmo valor/data (número vs string do banco) não dispara recálculo', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      txRepo.save.mockImplementation(async (x) => x);

      await service.update('tx-uuid-1', USER_ID, { totalAmount: 300, date: '2026-01-05' });

      expect(calculator.calculate).not.toHaveBeenCalled();
    });

    // Parcelas recalculadas (calculadora mockada) com vencimento em `months` (dia 17)
    const recalculated = (...months: string[]) =>
      months.map((m, i) => {
        const [y, mo] = m.split('-').map(Number);
        return { number: i + 1, dueDate: new Date(y, mo - 1, 17) };
      });

    it('mudança de data recalcula as parcelas sob a trava do cartão, com os dias atuais', async () => {
      const newInstallments = recalculated('2026-03', '2026-04', '2026-05');
      txRepo.findOne.mockResolvedValue(cardTx());
      calculator.calculate.mockReturnValue(newInstallments as never);

      const result = await service.update('tx-uuid-1', USER_ID, { date: '2026-02-20' });

      expect(cardsService.lockOwned).toHaveBeenCalledWith(em, 'card-uuid-1', USER_ID);
      expect(ledgers.loadLedger).toHaveBeenCalledWith(USER_ID, 'card-uuid-1', em);
      expect(calculator.calculate).toHaveBeenCalledWith({
        totalAmount: 300,
        purchaseDate: '2026-02-20',
        installmentsCount: 3,
        card: mockCard(),
        recordedDates: new Map(),
      });
      // o pagamento (único escritor concorrente) está serializado pela trava do cartão
      expect(em.delete).toHaveBeenCalledWith(Installment, { transactionId: 'tx-uuid-1' });
      expect(txRepo.save).toHaveBeenCalled();
      expect(result.installments).toBe(newInstallments);
    });

    it('D32: o recálculo por mudança de data recebe as datas gravadas por fatura do razão (mesmo em)', async () => {
      const ledger = buildCardLedger({
        card: { closingDay: 10, dueDay: 17, creditLimit: '5000.00' },
        installments: [],
        charges: [],
        payments: [],
        recordedDates: [
          { invoiceMonth: '2026-03', closingDate: '2026-03-05', dueDate: '2026-03-12' },
        ],
        today: '2026-01-01',
      });
      ledgers.loadLedger.mockResolvedValue(ledger);
      txRepo.findOne.mockResolvedValue(cardTx());
      calculator.calculate.mockReturnValue(recalculated('2026-04', '2026-05', '2026-06') as never);

      await service.update('tx-uuid-1', USER_ID, { date: '2026-03-06' });

      expect(ledgers.loadLedger).toHaveBeenCalledWith(USER_ID, 'card-uuid-1', em);
      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.objectContaining({ recordedDates: ledger.recordedDates }),
      );
      expect(Object.fromEntries(ledger.recordedDates)).toEqual({
        '2026-03': { closingDate: '2026-03-05', dueDate: '2026-03-12' },
      });
    });

    it('mudança de valor e data juntas recalcula datas e valores', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      calculator.calculate.mockReturnValue(recalculated('2026-04', '2026-05', '2026-06') as never);

      await service.update('tx-uuid-1', USER_ID, { totalAmount: 600, date: '2026-02-20' });

      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 600, purchaseDate: '2026-02-20' }),
      );
      expect(em.delete).toHaveBeenCalled();
    });

    it('D29: valor e data juntos com total menor que o número de parcelas → 422 sem recalcular', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());

      await expect(
        service.update('tx-uuid-1', USER_ID, { totalAmount: 0.02, date: '2026-02-20' }),
      ).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.TOTAL_LESS_THAN_INSTALLMENTS),
      );
      expect(calculator.calculate).not.toHaveBeenCalled();
      expect(em.delete).not.toHaveBeenCalled();
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('D29 limite: valor e data juntos com R$ 0,03 em 3x recalcula', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      calculator.calculate.mockReturnValue(recalculated('2026-04', '2026-05', '2026-06') as never);

      await service.update('tx-uuid-1', USER_ID, { totalAmount: 0.03, date: '2026-02-20' });

      expect(calculator.calculate).toHaveBeenCalledWith(
        expect.objectContaining({ totalAmount: 0.03, installmentsCount: 3 }),
      );
      expect(txRepo.save).toHaveBeenCalled();
    });

    it('D29 não se aplica a transação sem parcelas (R$ 0,01 à vista)', async () => {
      txRepo.findOne.mockResolvedValue(mockTx());

      const result = await service.update('tx-uuid-1', USER_ID, { totalAmount: 0.01 });

      expect(result.totalAmount).toBe(0.01);
      expect(txRepo.save).toHaveBeenCalled();
    });

    describe('D26: mudança só de valor mantém mês e datas das parcelas', () => {
      // parcelas gravadas com datas que os dias atuais do cartão (fecha 10, vence 17) não
      // gerariam — simula cartão com dias alterados depois da compra (D14)
      const stored = () =>
        cardTx({
          installments: [1, 2, 3].map((n) => ({
            id: `inst-${n}`,
            number: n,
            totalInstallments: 3,
            amount: '100.00',
            status: 'pending',
            dueDate: `2026-0${n + 2}-05`,
            closingDate: `2026-0${n + 1}-25`,
            transactionId: 'tx-uuid-1',
          })) as never,
        });

      it('redistribui só os valores (floor, resto na última) sem recalcular datas', async () => {
        txRepo.findOne.mockResolvedValue(stored());

        const result = await service.update('tx-uuid-1', USER_ID, { totalAmount: 100 });

        expect(calculator.calculate).not.toHaveBeenCalled();
        expect(em.delete).not.toHaveBeenCalled();
        expect(result.installments.map((i) => [i.id, i.amount, i.dueDate, i.closingDate])).toEqual([
          ['inst-1', 33.33, '2026-03-05', '2026-02-25'],
          ['inst-2', 33.33, '2026-04-05', '2026-03-25'],
          ['inst-3', 33.34, '2026-05-05', '2026-04-25'],
        ]);
        expect(result.totalAmount).toBe(100);
        expect(txRepo.save).toHaveBeenCalledWith(result);
      });

      it('D29: novo total menor que o número de parcelas (R$ 0,02 em 3x) → 422 sem gravar', async () => {
        txRepo.findOne.mockResolvedValue(stored());

        await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 0.02 })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.TOTAL_LESS_THAN_INSTALLMENTS),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it('D29 limite: R$ 0,03 em 3x é aceito (R$ 0,01 por parcela)', async () => {
        txRepo.findOne.mockResolvedValue(stored());

        const result = await service.update('tx-uuid-1', USER_ID, { totalAmount: 0.03 });

        expect(result.installments.map((i) => i.amount)).toEqual([0.01, 0.01, 0.01]);
        expect(txRepo.save).toHaveBeenCalledWith(result);
      });

      it('a parcela de maior número recebe o resto mesmo fora de ordem na relação', async () => {
        const tx = stored();
        tx.installments = [...tx.installments].reverse();
        txRepo.findOne.mockResolvedValue(tx);

        const result = await service.update('tx-uuid-1', USER_ID, { totalAmount: 100 });

        const byNumber = new Map(result.installments.map((i) => [i.number, i.amount]));
        expect([1, 2, 3].map((n) => byNumber.get(n))).toEqual([33.33, 33.33, 33.34]);
      });

      it('parcela em fatura fechada não coberta: valor muda e ela continua na mesma fatura', async () => {
        txRepo.findOne.mockResolvedValue(stored());
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [{ dueDate: '2026-03-05', closingDate: '2026-02-25' }],
          }),
        );

        const result = await service.update('tx-uuid-1', USER_ID, { totalAmount: 450 });

        expect(result.installments.map((i) => [i.amount, i.dueDate])).toEqual([
          [150, '2026-03-05'],
          [150, '2026-04-05'],
          [150, '2026-05-05'],
        ]);
      });

      it('D20 continua valendo: coberta em fatura fechada → 422 sem gravar', async () => {
        txRepo.findOne.mockResolvedValue(stored());
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [{ dueDate: '2026-03-05', closingDate: '2026-02-25' }],
            payments: [{}],
          }),
        );

        await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });
    });

    it('trava o cartão antes da transação (ordem global cartão → transação)', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      calculator.calculate.mockReturnValue(recalculated('2026-03') as never);

      await service.update('tx-uuid-1', USER_ID, { totalAmount: 450 });

      const lockTxCall = txRepo.findOne.mock.calls.findIndex(
        ([opts]) => opts.lock?.mode === 'pessimistic_write',
      );
      expect(lockTxCall).toBeGreaterThan(0); // antes: só a leitura de card_id, sem trava
      expect(txRepo.findOne.mock.calls[0][0]).not.toHaveProperty('lock');
      expect(cardsService.lockOwned.mock.invocationCallOrder[0]).toBeLessThan(
        txRepo.findOne.mock.invocationCallOrder[lockTxCall],
      );
    });

    it('card_id diferente depois da trava → 409 sem gravar', async () => {
      txRepo.findOne
        .mockResolvedValueOnce(cardTx()) // leitura sem trava
        .mockResolvedValue(cardTx({ cardId: 'card-uuid-2' }));

      await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
        new ConflictException(ErrorMessages.CONCURRENT_UPDATE),
      );
      expect(txRepo.save).not.toHaveBeenCalled();
    });

    it('transação de outro usuário → 403 sem travar o cartão', async () => {
      txRepo.findOne.mockResolvedValue(cardTx({ userId: 'other-user' }));
      await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
        ForbiddenException,
      );
      expect(cardsService.lockOwned).not.toHaveBeenCalled();
    });

    it('transação inexistente → 404', async () => {
      txRepo.findOne.mockResolvedValue(null);
      await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('transação sem cartão não trava cartão', async () => {
      txRepo.findOne.mockResolvedValue(cardTx({ cardId: null, installments: [] }));
      await service.update('tx-uuid-1', USER_ID, { description: 'X' });
      expect(cardsService.lockOwned).not.toHaveBeenCalled();
    });

    describe('D20: parcela coberta em fatura fechada', () => {
      const closedMarch = { dueDate: '2026-03-17', closingDate: '2026-03-10' };
      const openApril = { dueDate: '2026-04-17', closingDate: '2026-04-10' };

      it('coberta em fatura já fechada → 422 sem apagar nem salvar', async () => {
        txRepo.findOne.mockResolvedValue(cardTx());
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({ today: '2026-03-15', installments: [closedMarch], payments: [{}] }),
        );

        await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
        );
        expect(em.delete).not.toHaveBeenCalled();
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it('parcialmente coberta em fatura fechada também bloqueia', async () => {
        txRepo.findOne.mockResolvedValue(cardTx());
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [closedMarch],
            payments: [{ amount: 1 }],
          }),
        );
        await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
        );
      });

      it('coberta em fatura ainda aberta → permite (o pagamento só se realoca)', async () => {
        txRepo.findOne.mockResolvedValue(cardTx());
        calculator.calculate.mockReturnValue(recalculated('2026-04') as never);
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [openApril],
            payments: [{ invoiceMonth: '2026-04' }],
          }),
        );

        await service.update('tx-uuid-1', USER_ID, { totalAmount: 450 });
        expect(txRepo.save).toHaveBeenCalled();
      });

      it('em fatura fechada mas não coberta → permite (D13: a fatura recalcula)', async () => {
        txRepo.findOne.mockResolvedValue(cardTx());
        calculator.calculate.mockReturnValue(recalculated('2026-03') as never);
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({ today: '2026-03-15', installments: [closedMarch] }),
        );

        await service.update('tx-uuid-1', USER_ID, { totalAmount: 450 });
        expect(txRepo.save).toHaveBeenCalled();
      });

      it('só olha as parcelas desta transação (outra compra coberta não bloqueia)', async () => {
        txRepo.findOne.mockResolvedValue(cardTx());
        calculator.calculate.mockReturnValue(recalculated('2026-04') as never);
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [{ ...closedMarch, transactionId: 'other-tx' }],
            payments: [{}],
          }),
        );

        await service.update('tx-uuid-1', USER_ID, { totalAmount: 450 });
        expect(txRepo.save).toHaveBeenCalled();
      });
    });

    describe('D24: nova data com parcela em fatura já fechada', () => {
      it.each([
        ['véspera do fechamento (aberta)', '2026-04-09', true],
        ['dia do fechamento (fechada)', '2026-04-10', false],
      ])('fatura 2026-04 (fecha 10/04) com hoje na %s', async (_label, today, allowed) => {
        txRepo.findOne.mockResolvedValue(cardTx());
        calculator.calculate.mockReturnValue(recalculated('2026-04', '2026-05') as never);
        ledgers.loadLedger.mockResolvedValue(ledgerOf({ today }));

        const result = service.update('tx-uuid-1', USER_ID, { date: '2026-03-20' });

        if (allowed) {
          await result;
          expect(em.delete).toHaveBeenCalled();
        } else {
          await expect(result).rejects.toThrow(
            new UnprocessableEntityException(ErrorMessages.PURCHASE_DATE_IN_CLOSED_INVOICE),
          );
          expect(em.delete).not.toHaveBeenCalled();
          expect(txRepo.save).not.toHaveBeenCalled();
        }
      });

      // parcelas nos meses informados; fatura 2026-03 fechada (hoje 15/03)
      const inMonths = (...months: string[]) =>
        cardTx({
          installments: months.map((m, i) => ({
            ...(pending(i + 1, months.length) as object),
            dueDate: `${m}-17`,
          })) as never,
        });

      it('mesma data dentro da mesma fatura fechada (não coberta) → 422', async () => {
        txRepo.findOne.mockResolvedValue(inMonths('2026-03'));
        calculator.calculate.mockReturnValue(recalculated('2026-03') as never);
        ledgers.loadLedger.mockResolvedValue(ledgerOf({ today: '2026-03-15' }));
        await expect(service.update('tx-uuid-1', USER_ID, { date: '2026-02-22' })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PURCHASE_DATE_IN_CLOSED_INVOICE),
        );
      });

      it('D27: nova data que tira parcela não coberta de fatura fechada → permite', async () => {
        txRepo.findOne.mockResolvedValue(inMonths('2026-03')); // fatura 2026-03 fechada
        calculator.calculate.mockReturnValue(recalculated('2026-04') as never); // aberta
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [{ dueDate: '2026-03-17', closingDate: '2026-03-10' }],
          }),
        );

        await service.update('tx-uuid-1', USER_ID, { date: '2026-03-12' });

        expect(em.delete).toHaveBeenCalledWith(Installment, { transactionId: 'tx-uuid-1' });
        expect(txRepo.save).toHaveBeenCalled();
      });

      it('mudança só de valor não aplica D24 (D26: fatura fechada não coberta, sem recálculo)', async () => {
        txRepo.findOne.mockResolvedValue(inMonths('2026-03'));
        ledgers.loadLedger.mockResolvedValue(ledgerOf({ today: '2026-03-15' }));

        await service.update('tx-uuid-1', USER_ID, { totalAmount: 450 });
        expect(calculator.calculate).not.toHaveBeenCalled();
        expect(em.delete).not.toHaveBeenCalled();
        expect(txRepo.save).toHaveBeenCalled();
      });

      it('D20 na mudança de data: tirar parcela coberta de fatura fechada → 422 sem gravar', async () => {
        txRepo.findOne.mockResolvedValue(inMonths('2026-03'));
        calculator.calculate.mockReturnValue(recalculated('2026-04') as never); // destino aberto
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [{ dueDate: '2026-03-17', closingDate: '2026-03-10' }],
            payments: [{}],
          }),
        );

        await expect(service.update('tx-uuid-1', USER_ID, { date: '2026-03-12' })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
        );
        expect(em.delete).not.toHaveBeenCalled();
        expect(txRepo.save).not.toHaveBeenCalled();
      });
    });

    it('cartão arquivado: edição de compra existente é permitida (D12)', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      cardsService.lockOwned.mockResolvedValue({
        ...mockCard(),
        archivedAt: new Date('2026-01-02'),
      } as CreditCard);
      calculator.calculate.mockReturnValue(recalculated('2026-03') as never);

      await service.update('tx-uuid-1', USER_ID, { totalAmount: 450 });
      expect(txRepo.save).toHaveBeenCalled();
    });

    it('cartão arquivado: D20 continua valendo (coberta em fatura fechada → 422)', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      cardsService.lockOwned.mockResolvedValue({
        ...mockCard(),
        archivedAt: new Date('2026-01-02'),
      } as CreditCard);
      ledgers.loadLedger.mockResolvedValue(
        ledgerOf({
          today: '2026-03-15',
          installments: [{ dueDate: '2026-03-17', closingDate: '2026-03-10' }],
          payments: [{}],
        }),
      );
      await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
      );
    });

    it('deadlock (40P01) na transação de banco → 409', async () => {
      txRepo.manager.transaction.mockRejectedValue(
        new QueryFailedError('SQL', [], Object.assign(new Error('pg'), { code: '40P01' })),
      );
      await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 450 })).rejects.toThrow(
        new ConflictException(ErrorMessages.CONCURRENT_UPDATE),
      );
    });

    it('data com hora no mesmo dia não conta como mudança de data', async () => {
      txRepo.findOne.mockResolvedValue(cardTx());
      await service.update('tx-uuid-1', USER_ID, { date: '2026-01-05T00:00:00.000Z' });
      expect(calculator.calculate).not.toHaveBeenCalled();
    });

    it('aceita novo total igual à soma dos splits', async () => {
      txRepo.findOne.mockResolvedValue(
        cardTx({ installments: [], splits: [{ assignedAmount: '200.00' }] as never }),
      );
      const result = await service.update('tx-uuid-1', USER_ID, { totalAmount: 200 });
      expect(result.totalAmount).toBe(200);
    });

    it('bloqueia mudança de valor/data se o cartão da transação foi removido', async () => {
      txRepo.findOne.mockResolvedValue(cardTx({ cardId: null }));

      await expect(service.update('tx-uuid-1', USER_ID, { date: '2026-03-01' })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.CARD_REQUIRED_FOR_RECALC),
      );
    });

    describe('D29: ordem das checagens na edição', () => {
      it('órfã legada (cardId null) com R$ 0,02 em 3x → TOTAL_LESS_THAN_INSTALLMENTS, não CARD_REQUIRED_FOR_RECALC', async () => {
        txRepo.findOne.mockResolvedValue(cardTx({ cardId: null }));

        await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 0.02 })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.TOTAL_LESS_THAN_INSTALLMENTS),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it('compra coberta em fatura fechada (D20) + total pequeno → D29 primeiro, sem ler o razão', async () => {
        txRepo.findOne.mockResolvedValue(cardTx());
        ledgers.loadLedger.mockResolvedValue(
          ledgerOf({
            today: '2026-03-15',
            installments: [{ dueDate: '2026-03-17', closingDate: '2026-03-10' }],
            payments: [{}],
          }),
        );

        await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 0.02 })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.TOTAL_LESS_THAN_INSTALLMENTS),
        );
        expect(ledgers.loadLedger).not.toHaveBeenCalled();
        expect(em.delete).not.toHaveBeenCalled();
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it('edição só de data de compra antiga já com parcelas de R$ 0,00 não é bloqueada', async () => {
        txRepo.findOne.mockResolvedValue(cardTx({ totalAmount: '0.02' as unknown as number }));
        calculator.calculate.mockReturnValue(
          recalculated('2026-04', '2026-05', '2026-06') as never,
        );

        await service.update('tx-uuid-1', USER_ID, { date: '2026-02-20' });

        expect(calculator.calculate).toHaveBeenCalledWith(
          expect.objectContaining({ totalAmount: 0.02, installmentsCount: 3 }),
        );
        expect(txRepo.save).toHaveBeenCalled();
      });
    });

    it('rejeita novo total diferente da soma dos itens', async () => {
      txRepo.findOne.mockResolvedValue(
        cardTx({
          installments: [],
          items: [{ quantity: 3, unitPrice: '100.00' }] as never,
        }),
      );

      await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 250 })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.ITEMS_TOTAL_MISMATCH),
      );
    });

    it('rejeita novo total menor que a soma dos splits já atribuídos', async () => {
      txRepo.findOne.mockResolvedValue(
        cardTx({
          installments: [],
          splits: [{ assignedAmount: '150.00' }, { assignedAmount: '100.00' }] as never,
        }),
      );

      await expect(service.update('tx-uuid-1', USER_ID, { totalAmount: 200 })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.SPLITS_EXCEED_TOTAL),
      );
    });

    it('transação sem cartão e sem parcelas muda de valor livremente', async () => {
      txRepo.findOne.mockResolvedValue(cardTx({ cardId: null, installments: [] }));
      txRepo.save.mockImplementation(async (x) => x);

      const result = await service.update('tx-uuid-1', USER_ID, { totalAmount: 999 });

      expect(result.totalAmount).toBe(999);
      expect(calculator.calculate).not.toHaveBeenCalled();
    });
  });

  describe('runLocked', () => {
    it('sem lockCard (splits) trava só a transação, mesmo com cartão', async () => {
      txRepo.findOne.mockResolvedValue({ ...mockTx(), cardId: 'card-uuid-1' });
      const work = jest.fn().mockResolvedValue('ok');

      await expect(service.runLocked('tx-uuid-1', USER_ID, work)).resolves.toBe('ok');

      expect(cardsService.lockOwned).not.toHaveBeenCalled();
      expect(txRepo.findOne.mock.calls[0][0]).toEqual({
        where: { id: 'tx-uuid-1' },
        lock: { mode: 'pessimistic_write' },
      });
      expect(work).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'tx-uuid-1' }),
        em,
        undefined,
      );
    });

    it('com lockCard entrega o cartão travado ao trabalho', async () => {
      txRepo.findOne.mockResolvedValue({ ...mockTx(), cardId: 'card-uuid-1' });
      const work = jest.fn().mockResolvedValue('ok');

      await service.runLocked('tx-uuid-1', USER_ID, work, { lockCard: true });

      expect(work).toHaveBeenCalledWith(expect.anything(), em, mockCard());
    });

    describe('onNotOwned (D30: ID da transação veio do body)', () => {
      const asBodyRef = () => new BadRequestException(ErrorMessages.SPLIT_INVALID_TRANSACTION);

      it.each([
        ['inexistente', null],
        ['de outro usuário', { ...mockTx(), userId: 'other-user' }],
      ])('transação %s → erro de onNotOwned, sem executar o trabalho', async (_, found) => {
        txRepo.findOne.mockResolvedValue(found);
        const work = jest.fn();

        await expect(
          service.runLocked('tx-uuid-1', USER_ID, work, { onNotOwned: asBodyRef }),
        ).rejects.toThrow(new BadRequestException(ErrorMessages.SPLIT_INVALID_TRANSACTION));
        expect(work).not.toHaveBeenCalled();
      });

      it('a trava filtra por id E user_id (linha alheia nunca é travada)', async () => {
        txRepo.findOne.mockResolvedValue(mockTx());

        await service.runLocked('tx-uuid-1', USER_ID, jest.fn(), { onNotOwned: asBodyRef });

        expect(txRepo.findOne.mock.calls[0][0]).toEqual({
          where: { id: 'tx-uuid-1', userId: USER_ID },
          lock: { mode: 'pessimistic_write' },
        });
      });

      it('com lockCard: peek e trava filtram por id E user_id; cartão antes da transação', async () => {
        txRepo.findOne.mockResolvedValue({ ...mockTx(), cardId: 'card-uuid-1' });

        await service.runLocked('tx-uuid-1', USER_ID, jest.fn(), {
          lockCard: true,
          onNotOwned: asBodyRef,
        });

        expect(txRepo.findOne.mock.calls[0][0]).toEqual({
          where: { id: 'tx-uuid-1', userId: USER_ID },
          select: { id: true, userId: true, cardId: true },
        });
        expect(txRepo.findOne.mock.calls[1][0]).toEqual({
          where: { id: 'tx-uuid-1', userId: USER_ID },
          lock: { mode: 'pessimistic_write' },
        });
        expect(cardsService.lockOwned.mock.invocationCallOrder[0]).toBeLessThan(
          txRepo.findOne.mock.invocationCallOrder[1],
        );
      });

      it('com lockCard e transação não encontrada para o usuário → erro de onNotOwned, sem travar cartão', async () => {
        txRepo.findOne.mockResolvedValue(null);

        await expect(
          service.runLocked('tx-uuid-1', USER_ID, jest.fn(), {
            lockCard: true,
            onNotOwned: asBodyRef,
          }),
        ).rejects.toThrow(new BadRequestException(ErrorMessages.SPLIT_INVALID_TRANSACTION));
        expect(cardsService.lockOwned).not.toHaveBeenCalled();
      });

      it('erro lançado pelo trabalho não é convertido', async () => {
        txRepo.findOne.mockResolvedValue(mockTx());
        const inner = new NotFoundException(ErrorMessages.NOT_FOUND.SPLIT);

        await expect(
          service.runLocked('tx-uuid-1', USER_ID, () => Promise.reject(inner), {
            onNotOwned: asBodyRef,
          }),
        ).rejects.toBe(inner);
      });

      it('sem onNotOwned continua 404/403 (recurso da rota)', async () => {
        txRepo.findOne.mockResolvedValue(null);
        await expect(service.runLocked('tx-uuid-1', USER_ID, jest.fn())).rejects.toThrow(
          new NotFoundException(ErrorMessages.NOT_FOUND.TRANSACTION),
        );
      });
    });
  });

  describe('remove', () => {
    const txWithSplits = (statuses: string[]) =>
      ({ ...mockTx(), splits: statuses.map((status, i) => ({ id: `s-${i}`, status })) }) as never;

    it('bloqueia (409) se alguém ainda deve parte da transação', async () => {
      txRepo.findOne.mockResolvedValue(txWithSplits(['paid', 'pending']));
      await expect(service.remove('tx-uuid-1', USER_ID)).rejects.toThrow(
        new ConflictException(ErrorMessages.TRANSACTION_HAS_PENDING_SPLITS),
      );
      expect(txRepo.remove).not.toHaveBeenCalled();
    });

    it('remove sob trava quando os splits estão todos pagos (ou não há splits)', async () => {
      txRepo.findOne.mockResolvedValue(txWithSplits(['paid']));
      await service.remove('tx-uuid-1', USER_ID);
      expect(txRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
      );
      expect(txRepo.remove).toHaveBeenCalled();
    });

    it('compra no cartão: trava o cartão antes da transação', async () => {
      txRepo.findOne.mockResolvedValue({
        ...(txWithSplits(['paid']) as object),
        cardId: 'card-uuid-1',
      });
      await service.remove('tx-uuid-1', USER_ID);

      const lockTxCall = txRepo.findOne.mock.calls.findIndex(
        ([opts]) => opts.lock?.mode === 'pessimistic_write',
      );
      expect(cardsService.lockOwned).toHaveBeenCalledWith(em, 'card-uuid-1', USER_ID);
      expect(cardsService.lockOwned.mock.invocationCallOrder[0]).toBeLessThan(
        txRepo.findOne.mock.invocationCallOrder[lockTxCall],
      );
      expect(txRepo.remove).toHaveBeenCalled();
    });

    it('compra no cartão com split pendente → 409 (mesmo sob a trava do cartão)', async () => {
      txRepo.findOne.mockResolvedValue({
        ...(txWithSplits(['pending']) as object),
        cardId: 'card-uuid-1',
      });
      await expect(service.remove('tx-uuid-1', USER_ID)).rejects.toThrow(
        new ConflictException(ErrorMessages.TRANSACTION_HAS_PENDING_SPLITS),
      );
      expect(txRepo.remove).not.toHaveBeenCalled();
    });

    it('transação de outro usuário → 403 sem remover', async () => {
      txRepo.findOne.mockResolvedValue({ ...mockTx(), userId: 'other-user' });
      await expect(service.remove('tx-uuid-1', USER_ID)).rejects.toThrow(ForbiddenException);
      expect(txRepo.remove).not.toHaveBeenCalled();
    });
  });

  describe('forma de pagamento (paymentMethod)', () => {
    const upfront = [
      PaymentMethod.PIX,
      PaymentMethod.CASH,
      PaymentMethod.DEBIT,
      PaymentMethod.TRANSFER,
      PaymentMethod.BOLETO,
    ];
    const base = {
      description: 'Compra',
      totalAmount: 100,
      date: '2026-04-01',
      type: TransactionType.VARIABLE,
    };
    const createdWith = () => txRepo.create.mock.calls[0][0];

    beforeEach(() => {
      txRepo.create.mockImplementation((x) => x);
      cardsService.lockOwned.mockResolvedValue(mockCard());
      calculator.calculate.mockReturnValue([]);
    });

    describe('create', () => {
      it('com cartão e forma omitida → credit_card', async () => {
        await service.create(USER_ID, Plan.INTERMEDIATE, { ...base, cardId: 'card-uuid-1' });
        expect(createdWith()).toEqual(
          expect.objectContaining({
            cardId: 'card-uuid-1',
            paymentMethod: PaymentMethod.CREDIT_CARD,
          }),
        );
      });

      it('com cartão e credit_card explícito → aceita', async () => {
        await service.create(USER_ID, Plan.INTERMEDIATE, {
          ...base,
          cardId: 'card-uuid-1',
          paymentMethod: PaymentMethod.CREDIT_CARD,
        });
        expect(createdWith().paymentMethod).toBe(PaymentMethod.CREDIT_CARD);
      });

      it.each(upfront)('com cartão e forma à vista (%s) → 422 sem gravar', async (pm) => {
        await expect(
          service.create(USER_ID, Plan.INTERMEDIATE, {
            ...base,
            cardId: 'card-uuid-1',
            paymentMethod: pm,
          }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.CARD_REQUIRES_CREDIT_CARD_METHOD),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it('sem cartão e forma omitida → pix (D15)', async () => {
        await service.create(USER_ID, Plan.BASIC, base);
        expect(createdWith()).toEqual(
          expect.objectContaining({ cardId: null, paymentMethod: PaymentMethod.PIX }),
        );
      });

      it.each(upfront)('sem cartão e forma à vista (%s) → grava a forma', async (pm) => {
        await service.create(USER_ID, Plan.BASIC, { ...base, paymentMethod: pm });
        expect(createdWith().paymentMethod).toBe(pm);
      });

      it('sem cartão, credit_card e parcelado → 422 da forma (checada antes das parcelas)', async () => {
        await expect(
          service.create(USER_ID, Plan.BASIC, {
            ...base,
            paymentMethod: PaymentMethod.CREDIT_CARD,
            installmentsCount: 3,
          }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.CREDIT_CARD_METHOD_REQUIRES_CARD),
        );
      });

      it('sem cartão e credit_card → 422 sem gravar', async () => {
        await expect(
          service.create(USER_ID, Plan.BASIC, {
            ...base,
            paymentMethod: PaymentMethod.CREDIT_CARD,
          }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.CREDIT_CARD_METHOD_REQUIRES_CARD),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });
    });

    describe('update', () => {
      const upfrontTx = (paymentMethod: PaymentMethod | null, overrides = {}) =>
        ({ ...mockTx(), cardId: null, paymentMethod, ...overrides }) as unknown as Transaction;
      const cardTx = () =>
        ({
          ...mockTx(),
          cardId: 'card-uuid-1',
          paymentMethod: PaymentMethod.CREDIT_CARD,
          installments: [{ id: 'inst-1', number: 1, totalInstallments: 1, status: 'pending' }],
        }) as unknown as Transaction;

      beforeEach(() => txRepo.save.mockImplementation(async (x) => x));

      it.each([
        [PaymentMethod.PIX, PaymentMethod.CASH],
        [PaymentMethod.CASH, PaymentMethod.DEBIT],
        [PaymentMethod.DEBIT, PaymentMethod.TRANSFER],
        [PaymentMethod.TRANSFER, PaymentMethod.BOLETO],
        [PaymentMethod.BOLETO, PaymentMethod.PIX],
      ])('troca entre formas à vista (%s → %s) sob trava', async (from, to) => {
        txRepo.findOne.mockResolvedValue(upfrontTx(from));

        const result = await service.update('tx-uuid-1', USER_ID, { paymentMethod: to });

        expect(result.paymentMethod).toBe(to);
        expect(txRepo.findOne).toHaveBeenCalledWith(
          expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
        );
      });

      it('à vista → credit_card → 422 sem gravar', async () => {
        txRepo.findOne.mockResolvedValue(upfrontTx(PaymentMethod.PIX));
        await expect(
          service.update('tx-uuid-1', USER_ID, { paymentMethod: PaymentMethod.CREDIT_CARD }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PAYMENT_METHOD_CHANGE_NOT_ALLOWED),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it.each(upfront)('credit_card → %s → 422 sem gravar', async (pm) => {
        txRepo.findOne.mockResolvedValue(cardTx());
        await expect(service.update('tx-uuid-1', USER_ID, { paymentMethod: pm })).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PAYMENT_METHOD_CHANGE_NOT_ALLOWED),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it('credit_card → credit_card (mesmo valor) não é troca e salva', async () => {
        txRepo.findOne.mockResolvedValue(cardTx());
        const result = await service.update('tx-uuid-1', USER_ID, {
          paymentMethod: PaymentMethod.CREDIT_CARD,
          description: 'Novo',
        });
        expect(result.paymentMethod).toBe(PaymentMethod.CREDIT_CARD);
        expect(result.description).toBe('Novo');
      });

      it('legado null sem cartão nem parcelas → aceita forma à vista', async () => {
        txRepo.findOne.mockResolvedValue(upfrontTx(null));
        const result = await service.update('tx-uuid-1', USER_ID, {
          paymentMethod: PaymentMethod.CASH,
        });
        expect(result.paymentMethod).toBe(PaymentMethod.CASH);
      });

      it('legado null → credit_card → 422', async () => {
        txRepo.findOne.mockResolvedValue(upfrontTx(null));
        await expect(
          service.update('tx-uuid-1', USER_ID, { paymentMethod: PaymentMethod.CREDIT_CARD }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PAYMENT_METHOD_CHANGE_NOT_ALLOWED),
        );
      });

      it('legado null com parcelas (cartão removido) → forma à vista → 422', async () => {
        txRepo.findOne.mockResolvedValue(
          upfrontTx(null, {
            installments: [{ id: 'inst-1', number: 1, totalInstallments: 1, status: 'pending' }],
          }),
        );
        await expect(
          service.update('tx-uuid-1', USER_ID, { paymentMethod: PaymentMethod.PIX }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PAYMENT_METHOD_CHANGE_NOT_ALLOWED),
        );
      });

      it('cartão removido (credit_card, cardId null, com parcelas) → forma à vista → 422', async () => {
        txRepo.findOne.mockResolvedValue({
          ...cardTx(),
          cardId: null,
        } as unknown as Transaction);
        await expect(
          service.update('tx-uuid-1', USER_ID, { paymentMethod: PaymentMethod.PIX }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PAYMENT_METHOD_CHANGE_NOT_ALLOWED),
        );
        expect(txRepo.save).not.toHaveBeenCalled();
      });

      it('legado null com cartão → forma à vista → 422', async () => {
        txRepo.findOne.mockResolvedValue(upfrontTx(null, { cardId: 'card-uuid-1' }));
        await expect(
          service.update('tx-uuid-1', USER_ID, { paymentMethod: PaymentMethod.PIX }),
        ).rejects.toThrow(
          new UnprocessableEntityException(ErrorMessages.PAYMENT_METHOD_CHANGE_NOT_ALLOWED),
        );
      });

      it('sem paymentMethod no body não altera a forma (legado continua null)', async () => {
        txRepo.findOne.mockResolvedValue(upfrontTx(null));
        const result = await service.update('tx-uuid-1', USER_ID, { description: 'X' });
        expect(result.paymentMethod).toBeNull();
      });
    });
  });
});
