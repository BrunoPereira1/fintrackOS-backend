import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EntityManager } from 'typeorm';
import { InstallmentsService } from './installments.service';
import { Installment, InstallmentStatus } from './entities/installment.entity';
import { ErrorMessages } from '../common/constants/error-messages';
import { Clock } from '../common/clock';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { buildCardLedger } from '../invoices/invoice-ledger.calculator';

const USER_ID = 'user-uuid-1';
const CARD_ID = 'card-uuid-1';
const OTHER_USER_ID = 'user-uuid-2';
const TODAY = '2026-03-15';
const TS = '2026-01-01T10:00:00.000000Z';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  number: 1,
  totalInstallments: 2,
  amount: '100.00',
  dueDate: '2026-02-17',
  closingDate: '2026-02-10',
  transactionId: 't1',
  cardId: CARD_ID,
  status: InstallmentStatus.PENDING,
  ...over,
});

/** Razão do cartão: parcelas i1 (fev) e i2 (mar) de 100; pagamento de 150 → i1 paga, i2 parcial. */
const ledger = buildCardLedger({
  card: { closingDay: 10, dueDay: 17, creditLimit: 1000 },
  installments: [
    {
      id: 'i1',
      transactionId: 't1',
      transactionCreatedAt: TS,
      number: 1,
      amount: '100.00',
      dueDate: '2026-02-17',
      closingDate: '2026-02-10',
    },
    {
      id: 'i2',
      transactionId: 't1',
      transactionCreatedAt: TS,
      number: 2,
      amount: '100.00',
      dueDate: '2026-03-17',
      closingDate: '2026-03-10',
    },
  ],
  charges: [],
  payments: [{ id: 'p', invoiceMonth: '2026-02', amount: '150.00', paidOn: '2026-02-17' }],
  today: TODAY,
});

