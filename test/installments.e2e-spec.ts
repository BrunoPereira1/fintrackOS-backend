import { randomUUID } from 'crypto';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { Clock } from '../src/common/clock';
import { ClockModule } from '../src/common/clock.module';
import { ErrorMessages } from '../src/common/constants/error-messages';
import { CardsModule } from '../src/cards/cards.module';
import { CardInvoicesService } from '../src/cards/card-invoices.service';
import { CardBrand, CreditCard } from '../src/cards/entities/credit-card.entity';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionType } from '../src/transactions/entities/transaction.entity';
import { InstallmentsModule } from '../src/installments/installments.module';
import { InstallmentsService } from '../src/installments/installments.service';
import { Installment, InstallmentStatus } from '../src/installments/entities/installment.entity';
import { InvoiceLedgerQuery } from '../src/invoices/invoice-ledger.query';
import { installmentStates } from '../src/invoices/invoice-ledger.calculator';
import { User } from '../src/users/entities/user.entity';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * `GET /installments` (status derivado no SQL + paginação), `GET /installments/:id` e
 * `PATCH /installments/:id` (só órfã legada) contra o Postgres real — fase 4b do modelo de
 * pagamento. Hoje fixo em 2026-03-15; cartões fecham 10 e vencem 17.
 */
