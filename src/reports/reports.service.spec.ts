import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ReportsService } from './reports.service';
import { CardsService } from '../cards/cards.service';
import { Clock } from '../common/clock';
import { ErrorMessages } from '../common/constants/error-messages';
import { Plan } from '../users/enums/plan.enum';
import { CreditCard } from '../cards/entities/credit-card.entity';
import { InstallmentStatus } from '../installments/entities/installment.entity';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { buildCardLedger, CardLedger } from '../invoices/invoice-ledger.calculator';

const USER_ID = 'user-uuid-1';
const CARD_ID = 'card-uuid-1';
const CONTACT_ID = 'contact-uuid-1';

const card = { id: CARD_ID, name: 'Nubank', closingDay: 10, dueDay: 17 } as CreditCard;
const TS = '2026-02-01T12:00:00.000000Z';

const ledgerOf = (
  today: string,
  over: Partial<Parameters<typeof buildCardLedger>[0]> = {},
): CardLedger =>
  buildCardLedger({
    card: { closingDay: 10, dueDay: 17, creditLimit: 1000 },
    installments: [],
    charges: [],
    payments: [],
    today,
    ...over,
  });

/** Query builder encadeável: cada chamada devolve o próprio qb; `getRawMany` é configurável. */
function mockQueryBuilder(rows: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'select',
    'addSelect',
    'from',
    'innerJoin',
    'leftJoin',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'setParameters',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

describe('ReportsService', () => {
  let service: ReportsService;
  let em: { createQueryBuilder: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  let cardsService: { findOne: jest.Mock };
  let ledgers: { loadLedger: jest.Mock; loadLedgers: jest.Mock };
  let clock: { today: jest.Mock };

  beforeEach(async () => {
    em = { createQueryBuilder: jest.fn(() => mockQueryBuilder()) };
    dataSource = {
      transaction: jest.fn((_iso: string, work: (m: unknown) => unknown) => work(em)),
    };
    cardsService = { findOne: jest.fn().mockResolvedValue(card) };
    clock = { today: jest.fn().mockReturnValue('2026-03-05') };
    ledgers = {
      loadLedger: jest.fn(async () => ledgerOf(clock.today() as string)),
      loadLedgers: jest.fn().mockResolvedValue(new Map()),
    };

    const module = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: DataSource, useValue: dataSource },
        { provide: CardsService, useValue: cardsService },
        { provide: InvoiceLedgerQuery, useValue: ledgers },
        { provide: Clock, useValue: clock },
      ],
    }).compile();
    service = module.get(ReportsService);
  });

  describe('getInvoice', () => {
    it('valida a posse do cartão e lê o razão do cartão no mesmo snapshot', async () => {
      await service.getInvoice(USER_ID, CARD_ID, '2026-03');
      expect(cardsService.findOne).toHaveBeenCalledWith(CARD_ID, USER_ID);
      expect(dataSource.transaction).toHaveBeenCalledWith('REPEATABLE READ', expect.any(Function));
      expect(ledgers.loadLedger).toHaveBeenCalledWith(USER_ID, CARD_ID, em);
    });

    it.each([
      ['404', new NotFoundException(ErrorMessages.NOT_FOUND.CARD)],
      ['403', new ForbiddenException(ErrorMessages.ACCESS_DENIED)],
    ])('propaga %s do cardsService.findOne sem consultar o banco', async (_code, error) => {
      cardsService.findOne.mockRejectedValue(error);
      await expect(service.getInvoice(USER_ID, CARD_ID, '2026-03')).rejects.toThrow(error);
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(ledgers.loadLedger).not.toHaveBeenCalled();
    });

    it('status pelas datas do razão e hoje do clock (fecha 10, vence 17)', async () => {
      clock.today.mockReturnValue('2026-03-05');
      await expect(service.getInvoice(USER_ID, CARD_ID, '2026-03')).resolves.toMatchObject({
        status: 'open',
      });
      clock.today.mockReturnValue('2026-03-12');
      await expect(service.getInvoice(USER_ID, CARD_ID, '2026-03')).resolves.toMatchObject({
        status: 'closed',
      });
    });

    it('fatura sem itens não consulta detalhes nem encargos', async () => {
      const res = await service.getInvoice(USER_ID, CARD_ID, '2026-03');
      expect(res.items).toEqual([]);
      expect(em.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('busca detalhes das parcelas e descrições dos encargos filtrando por usuário', async () => {
      ledgers.loadLedger.mockResolvedValue(
        ledgerOf('2026-03-20', {
          installments: [
            {
              id: 'i1',
              transactionId: 't1',
              transactionCreatedAt: TS,
              number: 1,
              amount: '50.00',
              dueDate: '2026-03-17',
              closingDate: '2026-03-10',
            },
          ],
          charges: [{ id: 'ch1', invoiceMonth: '2026-03', amount: '2.00', createdAt: TS }],
        }),
      );
      const detailsQb = mockQueryBuilder([
        {
          installmentId: 'i1',
          description: 'Mercado',
          category: null,
          purchaseDate: '2026-02-01',
          totalInstallments: 1,
        },
      ]);
      const chargesQb = mockQueryBuilder([{ id: 'ch1', description: 'IOF' }]);
      em.createQueryBuilder.mockReturnValueOnce(detailsQb).mockReturnValueOnce(chargesQb);

      const res = await service.getInvoice(USER_ID, CARD_ID, '2026-03');

      expect(detailsQb.where).toHaveBeenCalledWith('t.user_id = :userId', { userId: USER_ID });
      expect(detailsQb.andWhere).toHaveBeenCalledWith('i.id IN (:...installmentIds)', {
        installmentIds: ['i1'],
      });
      expect(chargesQb.where).toHaveBeenCalledWith('ch.user_id = :userId', { userId: USER_ID });
      expect(res.items[0]).toMatchObject({ description: 'Mercado', status: 'overdue' });
      expect(res.charges[0]).toMatchObject({ description: 'IOF', remainingAmount: 2 });
      expect(res.amountDue).toBe(52);
    });
  });

  describe('getMonthlySummary', () => {
    it('parcela de cartão usa o razão; órfã usa o status gravado', async () => {
      const installments = [
        {
          id: 'i1',
          amount: '100.00',
          status: InstallmentStatus.PAID, // gravado é ignorado para cartão
          dueDate: '2026-03-17',
          category: null,
          cardId: CARD_ID,
          cardName: 'Nubank',
        },
        {
          id: 'orphan',
          amount: '10.00',
          status: InstallmentStatus.PAID,
          dueDate: '2026-03-01',
          category: null,
          cardId: null,
          cardName: null,
        },
      ];
      em.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder(installments))
        .mockReturnValueOnce(mockQueryBuilder([]));
      clock.today.mockReturnValue('2026-03-20');
      ledgers.loadLedgers.mockResolvedValue(
        new Map([
          [
            CARD_ID,
            ledgerOf('2026-03-20', {
              installments: [
                {
                  id: 'i1',
                  transactionId: 't1',
                  transactionCreatedAt: TS,
                  number: 1,
                  amount: '100.00',
                  dueDate: '2026-03-17',
                  closingDate: '2026-03-10',
                },
              ],
              payments: [
                { id: 'p', invoiceMonth: '2026-03', amount: '30.00', paidOn: '2026-03-02' },
              ],
            }),
          ],
        ]),
      );

      const res = await service.getMonthlySummary(USER_ID, Plan.BASIC, '2026-03');
      expect(ledgers.loadLedgers).toHaveBeenCalledWith(USER_ID, { em, today: '2026-03-20' });
      expect(clock.today).toHaveBeenCalledTimes(1); // um único "hoje" por requisição
      expect(res.installments).toEqual({ paid: 40, pending: 70, overdue: 70 });
      expect(res.paidInMonth).toBe(30);
    });

    it('encargos do mês viram cardCharges com o nome do cartão (consulta filtrada por usuário)', async () => {
      ledgers.loadLedgers.mockResolvedValue(
        new Map([
          [
            CARD_ID,
            ledgerOf('2026-03-20', {
              charges: [
                { id: 'c1', invoiceMonth: '2026-03', amount: '7.50', createdAt: TS },
                { id: 'c2', invoiceMonth: '2026-02', amount: '1.00', createdAt: TS },
              ],
            }),
          ],
        ]),
      );
      const namesQb = mockQueryBuilder([{ id: CARD_ID, name: 'Nubank' }]);
      em.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(namesQb);

      const res = await service.getMonthlySummary(USER_ID, Plan.BASIC, '2026-03');

      expect(namesQb.where).toHaveBeenCalledWith('c.user_id = :userId', { userId: USER_ID });
      expect(res.totals).toMatchObject({ spent: 7.5, cardCharges: 7.5 });
      expect(res.byCard).toEqual([{ cardId: CARD_ID, cardName: 'Nubank', amount: 7.5 }]);
    });

    it('transações à vista trazem a forma de pagamento e alimentam byPaymentMethod', async () => {
      const upfrontQb = mockQueryBuilder([
        { totalAmount: '30.00', category: null, paymentMethod: 'cash' },
        { totalAmount: '10.00', category: null, paymentMethod: null },
      ]);
      em.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(upfrontQb);

      const res = await service.getMonthlySummary(USER_ID, Plan.BASIC, '2026-03');

      expect(upfrontQb.addSelect).toHaveBeenCalledWith('t.payment_method', 'paymentMethod');
      expect(res.totals.upfront).toBe(40);
      expect(res.byPaymentMethod).toEqual([
        { paymentMethod: 'cash', amount: 30 },
        { paymentMethod: null, amount: 10 },
      ]);
    });

    it('join do cartão também filtra pelo dono (defesa em profundidade)', async () => {
      const qb = mockQueryBuilder([]);
      em.createQueryBuilder.mockReturnValueOnce(qb);
      await service.getMonthlySummary(USER_ID, Plan.BASIC, '2026-03');
      expect(qb.leftJoin).toHaveBeenCalledWith(
        'credit_cards',
        'c',
        'c.id = t.card_id AND c.user_id = :userId',
      );
      expect(qb.setParameters).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
    });

    it.each([Plan.BASIC, Plan.INTERMEDIATE])(
      '%s: receivablesPending null sem rodar a query de splits',
      async (plan) => {
        const res = await service.getMonthlySummary(USER_ID, plan, '2026-03');
        expect(res.receivablesPending).toBeNull();
        // só parcelas e transações sem parcelas
        expect(em.createQueryBuilder).toHaveBeenCalledTimes(2);
        const froms = em.createQueryBuilder.mock.results.map(
          (r) => (r.value as { from: jest.Mock }).from.mock.calls[0][0],
        );
        expect(froms).not.toContain('cost_splits');
      },
    );

    it('premium: soma os splits pendentes do mês', async () => {
      em.createQueryBuilder
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([]))
        .mockReturnValueOnce(mockQueryBuilder([{ amount: '10.10' }, { amount: '0.20' }]));

      const res = await service.getMonthlySummary(USER_ID, Plan.PREMIUM, '2026-03');
      expect(res.receivablesPending).toBe(10.3);
      expect(em.createQueryBuilder).toHaveBeenCalledTimes(3);
    });
  });

  describe('getReceivables', () => {
    it('com contactId filtra no SQL, sem 404/403 (filtro de listagem não revela existência)', async () => {
      const res = await service.getReceivables(USER_ID, {
        status: 'pending',
        contactId: CONTACT_ID,
      });
      const splitsQb = em.createQueryBuilder.mock.results[0].value as { andWhere: jest.Mock };
      expect(splitsQb.andWhere).toHaveBeenCalledWith('c.user_id = :userId', { userId: USER_ID });
      expect(splitsQb.andWhere).toHaveBeenCalledWith('s.contact_id = :contactId', {
        contactId: CONTACT_ID,
      });
      // contato alheio/inexistente: nenhuma linha → resultado vazio
      expect(res).toEqual({ totals: { pending: 0, paid: 0 }, contacts: [] });
    });

    it('carrega o razão só dos cartões das parcelas envolvidas', async () => {
      em.createQueryBuilder
        .mockReturnValueOnce(
          mockQueryBuilder([
            {
              splitId: 's1',
              contactId: CONTACT_ID,
              contactName: 'Ana',
              contactEmail: null,
              transactionId: 't1',
              description: 'x',
              transactionDate: '2026-02-01',
              assignedAmount: '10.00',
              status: 'pending',
              paidAt: null,
            },
          ]),
        )
        .mockReturnValueOnce(
          mockQueryBuilder([
            {
              id: 'i1',
              transactionId: 't1',
              cardId: CARD_ID,
              status: InstallmentStatus.PAID,
              amount: '10.00',
              dueDate: '2026-02-17',
            },
          ]),
        );

      const res = await service.getReceivables(USER_ID, { status: 'pending' });

      expect(ledgers.loadLedgers).toHaveBeenCalledWith(USER_ID, {
        cardIds: [CARD_ID],
        em,
        today: '2026-03-05',
      });
      expect(clock.today).toHaveBeenCalledTimes(1);
      // fora do razão (mock vazio) → não coberta, apesar do status gravado paid
      expect(res.contacts[0].splits[0].installments).toMatchObject({ paid: 0, remaining: 1 });
    });
  });
});
