import { randomUUID } from 'crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { Clock } from '../src/common/clock';
import { ClockModule } from '../src/common/clock.module';
import { ErrorMessages } from '../src/common/constants/error-messages';
import { isForeignKeyViolation } from '../src/common/db-errors';
import { CardsModule } from '../src/cards/cards.module';
import { CardsService } from '../src/cards/cards.service';
import { CardInvoicesService } from '../src/cards/card-invoices.service';
import { CardBrand, CreditCard } from '../src/cards/entities/credit-card.entity';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionType } from '../src/transactions/entities/transaction.entity';
import { InstallmentsModule } from '../src/installments/installments.module';
import { InstallmentsService } from '../src/installments/installments.service';
import { Installment } from '../src/installments/entities/installment.entity';
import { ReportsModule } from '../src/reports/reports.module';
import { ReportsService } from '../src/reports/reports.service';
import { InvoiceLedgerQuery } from '../src/invoices/invoice-ledger.query';
import {
  currentOpenInvoiceMonth,
  installmentStates,
} from '../src/invoices/invoice-ledger.calculator';
import { CardInvoiceDatesService } from '../src/invoices/card-invoice-dates.service';
import { CardInvoiceDate } from '../src/invoices/entities/card-invoice-date.entity';
import { User } from '../src/users/entities/user.entity';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * D31/D32 contra o Postgres real: fatura fechada não reabre quando os dias do cartão mudam.
 * Cenário do business-rules §5: cartão "fecha 25, vence 5", hoje = 27/11/2026 (fatura 2026-12
 * fechou em 25/11 e vence 05/12); o cartão muda para "fecha 28, vence 10" — pelos dias novos a
 * 2026-12 fecharia em 28/11 (pareceria aberta). "Hoje" fixo via `overrideProvider(Clock)`.
 * Requer migrations aplicadas (`make up && make migration-run`).
 */
