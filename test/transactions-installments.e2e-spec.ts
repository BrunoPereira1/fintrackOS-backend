import { randomUUID } from 'crypto';
import { UnprocessableEntityException } from '@nestjs/common';
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
