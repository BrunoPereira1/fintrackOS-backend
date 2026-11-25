import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { Clock } from '../src/common/clock';
import { ClockModule } from '../src/common/clock.module';
import { CardsModule } from '../src/cards/cards.module';
import { CardsService } from '../src/cards/cards.service';
import { CardInvoicesService } from '../src/cards/card-invoices.service';
import { CardBrand, CreditCard } from '../src/cards/entities/credit-card.entity';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionType } from '../src/transactions/entities/transaction.entity';
import { Installment } from '../src/installments/entities/installment.entity';
import { InvoiceLedgerQuery } from '../src/invoices/invoice-ledger.query';
import { InvoicePayment } from '../src/invoices/entities/invoice-payment.entity';
import { cardBalance } from '../src/invoices/invoice-ledger.calculator';
import { User } from '../src/users/entities/user.entity';
import { sumCents, toCents } from '../src/common/money';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * Pagamentos/encargos de fatura, arquivamento e D14 contra o Postgres real (fase 4a do modelo
 * de pagamento). "Hoje" fixo em 2026-03-15 via `overrideProvider(Clock)`. Cartões fecham 10 e
 * vencem 17: a fatura 2026-03 já fechou (10/03) e a aberta atual é 2026-04 (fecha 10/04).
 * Requer migrations aplicadas (`make up && make migration-run`).
 */