describe('D31/D32: datas gravadas por fatura (e2e, banco real)', () => {
  const TODAY = '2026-11-27';
  let today = TODAY; // alguns cenários do doc usam outro "hoje" (restaurado no afterEach)
  let moduleRef: TestingModule;
  let db: DataSource;
  let cards: CardsService;
  let cardInvoices: CardInvoicesService;
  let transactions: TransactionsService;
  let installments: InstallmentsService;
  let reports: ReportsService;
  let ledgers: InvoiceLedgerQuery;
  let user: User;

  const newCard = (closingDay = 25, dueDay = 5) =>
    db.getRepository(CreditCard).save({
      name: 'Cartão e2e',
      brand: CardBrand.VISA,
      closingDay,
      dueDay,
      creditLimit: 1000,
      userId: user.id,
    });

  const buy = (card: CreditCard, date: string, totalAmount = 100, installmentsCount?: number) =>
    transactions.create(user.id, Plan.PREMIUM, {
      description: 'Compra e2e',
      totalAmount,
      date,
      type: TransactionType.VARIABLE,
      cardId: card.id,
      installmentsCount,
    });

  const datesOf = async (transactionId: string) =>
    (
      await db
        .getRepository(Installment)
        .find({ where: { transactionId }, order: { number: 'ASC' } })
    ).map((i) => [String(i.closingDate), String(i.dueDate)]);

  const recordedOf = async (cardId: string) =>
    (
      await db
        .getRepository(CardInvoiceDate)
        .find({ where: { cardId }, order: { invoiceMonth: 'ASC' } })
    ).map((r) => [r.invoiceMonth, String(r.closingDate), String(r.dueDate)]);

  /** Muda o cartão de "fecha 25, vence 5" para "fecha 28, vence 10" (D14 + D31). */
  const changeDays = (card: CreditCard) =>
    cards.update(card.id, user.id, { closingDay: 28, dueDay: 10 });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClockModule,
        DatabaseModule,
        CardsModule,
        TransactionsModule,
        InstallmentsModule,
        ReportsModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue({ today: () => today })
      .compile();
    db = moduleRef.get(DataSource);
    cards = moduleRef.get(CardsService);
    cardInvoices = moduleRef.get(CardInvoicesService);
    transactions = moduleRef.get(TransactionsService);
    installments = moduleRef.get(InstallmentsService);
    reports = moduleRef.get(ReportsService);
    ledgers = moduleRef.get(InvoiceLedgerQuery);

    user = await db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan: Plan.PREMIUM,
    });
  });

  afterAll(async () => {
    if (user) await db.getRepository(User).delete(user.id); // cascade apaga o resto
    await moduleRef?.close();
  });

  afterEach(() => {
    today = TODAY;
  });

  describe('gravação na mudança de dias (D31)', () => {
    it('grava as faturas fechadas com parcela/encargo/pagamento e a mais recente; não as abertas', async () => {
      const card = await newCard();
      await buy(card, '2026-11-10'); // 2026-12 (fecha 25/11 — fechada)
      await buy(card, '2026-11-26'); // 2027-01 (fecha 25/12 — aberta)
      await cardInvoices.addCharge(card.id, user.id, '2026-10', { amount: 5 }); // fechada

      await changeDays(card);

      expect(await recordedOf(card.id)).toEqual([
        ['2026-10', '2026-09-25', '2026-10-05'],
        ['2026-12', '2026-11-25', '2026-12-05'],
      ]);
      // D14: a fatura aberta (2027-01) foi reagendada pelos dias novos; a fechada não
      const [rows] = await db.query(
        `SELECT count(*)::int AS n FROM installments i JOIN transactions t ON t.id = i.transaction_id
         WHERE t.card_id = $1 AND i.closing_date = '2026-12-28' AND i.due_date = '2027-01-10'`,
        [card.id],
      );
      expect(rows.n).toBe(1);
    });

    it('fatura fechada mais recente vazia também é gravada; mês já gravado não é sobrescrito', async () => {
      const card = await newCard();
      await changeDays(card);
      expect(await recordedOf(card.id)).toEqual([['2026-12', '2026-11-25', '2026-12-05']]);

      // Nova mudança (28/10 → 20/5): 2026-12 continua com as datas gravadas na 1ª mudança
      await cards.update(card.id, user.id, { closingDay: 20, dueDay: 5 });
      expect(await recordedOf(card.id)).toEqual([['2026-12', '2026-11-25', '2026-12-05']]);
    });

    it('sem mudar os dias (só nome) não grava nada', async () => {
      const card = await newCard();
      await buy(card, '2026-11-10');
      await cards.update(card.id, user.id, { name: 'Renomeado', closingDay: 25 });
      expect(await recordedOf(card.id)).toEqual([]);
    });
  });

  describe('cenário do doc: fecha 25/vence 5 → fecha 28/vence 10, hoje 27/11/2026', () => {
    it('(a) excluir a única compra da fatura fechada 2026-12: continua fechada em 25/11', async () => {
      const card = await newCard();
      const tx = await buy(card, '2026-11-10');
      await changeDays(card);

      await transactions.remove(tx.id, user.id);

      const invoice = await reports.getInvoice(user.id, card.id, '2026-12');
      expect(invoice).toMatchObject({
        closingDate: '2026-11-25',
        dueDate: '2026-12-05',
        status: 'closed',
      });
      expect(invoice.status).not.toBe('open');
    });

    it('(b) compra de 27/11 (depois do fechamento gravado) vai para 2027-01; de 24/11 fica em 2026-12', async () => {
      const card = await newCard();
      await buy(card, '2026-11-10');
      await changeDays(card);

      const late = await buy(card, '2026-11-27', 300, 3);
      expect(await datesOf(late.id)).toEqual([
        ['2026-12-28', '2027-01-10'],
        ['2027-01-28', '2027-02-10'],
        ['2027-02-28', '2027-03-10'],
      ]);

      // compra antes do fechamento gravado entra na fatura gravada, com as datas dela (D13)
      const early = await buy(card, '2026-11-24');
      expect(await datesOf(early.id)).toEqual([['2026-11-25', '2026-12-05']]);
      const dec = await reports.getInvoice(user.id, card.id, '2026-12');
      expect(dec).toMatchObject({ closingDate: '2026-11-25', status: 'closed' });
      expect(dec.items).toHaveLength(2);
    });

    it('(b) edição de data (recálculo) também respeita a data gravada; D24 vale para o resultado', async () => {
      const card = await newCard();
      await buy(card, '2026-11-10');
      await changeDays(card);
      const tx = await buy(card, '2026-12-01');

      await transactions.update(tx.id, user.id, { date: '2026-11-26' });
      expect(await datesOf(tx.id)).toEqual([['2026-12-28', '2027-01-10']]);

      // nova data antes do fechamento gravado → cairia na fatura fechada 2026-12 → 422 (D24)
      await expect(transactions.update(tx.id, user.id, { date: '2026-11-20' })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.PURCHASE_DATE_IN_CLOSED_INVOICE),
      );
    });

    it('(c) D9: pagamento na aberta atual (2027-01) e na fechada (2026-12); 2027-02 → 422', async () => {
      const card = await newCard();
      const tx = await buy(card, '2026-11-10');
      await changeDays(card);
      await transactions.remove(tx.id, user.id); // 2026-12 fica vazia: só a gravação a mantém fechada

      await expect(
        cardInvoices.addPayment(card.id, user.id, '2027-01', { amount: 10 }),
      ).resolves.toMatchObject({ invoiceMonth: '2027-01' });
      await expect(
        cardInvoices.addPayment(card.id, user.id, '2026-12', { amount: 10 }),
      ).resolves.toMatchObject({ invoiceMonth: '2026-12' });
      await expect(
        cardInvoices.addPayment(card.id, user.id, '2027-02', { amount: 10 }),
      ).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.INVOICE_NOT_ACCEPTING_ENTRIES),
      );
      await expect(
        cardInvoices.addCharge(card.id, user.id, '2026-12', { amount: 1 }),
      ).resolves.toBeDefined();
    });

    it('(d) meses sem mudança de dias seguem como antes (cartão sem mudança e meses futuros)', async () => {
      // cartão que nunca mudou: nada gravado, compra de 27/11 pelos dias atuais (2027-01)
      const same = await newCard();
      const tx = await buy(same, '2026-11-27');
      expect(await datesOf(tx.id)).toEqual([['2026-12-25', '2027-01-05']]);
      expect(await recordedOf(same.id)).toEqual([]);
      expect(await reports.getInvoice(user.id, same.id, '2026-12')).toMatchObject({
        closingDate: '2026-11-25',
        dueDate: '2026-12-05',
        status: 'closed',
      });

      // cartão que mudou: meses não gravados usam os dias novos
      const changed = await newCard();
      await changeDays(changed);
      expect(await reports.getInvoice(user.id, changed.id, '2027-02')).toMatchObject({
        closingDate: '2027-01-28',
        dueDate: '2027-02-10',
        status: 'open',
      });
    });
  });

  describe('D31: mês fechado que reabriria pelos dias novos (hoje 26/11/2026)', () => {
    // fecha 25/vence 5 → fecha 27/vence 28: pelos dias novos a 2026-11 fecharia em 27/11 (> hoje)
    it('2026-11 vazia é gravada e continua fechada; D9 aponta 2027-01; colisão D33', async () => {
      today = '2026-11-26';
      const card = await newCard();
      await buy(card, '2026-11-10'); // 2026-12 (fechou 25/11)

      await cards.update(card.id, user.id, { closingDay: 27, dueDay: 28 });

      expect(await recordedOf(card.id)).toEqual([
        ['2026-11', '2026-10-25', '2026-11-05'],
        ['2026-12', '2026-11-25', '2026-12-05'],
      ]);
      expect(await reports.getInvoice(user.id, card.id, '2026-11')).toMatchObject({
        closingDate: '2026-10-25',
        dueDate: '2026-11-05',
        status: 'closed',
      });
      const ledger = await ledgers.loadLedger(user.id, card.id, undefined, today);
      expect(currentOpenInvoiceMonth(ledger!)).toBe('2027-01');
      await expect(
        cardInvoices.addPayment(card.id, user.id, '2027-01', { amount: 10 }),
      ).resolves.toMatchObject({ invoiceMonth: '2027-01' });

      // D33: compra de 26/11 — 2026-11 e 2026-12 gravadas e fechadas → 2027-01 (vence 28/01)
      const tx = await buy(card, '2026-11-26', 200, 2);
      expect(await datesOf(tx.id)).toEqual([
        ['2027-01-27', '2027-01-28'],
        ['2027-02-27', '2027-02-28'],
      ]);
    });
  });

  describe('D32: regra geral com dias novos "fecha 20, vence 5"', () => {
    it('retroativa de 22/11 entra na 2026-12 gravada (fecha 25/11) com as datas dela; edição de data para lá → 422 (D24)', async () => {
      const card = await newCard();
      await cards.update(card.id, user.id, { closingDay: 20, dueDay: 5 });
      expect(await recordedOf(card.id)).toEqual([['2026-12', '2026-11-25', '2026-12-05']]);

      // criação aceita (D13), mesmo em fatura fechada
      const retro = await buy(card, '2026-11-22');
      expect(await datesOf(retro.id)).toEqual([['2026-11-25', '2026-12-05']]);

      // pelos dias novos sozinhos, 22/11 iria para 2027-01; edição de data para 22/11 cairia na
      // 2026-12 gravada (fechada) → D24
      const tx = await buy(card, '2026-12-01');
      expect(await datesOf(tx.id)).toEqual([['2026-12-20', '2027-01-05']]);
      await expect(transactions.update(tx.id, user.id, { date: '2026-11-22' })).rejects.toThrow(
        new UnprocessableEntityException(ErrorMessages.PURCHASE_DATE_IN_CLOSED_INVOICE),
      );
      expect(await datesOf(tx.id)).toEqual([['2026-12-20', '2027-01-05']]);
    });
  });

  describe('isolamento: datas gravadas de um usuário não afetam outro', () => {
    it('mesmo mês (2026-12) em dois usuários: razão e findRecorded só veem as próprias', async () => {
      const other = await db.getRepository(User).save({
        firebaseUid: `e2e-${randomUUID()}`,
        email: `e2e-${randomUUID()}@test.local`,
        plan: Plan.PREMIUM,
      });
      try {
        const mine = await newCard();
        await changeDays(mine); // grava 2026-12 (25/11, 05/12) para `user`
        const theirs = await db.getRepository(CreditCard).save({
          name: 'Cartão do outro',
          brand: CardBrand.VISA,
          closingDay: 28,
          dueDay: 10,
          creditLimit: 1000,
          userId: other.id,
        });

        // o outro usuário: sem gravação, a 2026-12 segue os dias do cartão dele (fecha 28/11)
        expect(await recordedOf(theirs.id)).toEqual([]);
        expect(await reports.getInvoice(other.id, theirs.id, '2026-12')).toMatchObject({
          closingDate: '2026-11-28',
          dueDate: '2026-12-10',
          status: 'open',
        });
        const theirLedger = await ledgers.loadLedger(other.id, theirs.id);
        expect(theirLedger!.recordedDates.size).toBe(0);
        const invoiceDatesService = moduleRef.get(CardInvoiceDatesService);
        expect((await invoiceDatesService.findRecorded(db.manager, theirs.id, other.id)).size).toBe(
          0,
        );
        // ID do cartão alheio com o próprio userId (ou o contrário): nada
        expect((await invoiceDatesService.findRecorded(db.manager, mine.id, other.id)).size).toBe(
          0,
        );
        expect(await ledgers.loadLedger(other.id, mine.id)).toBeUndefined();
        // compra do outro em 27/11 entra na 2026-12 dele (aberta), não é empurrada pela gravação
        const tx = await transactions.create(other.id, Plan.PREMIUM, {
          description: 'Compra e2e',
          totalAmount: 10,
          date: '2026-11-27',
          type: TransactionType.VARIABLE,
          cardId: theirs.id,
        });
        expect(await datesOf(tx.id)).toEqual([['2026-11-28', '2026-12-10']]);
        // e o dono continua vendo a própria gravação
        expect(
          Object.fromEntries(await invoiceDatesService.findRecorded(db.manager, mine.id, user.id)),
        ).toEqual({
          '2026-12': { closingDate: '2026-11-25', dueDate: '2026-12-05' },
        });
      } finally {
        await db.getRepository(User).delete(other.id);
      }
    });
  });

  describe('integridade no banco: o cartão da gravação pertence ao mesmo usuário', () => {
    const insertRecorded = (userId: string, cardId: string) =>
      db.query(
        `INSERT INTO card_invoice_dates (user_id, card_id, invoice_month, closing_date, due_date)
         VALUES ($1, $2, '2026-12', '2026-11-25', '2026-12-05')`,
        [userId, cardId],
      );

    it('card_id de um usuário com user_id de outro → 23503 em FK_card_invoice_dates_card; par correto → ok; excluir o usuário apaga as linhas', async () => {
      const other = await db.getRepository(User).save({
        firebaseUid: `e2e-${randomUUID()}`,
        email: `e2e-${randomUUID()}@test.local`,
        plan: Plan.PREMIUM,
      });
      try {
        const mine = await newCard();

        const err: unknown = await insertRecorded(other.id, mine.id).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(isForeignKeyViolation(err, 'FK_card_invoice_dates_card')).toBe(true);
        expect(await recordedOf(mine.id)).toEqual([]);

        const theirs = await db.getRepository(CreditCard).save({
          name: 'Cartão do outro',
          brand: CardBrand.VISA,
          closingDay: 25,
          dueDay: 5,
          creditLimit: 1000,
          userId: other.id,
        });
        await expect(insertRecorded(other.id, theirs.id)).resolves.toBeDefined();
        expect(await recordedOf(theirs.id)).toEqual([['2026-12', '2026-11-25', '2026-12-05']]);

        await db.getRepository(User).delete(other.id);
        const [{ n }] = await db.query(
          `SELECT count(*)::int AS n FROM card_invoice_dates WHERE user_id = $1`,
          [other.id],
        );
        expect(n).toBe(0);
      } finally {
        await db.getRepository(User).delete(other.id);
      }
    });
  });

  describe('status derivado da listagem (SQL) usa o vencimento gravado por fatura', () => {
    it('GET /installments: SQL e calculadora concordam com a data gravada', async () => {
      // fecha 20, vence 28: compra de 10/11 → fatura 2026-11 (vence 28/11, ainda não vencida)
      const card = await newCard(20, 28);
      const tx = await buy(card, '2026-11-10');
      const list = () => installments.findAll(user.id, { page: 1, limit: 20, cardId: card.id });
      expect((await list()).data.map((i) => i.status)).toEqual(['pending']);

      // Gravação por fatura com vencimento anterior a hoje (ex.: dias antigos do backfill)
      await db.getRepository(CardInvoiceDate).save({
        userId: user.id,
        cardId: card.id,
        invoiceMonth: '2026-11',
        closingDate: '2026-11-15',
        dueDate: '2026-11-25',
      });

      const res = await list();
      const ledger = await ledgers.loadLedger(user.id, card.id);
      const calc = installmentStates(ledger!);
      expect(res.data.map((i) => [i.transactionId, i.status])).toEqual([[tx.id, 'overdue']]);
      expect(res.data.map((i) => calc.get(i.id)?.status)).toEqual(['overdue']);
      const filtered = await installments.findAll(user.id, {
        page: 1,
        limit: 20,
        cardId: card.id,
        status: 'overdue',
      });
      expect(filtered.total).toBe(1);
      expect(await reports.getInvoice(user.id, card.id, '2026-11')).toMatchObject({
        closingDate: '2026-11-15',
        dueDate: '2026-11-25',
        status: 'unpaid',
      });
    });
  });
});