describe('Parcelas: status derivado, listagem e PATCH (e2e, banco real)', () => {
  const TODAY = '2026-03-15';
  let moduleRef: TestingModule;
  let db: DataSource;
  let installments: InstallmentsService;
  let transactions: TransactionsService;
  let cardInvoices: CardInvoicesService;
  let user: User;
  let other: User;
  let cardA: CreditCard;
  let cardC: CreditCard;
  const ids: Record<string, string> = {};

  const newUser = () =>
    db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan: Plan.PREMIUM,
    });
  const newCard = (owner: User) =>
    db.getRepository(CreditCard).save({
      name: 'Cartão e2e',
      brand: CardBrand.VISA,
      closingDay: 10,
      dueDay: 17,
      creditLimit: 1000,
      userId: owner.id,
    });
  const buy = (card: CreditCard, totalAmount: number, date: string, installmentsCount?: number) =>
    transactions.create(user.id, Plan.PREMIUM, {
      description: 'Compra e2e',
      totalAmount,
      date,
      type: TransactionType.VARIABLE,
      cardId: card.id,
      installmentsCount,
    });
  const installmentIds = async (transactionId: string) =>
    (
      await db
        .getRepository(Installment)
        .find({ where: { transactionId }, order: { number: 'ASC' } })
    ).map((i) => i.id);
  const list = (q: Record<string, unknown> = {}) =>
    installments.findAll(user.id, { page: 1, limit: 20, ...q });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClockModule,
        DatabaseModule,
        CardsModule,
        TransactionsModule,
        InstallmentsModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue({ today: () => TODAY })
      .compile();
    db = moduleRef.get(DataSource);
    installments = moduleRef.get(InstallmentsService);
    transactions = moduleRef.get(TransactionsService);
    cardInvoices = moduleRef.get(CardInvoicesService);

    user = await newUser();
    other = await newUser();
    cardA = await newCard(user);
    cardC = await newCard(user);
    const cardD = await newCard(user); // removido depois (órfãs legadas)

    // Cartão A: 3x de 100 (17/01, 17/02, 17/03) + 50 em 17/03
    [ids.A1, ids.A2, ids.A3] = await installmentIds((await buy(cardA, 300, '2026-01-05', 3)).id);
    [ids.B] = await installmentIds((await buy(cardA, 50, '2026-02-20')).id);
    // Cartão C: duas compras na fatura de abril (aberta atual), lançadas nesta ordem
    [ids.C1] = await installmentIds((await buy(cardC, 40, '2026-03-12')).id);
    [ids.C2] = await installmentIds((await buy(cardC, 60, '2026-03-12')).id);
    // Órfãs: compras do cartão D, que é removido fisicamente (legado)
    [ids.O1] = await installmentIds((await buy(cardD, 20, '2026-01-05')).id); // 17/01
    [ids.O2] = await installmentIds((await buy(cardD, 25, '2026-03-12')).id); // 17/04
    await db.getRepository(CreditCard).delete(cardD.id);

    // A: P = 130 → A1 coberta, A2 coberta 30 de 100. C: P = 40 → C1 exatamente coberta.
    await cardInvoices.addPayment(cardA.id, user.id, '2026-01', { amount: 100 });
    await cardInvoices.addPayment(cardA.id, user.id, '2026-02', { amount: 30 });
    await cardInvoices.addPayment(cardC.id, user.id, '2026-04', { amount: 40 });
    // Status gravado de parcela de cartão não vale mais (D18): ruído proposital
    await db.getRepository(Installment).update(ids.A3, { status: InstallmentStatus.PAID });
  });

  afterAll(async () => {
    for (const u of [user, other]) if (u) await db.getRepository(User).delete(u.id);
    await moduleRef?.close();
  });

  describe('PATCH (só órfã legada — D18)', () => {
    it('órfã: marca paga e responde com o status gravado', async () => {
      const res = await installments.update(ids.O2, user.id, { status: InstallmentStatus.PAID });
      expect(res).toMatchObject({
        id: ids.O2,
        cardId: null,
        status: 'paid',
        coveredAmount: 25,
        remainingAmount: 0,
      });
      const saved = await db.getRepository(Installment).findOneByOrFail({ id: ids.O2 });
      expect(saved.status).toBe(InstallmentStatus.PAID);
    });

    it('parcela de cartão → 422 orientando a pagar a fatura, sem gravar', async () => {
      await expect(
        installments.update(ids.B, user.id, { status: InstallmentStatus.PAID }),
      ).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.CARD_INSTALLMENT_PAID_VIA_INVOICE),
      );
      const saved = await db.getRepository(Installment).findOneByOrFail({ id: ids.B });
      expect(saved.status).toBe(InstallmentStatus.PENDING);
    });

    it('parcela de outro usuário → 404 (órfã ou de cartão)', async () => {
      for (const id of [ids.O1, ids.A1]) {
        await expect(
          installments.update(id, other.id, { status: InstallmentStatus.PAID }),
        ).rejects.toThrow(new NotFoundException(ErrorMessages.NOT_FOUND.INSTALLMENT));
      }
    });
  });

  describe('GET /installments/:id', () => {
    it('cartão: status e valores do razão (parcial), ignorando o gravado', async () => {
      await expect(installments.findOne(ids.A2, user.id)).resolves.toMatchObject({
        status: 'overdue',
        coveredAmount: 30,
        remainingAmount: 70,
        amount: 100,
        dueDate: '2026-02-17',
        closingDate: '2026-02-10',
        cardId: cardA.id,
      });
      await expect(installments.findOne(ids.A3, user.id)).resolves.toMatchObject({
        status: 'pending', // gravada paid, mas não coberta
        coveredAmount: 0,
      });
    });

    it('órfã: status gravado, pending vencida → overdue', async () => {
      await expect(installments.findOne(ids.O1, user.id)).resolves.toMatchObject({
        status: 'overdue',
        cardId: null,
      });
    });

    it('de outro usuário → 404', async () => {
      await expect(installments.findOne(ids.A1, other.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET /installments?status= (filtro no SQL)', () => {
    it.each([
      ['paid', ['A1', 'C1', 'O2']],
      ['overdue', ['O1', 'A2']],
      ['pending', ['A3', 'B', 'C2']],
    ] as const)('status=%s', async (status, expected) => {
      const res = await list({ status });
      expect(res.total).toBe(expected.length);
      expect(res.data.every((d) => d.status === status)).toBe(true);
      expect(new Set(res.data.map((d) => d.id))).toEqual(new Set(expected.map((k) => ids[k])));
    });

    it('sem filtro: todas, ordenadas por vencimento; status do SQL bate com o razão', async () => {
      const res = await list();
      expect(res.total).toBe(8);
      const dueDates = res.data.map((d) => d.dueDate);
      expect(dueDates).toEqual([...dueDates].sort());

      const ledgers = moduleRef.get(InvoiceLedgerQuery);
      for (const card of [cardA, cardC]) {
        const states = installmentStates((await ledgers.loadLedger(user.id, card.id))!);
        for (const d of res.data.filter((x) => x.cardId === card.id)) {
          expect(d).toMatchObject(states.get(d.id)!);
        }
      }
      // cada filtro devolve exatamente os itens com aquele status na listagem completa
      for (const status of ['paid', 'pending', 'overdue'] as const) {
        const filtered = await list({ status });
        expect(filtered.data.map((d) => d.id).sort()).toEqual(
          res.data
            .filter((d) => d.status === status)
            .map((d) => d.id)
            .sort(),
        );
      }
    });

    it('paginação com filtro: total estável e páginas sem sobreposição', async () => {
      const p1 = await list({ status: 'pending', limit: 2, page: 1 });
      const p2 = await list({ status: 'pending', limit: 2, page: 2 });
      const p3 = await list({ status: 'pending', limit: 2, page: 3 });
      expect([p1.total, p2.total, p3.total]).toEqual([3, 3, 3]);
      expect(p1.data).toHaveLength(2);
      expect(p2.data).toHaveLength(1);
      expect(p3.data).toEqual([]);
      expect(new Set([...p1.data, ...p2.data].map((d) => d.id))).toEqual(
        new Set([ids.A3, ids.B, ids.C2]),
      );
    });

    it('filtros de cartão e datas combinados com status', async () => {
      const res = await list({ status: 'pending', cardId: cardA.id });
      expect(res.data.map((d) => d.id).sort()).toEqual([ids.A3, ids.B].sort());

      const range = await list({ dateFrom: '2026-02-01', dateTo: '2026-03-17' });
      expect(range.total).toBe(3); // A2, A3, B
    });

    it('pagamento novo muda o filtro sem gravar status (cobertura FIFO)', async () => {
      await cardInvoices.addPayment(cardA.id, user.id, '2026-03', { amount: 70 }); // quita A2
      const paid = await list({ status: 'paid', cardId: cardA.id });
      expect(paid.data.map((d) => d.id).sort()).toEqual([ids.A1, ids.A2].sort());
      const overdue = await list({ status: 'overdue' });
      expect(overdue.data.map((d) => d.id)).toEqual([ids.O1]);
    });

    it('outro usuário não vê nada', async () => {
      const res = await installments.findAll(other.id, { page: 1, limit: 20 });
      expect(res).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });
  });

  describe('bordas: vence hoje, encargo intercalado, datas divergentes no mês (D25)', () => {
    let edge: User;
    const e: Record<string, string> = {};

    beforeAll(async () => {
      edge = await newUser();
      // fecha 10, vence 15: fatura de março vence hoje (15/03)
      const card = await db.getRepository(CreditCard).save({
        name: 'Borda',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 15,
        creditLimit: 1000,
        userId: edge.id,
      });
      const buyEdge = async (amount: number, date: string) => {
        const tx = await transactions.create(edge.id, Plan.PREMIUM, {
          description: 'Compra e2e',
          totalAmount: amount,
          date,
          type: TransactionType.VARIABLE,
          cardId: card.id,
        });
        return (await installmentIds(tx.id))[0];
      };
      e.feb = await buyEdge(100, '2026-02-01'); // vence 15/02
      e.feb2 = await buyEdge(40, '2026-02-02'); // vence 15/02
      e.mar = await buyEdge(100, '2026-02-20'); // vence 15/03 (hoje)
      e.mar2 = await buyEdge(50, '2026-02-21'); // vence 15/03, mas gravada com 14/03 (divergente)
      await db
        .getRepository(Installment)
        .update(e.mar2, { dueDate: '2026-03-14' as unknown as Date });
      // encargo de 10 em fevereiro; pagamento de 145 cobre 100 + 40 + 5 do encargo
      await cardInvoices.addCharge(card.id, edge.id, '2026-02', { amount: 10 });
      await cardInvoices.addPayment(card.id, edge.id, '2026-02', { amount: 145 });
    });

    afterAll(async () => {
      if (edge) await db.getRepository(User).delete(edge.id);
    });

    const listEdge = (status: 'paid' | 'pending' | 'overdue') =>
      installments.findAll(edge.id, { page: 1, limit: 20, status });

    it('encargo parcialmente coberto não faz parcela do mês seguinte contar como paga', async () => {
      expect((await listEdge('paid')).data.map((d) => d.id).sort()).toEqual([e.feb, e.feb2].sort());
    });

    it('fatura que vence hoje é pending; vencimento da fatura (maior do mês) prevalece sobre o da parcela', async () => {
      const pending = await listEdge('pending');
      expect(pending.data.map((d) => d.id).sort()).toEqual([e.mar, e.mar2].sort());
      expect((await listEdge('overdue')).total).toBe(0);
      await expect(installments.findOne(e.mar2, edge.id)).resolves.toMatchObject({
        status: 'pending',
        dueDate: '2026-03-14',
      });
    });

    it('cardId de outro usuário ou inexistente: lista vazia (D28)', async () => {
      const empty = { data: [], total: 0, page: 1, limit: 20 };
      expect(await installments.findAll(edge.id, { page: 1, limit: 20, cardId: cardA.id })).toEqual(
        empty,
      );
      expect(
        await installments.findAll(edge.id, { page: 1, limit: 20, cardId: randomUUID() }),
      ).toEqual(empty);
    });
  });

  it('parcela de valor zero atrás de parcela não coberta: SQL e calculadora dizem paid', async () => {
    const zeroUser = await newUser();
    try {
      const card = await newCard(zeroUser);
      // R$ 0,01 em 2x → 0,00 (17/04) + 0,01 (17/05); antes, 100 em 17/04 sem pagamento
      for (const [total, count] of [
        [100, 1],
        [0.01, 2],
      ]) {
        await transactions.create(zeroUser.id, Plan.PREMIUM, {
          description: 'Compra e2e',
          totalAmount: total,
          date: '2026-03-12',
          type: TransactionType.VARIABLE,
          cardId: card.id,
          installmentsCount: count,
        });
      }
      const all = await installments.findAll(zeroUser.id, { page: 1, limit: 20 });
      const zero = all.data.find((d) => d.amount === 0)!;
      expect(zero.status).toBe('paid');
      const paid = await installments.findAll(zeroUser.id, { page: 1, limit: 20, status: 'paid' });
      expect(paid.data.map((d) => d.id)).toEqual([zero.id]);
      const pending = await installments.findAll(zeroUser.id, {
        page: 1,
        limit: 20,
        status: 'pending',
      });
      expect(pending.total).toBe(2);
      expect(pending.data.every((d) => d.status === 'pending')).toBe(true);
    } finally {
      await db.getRepository(User).delete(zeroUser.id);
    }
  });
});