describe('Faturas: pagamentos, encargos e cartões (e2e, banco real)', () => {
  const TODAY = '2026-03-15';
  let moduleRef: TestingModule;
  let db: DataSource;
  let cards: CardsService;
  let cardInvoices: CardInvoicesService;
  let transactions: TransactionsService;
  let ledgers: InvoiceLedgerQuery;
  let user: User;
  let other: User;

  const newUser = () =>
    db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan: Plan.PREMIUM,
    });

  const newCard = (owner: User, creditLimit = 1000) =>
    db.getRepository(CreditCard).save({
      name: 'Cartão e2e',
      brand: CardBrand.VISA,
      closingDay: 10,
      dueDay: 17,
      creditLimit,
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

  const balance = async (cardId: string) => {
    const ledger = await ledgers.loadLedger(user.id, cardId);
    return cardBalance(ledger!);
  };

  const datesOf = async (transactionId: string) =>
    (
      await db
        .getRepository(Installment)
        .find({ where: { transactionId }, order: { number: 'ASC' } })
    ).map((i) => [String(i.closingDate), String(i.dueDate)]);

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
      .useValue({ today: () => TODAY })
      .compile();
    db = moduleRef.get(DataSource);
    cards = moduleRef.get(CardsService);
    cardInvoices = moduleRef.get(CardInvoicesService);
    transactions = moduleRef.get(TransactionsService);
    ledgers = moduleRef.get(InvoiceLedgerQuery);

    user = await newUser();
    other = await newUser();
  });

  afterAll(async () => {
    if (user) await db.getRepository(User).delete(user.id); // cascade apaga o resto
    if (other) await db.getRepository(User).delete(other.id);
    await moduleRef?.close();
  });

  describe('compra nova grava closing_date (D14)', () => {
    it('cada parcela recebe o fechamento da sua fatura, sempre antes do vencimento', async () => {
      const card = await newCard(user);
      const tx = await buy(card, 300, '2026-01-05', 3);
      expect(await datesOf(tx.id)).toEqual([
        ['2026-01-10', '2026-01-17'],
        ['2026-02-10', '2026-02-17'],
        ['2026-03-10', '2026-03-17'],
      ]);
    });
  });

  describe('pagamentos e encargos refletem no razão carregado', () => {
    let card: CreditCard;

    beforeAll(async () => {
      card = await newCard(user, 1000);
      // 3 × R$ 100 vencendo 17/01, 17/02 e 17/03
      await buy(card, 300, '2026-01-05', 3);
    });

    it('sem pagamentos: dívida inteira em aberto', async () => {
      expect(await balance(card.id)).toEqual({ outstanding: 300, credit: 0, availableLimit: 700 });
    });

    it('pagamento parcial, total e excedente (crédito), com o limite nunca acima de creditLimit', async () => {
      const partial = await cardInvoices.addPayment(card.id, user.id, '2026-01', {
        amount: 50,
        paidOn: '2026-01-17',
      });
      expect(partial).toMatchObject({ invoiceMonth: '2026-01', amount: 50, paidOn: '2026-01-17' });
      expect(await balance(card.id)).toEqual({ outstanding: 250, credit: 0, availableLimit: 750 });

      // paidOn omitido → hoje (D7)
      const total = await cardInvoices.addPayment(card.id, user.id, '2026-03', { amount: 250 });
      expect(total.paidOn).toBe(TODAY);
      expect(await balance(card.id)).toEqual({ outstanding: 0, credit: 0, availableLimit: 1000 });

      // Fatura aberta atual (2026-04) aceita; excedente vira crédito
      await cardInvoices.addPayment(card.id, user.id, '2026-04', { amount: 40 });
      expect(await balance(card.id)).toEqual({ outstanding: 0, credit: 40, availableLimit: 1000 });
    });

    it('encargo consome o crédito; desfazer pagamento e encargo recalcula', async () => {
      const charge = await cardInvoices.addCharge(card.id, user.id, '2026-03', {
        amount: 15,
        description: 'Juros',
      });
      expect(charge).toMatchObject({ amount: 15, description: 'Juros', invoiceMonth: '2026-03' });
      expect(await balance(card.id)).toEqual({ outstanding: 0, credit: 25, availableLimit: 1000 });

      const overpay = await db
        .getRepository(InvoicePayment)
        .findOneByOrFail({ cardId: card.id, invoiceMonth: '2026-04' });
      await cardInvoices.removePayment(card.id, user.id, '2026-04', overpay.id);
      expect(await balance(card.id)).toEqual({ outstanding: 15, credit: 0, availableLimit: 985 });

      await cardInvoices.removeCharge(card.id, user.id, '2026-03', charge.id);
      expect(await balance(card.id)).toEqual({ outstanding: 0, credit: 0, availableLimit: 1000 });
    });

    it('D9: mês além da fatura aberta atual → 422 (pagamento e encargo), nada gravado', async () => {
      const before = await db.getRepository(InvoicePayment).countBy({ cardId: card.id });
      await expect(
        cardInvoices.addPayment(card.id, user.id, '2026-05', { amount: 10 }),
      ).rejects.toThrow(UnprocessableEntityException);
      await expect(
        cardInvoices.addCharge(card.id, user.id, '2026-05', { amount: 10 }),
      ).rejects.toThrow(UnprocessableEntityException);
      expect(await db.getRepository(InvoicePayment).countBy({ cardId: card.id })).toBe(before);
    });

    it('D7: paidOn depois de hoje → 400', async () => {
      await expect(
        cardInvoices.addPayment(card.id, user.id, '2026-03', { amount: 10, paidOn: '2026-03-16' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('desfazer lançamento de outro mês, de outro cartão ou inexistente → 404', async () => {
      const p = await cardInvoices.addPayment(card.id, user.id, '2026-02', { amount: 1 });
      const otherCard = await newCard(user);
      await expect(cardInvoices.removePayment(card.id, user.id, '2026-03', p.id)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        cardInvoices.removePayment(otherCard.id, user.id, '2026-02', p.id),
      ).rejects.toThrow(NotFoundException);
      await expect(
        cardInvoices.removeCharge(card.id, user.id, '2026-02', randomUUID()),
      ).rejects.toThrow(NotFoundException);
      await cardInvoices.removePayment(card.id, user.id, '2026-02', p.id);
    });

    it('cartão de outro usuário → 403; inexistente → 404', async () => {
      const foreign = await newCard(other);
      await expect(
        cardInvoices.addPayment(foreign.id, user.id, '2026-03', { amount: 1 }),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        cardInvoices.addCharge(randomUUID(), user.id, '2026-03', { amount: 1 }),
      ).rejects.toThrow(NotFoundException);
      expect(await db.getRepository(InvoicePayment).countBy({ cardId: foreign.id })).toBe(0);
    });
  });

  describe('arquivar e reativar (D12)', () => {
    it('arquivado sai da lista, aparece com includeArchived e em GET /:id, aceita pagamento e reativa', async () => {
      const card = await newCard(user, 500);
      await buy(card, 100, '2026-02-20');

      await cards.archive(card.id, user.id);
      await cards.archive(card.id, user.id); // idempotente

      expect((await cards.findAllByUser(user.id)).map((c) => c.id)).not.toContain(card.id);
      const all = await cards.findAllByUser(user.id, { includeArchived: true });
      const archived = all.find((c) => c.id === card.id)!;
      expect(archived.archivedAt).toBeInstanceOf(Date);
      expect(archived).toMatchObject({ outstanding: 100, credit: 0, availableLimit: 400 });

      const detail = await cards.findOneWithBalance(card.id, user.id);
      expect(detail.archivedAt).not.toBeNull();

      // Histórico e pagamentos continuam no arquivado
      await cardInvoices.addPayment(card.id, user.id, '2026-03', { amount: 100 });
      expect(await balance(card.id)).toEqual({ outstanding: 0, credit: 0, availableLimit: 500 });

      const restored = await cards.restore(card.id, user.id);
      expect(restored.archivedAt).toBeNull();
      expect((await cards.findAllByUser(user.id)).map((c) => c.id)).toContain(card.id);
    });

    it('arquivar/reativar cartão de outro usuário → 403', async () => {
      const foreign = await newCard(other);
      await expect(cards.archive(foreign.id, user.id)).rejects.toThrow(ForbiddenException);
      await expect(cards.restore(foreign.id, user.id)).rejects.toThrow(ForbiddenException);
    });
  });

  describe('D14: mudar closingDay/dueDay', () => {
    it('ajusta só parcelas de faturas não fechadas, mantendo o mês da fatura', async () => {
      const card = await newCard(user);
      // Compra 20/02 → 1ª fatura fecha 10/03 (já fechada hoje) e vence 17/03
      const tx = await buy(card, 300, '2026-02-20', 3);
      const closed = await buy(card, 50, '2026-01-20'); // fatura 2026-02, fechada

      const updated = await cards.update(card.id, user.id, { closingDay: 25, dueDay: 5 });
      expect(updated).toMatchObject({ closingDay: 25, dueDay: 5, outstanding: 350 });

      expect(await datesOf(tx.id)).toEqual([
        ['2026-03-10', '2026-03-17'], // fechada: mantém
        ['2026-03-25', '2026-04-05'], // aberta: mesmo mês (04), novas datas
        ['2026-04-25', '2026-05-05'],
      ]);
      expect(await datesOf(closed.id)).toEqual([['2026-02-10', '2026-02-17']]);
    });

    it('fatura que fecha exatamente hoje conta como fechada (não é reagendada)', async () => {
      const card = await db.getRepository(CreditCard).save({
        name: 'Fecha hoje',
        brand: CardBrand.VISA,
        closingDay: 15,
        dueDay: 22,
        creditLimit: 1000,
        userId: user.id,
      });
      // Compra 20/02 → fecha 15/03 (= hoje) e vence 22/03; 2ª parcela fecha 15/04
      const tx = await buy(card, 200, '2026-02-20', 2);

      await cards.update(card.id, user.id, { closingDay: 20, dueDay: 27 });

      expect(await datesOf(tx.id)).toEqual([
        ['2026-03-15', '2026-03-22'],
        ['2026-04-20', '2026-04-27'],
      ]);
    });

    it('editar só o nome não mexe nas parcelas', async () => {
      const card = await newCard(user);
      const tx = await buy(card, 100, '2026-03-20');
      const before = await datesOf(tx.id);
      await cards.update(card.id, user.id, { name: 'Renomeado', closingDay: 10 });
      expect(await datesOf(tx.id)).toEqual(before);
    });
  });

  describe('carga em lote (InvoiceLedgerQuery)', () => {
    let batchUser: User;

    afterAll(async () => {
      if (batchUser) await db.getRepository(User).delete(batchUser.id);
    });

    it('3 cartões com parcelas, encargos e pagamentos: 4 consultas, formatos aceitos pela calculadora', async () => {
      batchUser = await newUser();
      const saved: CreditCard[] = [];
      for (const limit of [1000, 2000, 0]) saved.push(await newCard(batchUser, limit));
      for (const [i, card] of saved.entries()) {
        await transactions.create(batchUser.id, Plan.PREMIUM, {
          description: 'Lote',
          totalAmount: 100 * (i + 1),
          date: '2026-02-20',
          type: TransactionType.VARIABLE,
          cardId: card.id,
        });
        await cardInvoices.addCharge(card.id, batchUser.id, '2026-03', { amount: 10 });
        await cardInvoices.addPayment(card.id, batchUser.id, '2026-03', { amount: 30 });
      }
      // dado de outro usuário não pode entrar no lote
      await cardInvoices.addPayment((await newCard(other)).id, other.id, '2026-03', {
        amount: 999,
      });

      const spy = jest.spyOn(db, 'query');
      const result = await ledgers.loadLedgers(batchUser.id);
      expect(spy).toHaveBeenCalledTimes(4);
      spy.mockRestore();

      expect(result.size).toBe(3);
      expect(saved.map((c) => cardBalance(result.get(c.id)!))).toEqual([
        { outstanding: 80, credit: 0, availableLimit: 920 },
        { outstanding: 180, credit: 0, availableLimit: 1820 },
        { outstanding: 280, credit: 0, availableLimit: null },
      ]);

      const ledger = result.get(saved[0].id)!;
      const charge = ledger.items.find((i) => i.kind === 'charge');
      expect(charge && charge.kind === 'charge' && charge.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
      );
      expect(ledger.payments[0].paidOn).toBe(TODAY);
      expect(ledger.storedDates.get('2026-03')).toEqual({
        closingDate: '2026-03-10',
        dueDate: '2026-03-17',
      });

      // GET /cards usa a mesma carga em lote (sem N+1)
      const spy2 = jest.spyOn(db, 'query');
      const listed = await cards.findAllByUser(batchUser.id);
      expect(spy2.mock.calls.filter(([sql]) => /invoice_payments/.test(String(sql)))).toHaveLength(
        1,
      );
      spy2.mockRestore();
      expect(listed.map((c) => c.availableLimit).sort()).toEqual([1820, 920, null].sort());
    });
  });

  describe('concorrência', () => {
    it('pagamentos simultâneos no mesmo cartão entram todos e a soma fica correta', async () => {
      const card = await newCard(user, 1000);
      await buy(card, 500, '2026-02-20');

      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          cardInvoices.addPayment(card.id, user.id, '2026-03', { amount: 30 }),
        ),
      );

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      const rows = await db.getRepository(InvoicePayment).findBy({ cardId: card.id });
      expect(sumCents(rows, (p) => toCents(p.amount))).toBe(15000);
      expect(await balance(card.id)).toEqual({ outstanding: 350, credit: 0, availableLimit: 650 });
    });
  });
});
