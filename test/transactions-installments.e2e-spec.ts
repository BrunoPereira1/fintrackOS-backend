import { randomUUID } from 'crypto';
import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { Clock } from '../src/common/clock';
import { ClockModule } from '../src/common/clock.module';
import { CardsModule } from '../src/cards/cards.module';
import { CardsService } from '../src/cards/cards.service';
import { CardInvoicesService } from '../src/cards/card-invoices.service';
import { ErrorMessages } from '../src/common/constants/error-messages';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionType } from '../src/transactions/entities/transaction.entity';
import { CardBrand, CreditCard } from '../src/cards/entities/credit-card.entity';
import { Installment } from '../src/installments/entities/installment.entity';
import { Transaction } from '../src/transactions/entities/transaction.entity';
import { User } from '../src/users/entities/user.entity';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * Parcelas contra o Postgres real: datas gravadas na coluna `date` e troca das parcelas
 * (delete + insert numa transação de banco) quando valor/data mudam; D20/D24 e cartão
 * arquivado (D12). "Hoje" controlado por `overrideProvider(Clock)` (padrão 2026-01-01).
 * Requer PostgreSQL com as migrations aplicadas (local: `make up && make migration-run`).
 */
describe('Transações e parcelas (e2e, banco real)', () => {
  let moduleRef: TestingModule;
  let service: TransactionsService;
  let db: DataSource;
  let user: User;
  let card: CreditCard;
  let cards: CardsService;
  let cardInvoices: CardInvoicesService;
  let today = '2026-01-01';

  const dueDates = async (transactionId: string) =>
    (
      await db.getRepository(Installment).find({
        where: { transactionId },
        order: { number: 'ASC' },
      })
    ).map((i) => [String(i.dueDate), Number(i.amount)]);

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClockModule,
        DatabaseModule,
        CardsModule,
        TransactionsModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue({ today: () => today })
      .compile();
    service = moduleRef.get(TransactionsService);
    cards = moduleRef.get(CardsService);
    cardInvoices = moduleRef.get(CardInvoicesService);
    db = moduleRef.get(DataSource);

    user = await db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan: Plan.PREMIUM,
    });
    // Fecha dia 25 e vence dia 5: o caso que gerava vencimento antes da compra
    card = await db.getRepository(CreditCard).save({
      name: 'Cartão e2e',
      brand: CardBrand.VISA,
      closingDay: 25,
      dueDay: 5,
      creditLimit: 5000,
      userId: user.id,
    });
  });

  afterAll(async () => {
    if (user) await db.getRepository(User).delete(user.id); // cascade apaga o resto
    await moduleRef?.close();
  });

  const createCardTx = (totalAmount: number, date: string, installmentsCount?: number) =>
    service.create(user.id, Plan.PREMIUM, {
      description: 'Compra e2e',
      totalAmount,
      date,
      type: TransactionType.VARIABLE,
      cardId: card.id,
      installmentsCount,
    });

  it('grava vencimentos corretos: fecha 25, vence 5, compra no dia do fechamento', async () => {
    const tx = await createCardTx(100, '2026-01-25', 3);

    expect(await dueDates(tx.id)).toEqual([
      ['2026-03-05', 33.33],
      ['2026-04-05', 33.33],
      ['2026-05-05', 33.34],
    ]);
  });

  it('compra à vista no cartão gera 1 parcela', async () => {
    const tx = await createCardTx(89.9, '2026-01-10');
    expect(await dueDates(tx.id)).toEqual([['2026-02-05', 89.9]]);
  });

  it('mudar valor e data troca as parcelas no banco, sem deixar órfãs', async () => {
    const tx = await createCardTx(300, '2026-01-10', 3);

    await service.update(tx.id, user.id, { totalAmount: 600, date: '2026-02-26' });

    expect(await dueDates(tx.id)).toEqual([
      ['2026-04-05', 200],
      ['2026-05-05', 200],
      ['2026-06-05', 200],
    ]);
    const orphans = await db.query(
      'SELECT count(*)::int AS n FROM installments WHERE transaction_id IS NULL',
    );
    expect(orphans[0].n).toBe(0);
  });

  it('?cardId= alheio ou inexistente → lista vazia (filtro não revela existência)', async () => {
    await createCardTx(10, '2026-01-10');
    const other = await db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan: Plan.PREMIUM,
    });
    try {
      const empty = { data: [], total: 0, page: 1, limit: 20 };
      expect(await service.findAll(other.id, { page: 1, limit: 20, cardId: card.id })).toEqual(
        empty,
      );
      expect(await service.findAll(user.id, { page: 1, limit: 20, cardId: randomUUID() })).toEqual(
        empty,
      );
    } finally {
      await db.getRepository(User).delete(other.id);
    }
  });

  describe('D30: cardId do body inexistente ou alheio → 400 genérico', () => {
    let other: User;
    const buyWith = (cardId: string) =>
      service.create(user.id, Plan.PREMIUM, {
        description: 'Compra e2e',
        totalAmount: 10,
        date: '2026-01-10',
        type: TransactionType.VARIABLE,
        cardId,
      });
    const invalidCard = new BadRequestException(ErrorMessages.TRANSACTION_INVALID_CARD);

    beforeAll(async () => {
      other = await db.getRepository(User).save({
        firebaseUid: `e2e-${randomUUID()}`,
        email: `e2e-${randomUUID()}@test.local`,
        plan: Plan.PREMIUM,
      });
    });
    afterAll(async () => {
      if (other) await db.getRepository(User).delete(other.id);
    });

    const foreignCard = (archivedAt: Date | null = null) =>
      db.getRepository(CreditCard).save({
        name: 'Cartão alheio',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 1000,
        userId: other.id,
        archivedAt,
      });

    it('cartão de outro usuário → 400, nada gravado', async () => {
      const foreign = await foreignCard();
      await expect(buyWith(foreign.id)).rejects.toThrow(invalidCard);
      expect(await db.getRepository(Transaction).count({ where: { cardId: foreign.id } })).toBe(0);
    });

    it('cartão inexistente → 400 (mesma resposta do alheio)', async () => {
      await expect(buyWith(randomUUID())).rejects.toThrow(invalidCard);
    });

    it('cartão de outro usuário e arquivado → 400, nunca o 422 CARD_ARCHIVED', async () => {
      const foreign = await foreignCard(new Date('2026-01-02'));
      await expect(buyWith(foreign.id)).rejects.toThrow(invalidCard);
    });
  });

  describe('D29: total em centavos menor que o número de parcelas → 422', () => {
    const tooSmall = new UnprocessableEntityException(ErrorMessages.TOTAL_LESS_THAN_INSTALLMENTS);
    const count = async (where: object) => db.getRepository(Transaction).count({ where });

    it('criação: R$ 0,02 em 3x → 422 sem gravar; R$ 0,03 em 3x grava 3 parcelas de R$ 0,01', async () => {
      const before = await count({ cardId: card.id });
      await expect(createCardTx(0.02, '2026-01-10', 3)).rejects.toThrow(tooSmall);
      expect(await count({ cardId: card.id })).toBe(before);

      const tx = await createCardTx(0.03, '2026-01-10', 3);
      expect((await dueDates(tx.id)).map(([, amount]) => amount)).toEqual([0.01, 0.01, 0.01]);
    });

    it('edição só de valor (D26) e com data: abaixo do limite → 422 e nada muda; no limite aceita', async () => {
      const tx = await createCardTx(3, '2026-01-10', 3);
      const before = await dueDates(tx.id);

      await expect(service.update(tx.id, user.id, { totalAmount: 0.02 })).rejects.toThrow(tooSmall);
      await expect(
        service.update(tx.id, user.id, { totalAmount: 0.02, date: '2026-01-11' }),
      ).rejects.toThrow(tooSmall);
      expect(await dueDates(tx.id)).toEqual(before);

      await service.update(tx.id, user.id, { totalAmount: 0.03 });
      expect((await dueDates(tx.id)).map(([, amount]) => amount)).toEqual([0.01, 0.01, 0.01]);
      await service.update(tx.id, user.id, { totalAmount: 0.06, date: '2026-01-11' });
      expect((await dueDates(tx.id)).map(([, amount]) => amount)).toEqual([0.02, 0.02, 0.02]);
    });

    it('edição só de data de compra antiga já com parcela de R$ 0,00 não é bloqueada', async () => {
      // Legado anterior ao D29: R$ 0,01 em 2x (0,00 + 0,01). A criação hoje recusa, então grava
      // R$ 0,02 em 2x e rebaixa no banco para o estado legado (como installments.e2e-spec)
      const tx = await createCardTx(0.02, '2026-01-10', 2);
      await db.getRepository(Transaction).update(tx.id, { totalAmount: 0.01 });
      await db
        .getRepository(Installment)
        .update({ transactionId: tx.id, number: 1 }, { amount: 0 });

      await service.update(tx.id, user.id, { date: '2026-01-11' });

      // regenera as parcelas como estavam (floor em centavos, resto na última)
      expect(await dueDates(tx.id)).toEqual([
        ['2026-02-05', 0],
        ['2026-03-05', 0.01],
      ]);
    });

    it('órfã legada (cartão removido) com R$ 0,02 em 3x → TOTAL_LESS_THAN_INSTALLMENTS, não CARD_REQUIRED_FOR_RECALC', async () => {
      const gone = await db.getRepository(CreditCard).save({
        name: 'Cartão removido',
        brand: CardBrand.VISA,
        closingDay: 25,
        dueDay: 5,
        creditLimit: 1000,
        userId: user.id,
      });
      const tx = await service.create(user.id, Plan.PREMIUM, {
        description: 'Compra e2e',
        totalAmount: 3,
        date: '2026-01-10',
        type: TransactionType.VARIABLE,
        cardId: gone.id,
        installmentsCount: 3,
      });
      await db.getRepository(CreditCard).delete(gone.id); // legado: vira órfã (card_id NULL)
      const before = await dueDates(tx.id);

      await expect(service.update(tx.id, user.id, { totalAmount: 0.02 })).rejects.toThrow(tooSmall);
      // acima do limite, a órfã continua barrada pela falta de cartão
      await expect(service.update(tx.id, user.id, { totalAmount: 0.03 })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.CARD_REQUIRED_FOR_RECALC),
      );
      expect(await dueDates(tx.id)).toEqual(before);
    });
  });

  describe('compra no cartão sob a trava do cartão (fase 4c)', () => {
    // Fecha 10, vence 17; hoje 15/03: fatura 2026-03 fechada, 2026-04 aberta atual
    let card2: CreditCard;
    const buy = (totalAmount: number, date: string, cardId = card2.id) =>
      service.create(user.id, Plan.PREMIUM, {
        description: 'Compra e2e',
        totalAmount,
        date,
        type: TransactionType.VARIABLE,
        cardId,
      });

    beforeAll(async () => {
      card2 = await db.getRepository(CreditCard).save({
        name: 'Cartão 4c',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 5000,
        userId: user.id,
      });
    });
    beforeEach(() => (today = '2026-03-15'));
    afterAll(() => (today = '2026-01-01'));

    it('D20: coberta em fatura fechada → 422 e nada muda no banco', async () => {
      const tx = await buy(100, '2026-02-20'); // fatura 2026-03 (fechou 10/03)
      await cardInvoices.addPayment(card2.id, user.id, '2026-03', { amount: 100 });
      const before = await dueDates(tx.id);

      await expect(service.update(tx.id, user.id, { totalAmount: 150 })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
      );
      expect(await dueDates(tx.id)).toEqual(before);
    });

    it('D20: coberta em fatura ainda aberta → recalcula (o pagamento só se realoca)', async () => {
      const tx = await buy(100, '2026-03-12'); // fatura 2026-04 (fecha 10/04)
      await cardInvoices.addPayment(card2.id, user.id, '2026-04', { amount: 100 });

      await service.update(tx.id, user.id, { totalAmount: 150 });
      expect(await dueDates(tx.id)).toEqual([['2026-04-17', 150]]);
    });

    it('D20 na mudança de data: tirar parcela coberta de fatura fechada → 422', async () => {
      const own = await db.getRepository(CreditCard).save({
        name: 'Cartão D20 data',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 0,
        userId: user.id,
      });
      const tx = await buy(100, '2026-02-20', own.id); // fatura 2026-03 (fechada)
      await cardInvoices.addPayment(own.id, user.id, '2026-03', { amount: 100 });

      await expect(service.update(tx.id, user.id, { date: '2026-03-12' })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
      );
      expect(await dueDates(tx.id)).toEqual([['2026-03-17', 100]]);
    });

    it('D24: nova data levando parcela para fatura fechada → 422', async () => {
      const tx = await buy(100, '2026-03-12');
      await expect(service.update(tx.id, user.id, { date: '2026-02-20' })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.PURCHASE_DATE_IN_CLOSED_INVOICE),
      );
      expect(await dueDates(tx.id)).toEqual([['2026-04-17', 100]]);
    });

    it('D27: nova data que tira parcela não coberta de fatura fechada → permitido', async () => {
      // cartão próprio: os pagamentos de card2 nos testes acima cobririam a parcela
      const own = await db.getRepository(CreditCard).save({
        name: 'Cartão D27',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 0,
        userId: user.id,
      });
      const tx = await buy(100, '2026-02-20', own.id); // fatura 2026-03 (fechada, sem pagamento)
      await service.update(tx.id, user.id, { date: '2026-03-12' });
      expect(await dueDates(tx.id)).toEqual([['2026-04-17', 100]]);
    });

    it('D26: só valor mantém mês, fechamento e vencimento gravados (mesmo com dias alterados)', async () => {
      const own = await db.getRepository(CreditCard).save({
        name: 'Cartão D26',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 0,
        userId: user.id,
      });
      const tx = await service.create(user.id, Plan.PREMIUM, {
        description: 'Compra e2e',
        totalAmount: 300,
        date: '2026-02-20', // faturas 2026-03 (fechada, não coberta), 04 e 05
        type: TransactionType.VARIABLE,
        cardId: own.id,
        installmentsCount: 3,
      });
      // D14: novos dias reagendam só as faturas não fechadas (04 e 05)
      await cards.update(own.id, user.id, { closingDay: 3, dueDay: 9 });
      const stored = async () =>
        (
          await db.getRepository(Installment).find({
            where: { transactionId: tx.id },
            order: { number: 'ASC' },
          })
        ).map((i) => ({
          id: i.id,
          dueDate: String(i.dueDate),
          closingDate: String(i.closingDate),
          amount: Number(i.amount),
        }));
      const before = await stored();
      expect(before.map((i) => [i.dueDate, i.closingDate])).toEqual([
        ['2026-03-17', '2026-03-10'],
        ['2026-04-09', '2026-04-03'],
        ['2026-05-09', '2026-05-03'],
      ]);

      await service.update(tx.id, user.id, { totalAmount: 100 });

      expect(await stored()).toEqual(
        before.map((i, n) => ({ ...i, amount: [33.33, 33.33, 33.34][n] })),
      );
    });

    it('D12: arquivado rejeita compra nova (422) e aceita edição de compra existente', async () => {
      const archived = await db.getRepository(CreditCard).save({
        name: 'Cartão a arquivar',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 0,
        userId: user.id,
      });
      const tx = await buy(100, '2026-03-12', archived.id);
      await cards.archive(archived.id, user.id);

      await expect(buy(50, '2026-03-13', archived.id)).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.CARD_ARCHIVED),
      );
      expect(await db.getRepository(Transaction).count({ where: { cardId: archived.id } })).toBe(1);

      await service.update(tx.id, user.id, { totalAmount: 120 });
      expect(await dueDates(tx.id)).toEqual([['2026-04-17', 120]]);
    });
  });
});