describe('InstallmentsService', () => {
  let service: InstallmentsService;
  let em: { query: jest.Mock };
  let repo: { query: jest.Mock; manager: { transaction: jest.Mock; query: jest.Mock } };
  let ledgers: { loadLedger: jest.Mock; loadLedgers: jest.Mock };

  let clock: { today: jest.Mock };
  beforeEach(async () => {
    clock = { today: jest.fn(() => TODAY) };
    em = { query: jest.fn() };
    repo = {
      query: jest.fn().mockResolvedValue([[], 1]),
      manager: {
        transaction: jest.fn((_iso: string, work: (m: unknown) => unknown) => work(em)),
        query: jest.fn().mockResolvedValue([]),
      },
    };
    ledgers = {
      loadLedger: jest.fn().mockResolvedValue(ledger),
      loadLedgers: jest.fn().mockResolvedValue(new Map([[CARD_ID, ledger]])),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        InstallmentsService,
        { provide: getRepositoryToken(Installment), useValue: repo },
        { provide: InvoiceLedgerQuery, useValue: ledgers },
        { provide: Clock, useValue: clock },
      ],
    }).compile();
    service = moduleRef.get(InstallmentsService);
  });

  describe('findAll (status derivado, filtro e paginação no SQL)', () => {
    const query = { page: 2, limit: 10 };

    it('passa limiar do razão, meses vencidos e hoje ao SQL, no mesmo snapshot', async () => {
      em.query.mockResolvedValueOnce([{ total: 11 }]).mockResolvedValueOnce([row()]);

      const res = await service.findAll(USER_ID, { ...query, status: 'paid' });

      expect(repo.manager.transaction).toHaveBeenCalledWith(
        'REPEATABLE READ',
        expect.any(Function),
      );
      expect(ledgers.loadLedgers).toHaveBeenCalledWith(USER_ID, {
        cardIds: undefined,
        em,
        today: TODAY,
      });
      expect(clock.today).toHaveBeenCalledTimes(1); // um único "hoje" por requisição
      const [countSql, countParams] = em.query.mock.calls[0] as [string, unknown[]];
      expect(countSql).toMatch(/WHERE t\.user_id = \$1/);
      expect(countSql).toMatch(/d\."derivedStatus" = \$9/);
      expect(countParams).toEqual([
        USER_ID,
        [CARD_ID], // limiar: i1 (fev) é a última totalmente coberta
        ['2026-02-01'],
        ['t1'],
        [1],
        [CARD_ID], // fevereiro vencido (17/02 < 15/03)
        ['2026-02-01'],
        TODAY,
        'paid',
      ]);
      const [pageSql, pageParams] = em.query.mock.calls[1] as [string, unknown[]];
      expect(pageSql).toMatch(/ORDER BY d\."dueDate", d\.id\s+LIMIT \$10 OFFSET \$11/);
      expect(pageParams.slice(-2)).toEqual([10, 10]);
      expect(res).toEqual({
        data: [
          {
            id: 'i1',
            number: 1,
            totalInstallments: 2,
            amount: 100,
            dueDate: '2026-02-17',
            closingDate: '2026-02-10',
            transactionId: 't1',
            cardId: CARD_ID,
            status: 'paid',
            coveredAmount: 100,
            remainingAmount: 0,
          },
        ],
        total: 11,
        page: 2,
        limit: 10,
      });
    });

    it('filtros de data e cartão viram parâmetros; cartão restringe o razão', async () => {
      em.query.mockResolvedValueOnce([{ total: 0 }]).mockResolvedValueOnce([]);
      await service.findAll(USER_ID, {
        page: 1,
        limit: 20,
        dateFrom: '2026-01-01',
        dateTo: '2026-12-31',
        cardId: CARD_ID,
      });
      expect(ledgers.loadLedgers).toHaveBeenCalledWith(USER_ID, {
        cardIds: [CARD_ID],
        em,
        today: TODAY,
      });
      const [sql, params] = em.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(
        /i\.due_date >= \$9::date AND i\.due_date <= \$10::date AND t\.card_id = \$11::uuid/,
      );
      expect(sql).not.toMatch(/derivedStatus" =/);
      expect(params.slice(8)).toEqual(['2026-01-01', '2026-12-31', CARD_ID]);
    });

    it('parcela parcial e órfã na página trazem coveredAmount/remainingAmount', async () => {
      em.query
        .mockResolvedValueOnce([{ total: 2 }])
        .mockResolvedValueOnce([
          row({ id: 'i2', number: 2, dueDate: '2026-03-17', closingDate: '2026-03-10' }),
          row({ id: 'o', cardId: null, status: InstallmentStatus.PAID }),
        ]);
      const res = await service.findAll(USER_ID, { page: 1, limit: 20 });
      expect(res.data.map((d) => [d.id, d.status, d.coveredAmount, d.remainingAmount])).toEqual([
        ['i2', 'pending', 50, 50],
        ['o', 'paid', 100, 0],
      ]);
    });
  });

  describe('findOne', () => {
    it('busca pela posse via transação e devolve o status do razão, no mesmo snapshot', async () => {
      em.query.mockResolvedValue([row({ status: InstallmentStatus.PENDING })]);
      const res = await service.findOne('i1', USER_ID);
      expect(repo.manager.transaction).toHaveBeenCalledWith(
        'REPEATABLE READ',
        expect.any(Function),
      );
      expect(em.query.mock.calls[0][1]).toEqual(['i1', USER_ID]);
      expect(em.query.mock.calls[0][0]).toMatch(/i\.id = \$1 AND t\.user_id = \$2/);
      expect(ledgers.loadLedger).toHaveBeenCalledWith(USER_ID, CARD_ID, em, TODAY);
      expect(res).toMatchObject({ status: 'paid', coveredAmount: 100, remainingAmount: 0 });
    });

    it('órfã: status gravado sem carregar razão', async () => {
      em.query.mockResolvedValue([row({ cardId: null, dueDate: '2026-03-01' })]);
      const res = await service.findOne('i1', USER_ID);
      expect(ledgers.loadLedger).not.toHaveBeenCalled();
      expect(res).toMatchObject({ status: 'overdue', coveredAmount: 0, remainingAmount: 100 });
    });

    it('inexistente ou de outro usuário → 404', async () => {
      em.query.mockResolvedValue([]);
      await expect(service.findOne('i1', OTHER_USER_ID)).rejects.toThrow(
        new NotFoundException(ErrorMessages.NOT_FOUND.INSTALLMENT),
      );
    });
  });

  describe('update (só órfã legada — D18)', () => {
    it('órfã: grava com escrita condicional (dono e sem cartão) e responde o status', async () => {
      repo.manager.query.mockResolvedValue([row({ cardId: null, dueDate: '2026-04-01' })]);
      const res = await service.update('i1', USER_ID, { status: InstallmentStatus.PAID });
      const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
      expect(sql).toMatch(/i\.id = \$1 AND t\.user_id = \$2 AND t\.card_id IS NULL/);
      expect(params).toEqual(['i1', USER_ID, InstallmentStatus.PAID]);
      expect(res).toMatchObject({ id: 'i1', cardId: null, status: 'paid', coveredAmount: 100 });
    });

    it('escrita sem linha afetada (cartão vinculado no meio) → 404', async () => {
      repo.manager.query.mockResolvedValue([row({ cardId: null })]);
      repo.query.mockResolvedValue([[], 0]);
      await expect(
        service.update('i1', USER_ID, { status: InstallmentStatus.PAID }),
      ).rejects.toThrow(NotFoundException);
    });

    it('parcela de cartão → 422 sem gravar', async () => {
      repo.manager.query.mockResolvedValue([row()]);
      await expect(
        service.update('i1', USER_ID, { status: InstallmentStatus.PAID }),
      ).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.CARD_INSTALLMENT_PAID_VIA_INVOICE),
      );
      expect(repo.query).not.toHaveBeenCalled();
    });

    it('de outro usuário → 404 sem gravar', async () => {
      repo.manager.query.mockResolvedValue([]);
      await expect(
        service.update('i1', OTHER_USER_ID, { status: InstallmentStatus.PAID }),
      ).rejects.toThrow(NotFoundException);
      expect(repo.query).not.toHaveBeenCalled();
    });
  });

  describe('rescheduleOpenInvoices (D14)', () => {
    it('busca só faturas não fechadas do cartão do usuário e regrava as datas do mesmo mês', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([
          { month: '2026-04', ids: ['i1', 'i2'] },
          { month: '2027-01', ids: ['i3'] },
        ])
        .mockResolvedValue([]);
      const em = { query } as unknown as EntityManager;

      // fecha 25, vence 5: a fatura que vence em M fecha em M−1
      const updated = await service.rescheduleOpenInvoices(
        em,
        CARD_ID,
        USER_ID,
        { closingDay: 25, dueDay: 5 },
        TODAY,
      );

      expect(updated).toBe(3);
      const [selectSql, selectParams] = query.mock.calls[0] as [string, unknown[]];
      expect(selectSql).toMatch(/t\.card_id = \$1 AND t\.user_id = \$2/);
      // "Fechada" pela data da fatura (maior closing_date do mês, D25)
      expect(selectSql).toMatch(/HAVING max\(i\.closing_date\) > \$3::date/);
      // D31: mês com datas gravadas por fatura (fechada) nunca é reagendado
      expect(selectSql).toMatch(
        /NOT EXISTS \(\s*SELECT 1 FROM card_invoice_dates d\s+WHERE d\.card_id = \$1 AND d\.user_id = \$2\s+AND d\.invoice_month = to_char\(i\.due_date, 'YYYY-MM'\)/,
      );
      expect(selectParams).toEqual([CARD_ID, USER_ID, TODAY]);
      expect(query.mock.calls[1][1]).toEqual(['2026-03-25', '2026-04-05', ['i1', 'i2']]);
      expect(query.mock.calls[2][1]).toEqual(['2026-12-25', '2027-01-05', ['i3']]);
    });

    it('sem faturas abertas não grava nada', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const updated = await service.rescheduleOpenInvoices(
        { query } as unknown as EntityManager,
        CARD_ID,
        USER_ID,
        { closingDay: 10, dueDay: 17 },
        TODAY,
      );
      expect(updated).toBe(0);
      expect(query).toHaveBeenCalledTimes(1);
    });
  });
});
