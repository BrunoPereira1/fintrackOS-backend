import { randomUUID } from 'crypto';
import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import {
  PaymentMethod,
  Transaction,
  TransactionType,
} from '../src/transactions/entities/transaction.entity';
import { ReportsModule } from '../src/reports/reports.module';
import { ReportsService } from '../src/reports/reports.service';
import { Clock } from '../src/common/clock';
import { ClockModule } from '../src/common/clock.module';
import { CardBrand, CreditCard } from '../src/cards/entities/credit-card.entity';
import { Installment, InstallmentStatus } from '../src/installments/entities/installment.entity';
import { InstallmentsService } from '../src/installments/installments.service';
import { CardsModule } from '../src/cards/cards.module';
import { CardsService } from '../src/cards/cards.service';
import { CardInvoicesService } from '../src/cards/card-invoices.service';
import { InvoicePayment } from '../src/invoices/entities/invoice-payment.entity';
import { User } from '../src/users/entities/user.entity';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * Fatura e resumo mensal contra o Postgres real (queries, joins, datas e isolamento).
 * Requer PostgreSQL com as migrations aplicadas (local: `make up && make migration-run`).
 */
describe('Relatórios (e2e, banco real)', () => {
  const TODAY = '2026-03-08';
  let moduleRef: TestingModule;
  let reports: ReportsService;
  let transactions: TransactionsService;
  let cardInvoices: CardInvoicesService;
  let db: DataSource;
  let user: User;
  let otherUser: User;
  let edgeUser: User; // casos de borda do resumo, isolados das somas acima
  let downgradedUser: User; // BASIC rebaixado com parcelas de cartão antigo
  let pmUser: User; // forma de pagamento (byPaymentMethod), isolado das somas acima
  let invUser: User; // fatura: crédito, encargo, paidLate, arquivado
  let payUser: User; // resumo: cardCharges, paidInMonth, parcial, órfã
  let card25x5: CreditCard; // fecha 25, vence 5
  let card10x17: CreditCard; // fecha 10, vence 17
  let removedCard: CreditCard;

  const newUser = (plan: Plan) =>
    db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan,
    });
  const newCard = (userId: string, name: string, closingDay: number, dueDay: number) =>
    db.getRepository(CreditCard).save({
      name,
      brand: CardBrand.VISA,
      closingDay,
      dueDay,
      creditLimit: 10000,
      userId,
    });
  const buy = (
    userId: string,
    totalAmount: number,
    date: string,
    opts: {
      cardId?: string;
      installmentsCount?: number;
      category?: string;
      paymentMethod?: PaymentMethod;
    } = {},
  ) =>
    transactions.create(userId, Plan.PREMIUM, {
      description: 'Compra e2e',
      totalAmount,
      date,
      type: TransactionType.VARIABLE,
      ...opts,
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClockModule,
        DatabaseModule,
        CardsModule,
        TransactionsModule,
        ReportsModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue({ today: () => TODAY })
      .compile();

    reports = moduleRef.get(ReportsService);
    transactions = moduleRef.get(TransactionsService);
    cardInvoices = moduleRef.get(CardInvoicesService);
    db = moduleRef.get(DataSource);

    user = await newUser(Plan.PREMIUM);
    otherUser = await newUser(Plan.PREMIUM);
    card25x5 = await newCard(user.id, 'Nubank', 25, 5);
    card10x17 = await newCard(user.id, 'Inter', 10, 17);
    removedCard = await newCard(user.id, 'Antigo', 10, 17);

    // Cartão 25/5 — fatura de março/2026 (fecha 25/02, vence 05/03):
    await buy(user.id, 300, '2026-01-20', {
      cardId: card25x5.id,
      installmentsCount: 3,
      category: 'Casa',
    }); // parcelas 05/02, 05/03, 05/04
    await buy(user.id, 89.9, '2026-02-24', { cardId: card25x5.id, category: 'Farmácia' }); // à vista, véspera do fechamento → 05/03
    await buy(user.id, 50, '2026-02-25', { cardId: card25x5.id, category: 'Farmácia' }); // dia do fechamento → 05/04 (fora)

    // Cartão 10/17 — vence 17/03 (ainda não vencida em 08/03)
    await buy(user.id, 200, '2026-02-15', {
      cardId: card10x17.id,
      installmentsCount: 2,
      category: 'Mercado',
    }); // 17/03, 17/04

    // Transação sem cartão em março (regime de caixa: conta pela data)
    await buy(user.id, 45.5, '2026-03-02', { category: 'Mercado' });
    await buy(user.id, 999, '2026-04-01', { category: 'Mercado' }); // outro mês, fora

    // Cartão removido depois da compra: parcela de março continua contando, uma vez só
    await buy(user.id, 30, '2026-02-01', { cardId: removedCard.id, category: 'Casa' }); // antes do fechamento (10/02) → vence 17/02
    await buy(user.id, 70, '2026-02-12', { cardId: removedCard.id, category: 'Casa' }); // após fechamento → 17/03
    await db.getRepository(CreditCard).delete(removedCard.id);

    // Ruído de outro usuário no mesmo mês
    const otherCard = await newCard(otherUser.id, 'Outro', 25, 5);
    await buy(otherUser.id, 5000, '2026-02-01', { cardId: otherCard.id });
    await buy(otherUser.id, 777, '2026-03-03');
  });

  afterAll(async () => {
    for (const u of [user, otherUser, edgeUser, downgradedUser, pmUser, invUser, payUser])
      if (u) await db.getRepository(User).delete(u.id);
    await moduleRef?.close();
  });

  describe('fatura (razão do cartão)', () => {
    it('cartão 25/5, março: itens, datas, saldo anterior vencido e nada coberto → unpaid', async () => {
      const invoice = await reports.getInvoice(user.id, card25x5.id, '2026-03');

      expect(invoice).toMatchObject({
        cardName: 'Nubank',
        month: '2026-03',
        closingDate: '2026-02-25',
        dueDate: '2026-03-05',
        status: 'unpaid', // 05/03 passou, nada coberto
        installmentsTotal: 189.9,
        chargesTotal: 0,
        paymentsTotal: 0,
        coveredAmount: 0,
        remaining: 189.9,
        previousBalance: 100, // fevereiro (venceu 05/02) não pago
        amountDue: 289.9,
        charges: [],
        payments: [],
      });
      // ordem FIFO (lançamento) com os dados descritivos
      expect(
        invoice.items.map((i) => [
          i.purchaseDate,
          i.number,
          i.totalInstallments,
          i.amount,
          i.category,
          i.description,
        ]),
      ).toEqual([
        ['2026-01-20', 2, 3, 100, 'Casa', 'Compra e2e'],
        ['2026-02-24', 1, 1, 89.9, 'Farmácia', 'Compra e2e'],
      ]);
      expect(
        invoice.items.every(
          (i) =>
            i.dueDate === '2026-03-05' &&
            i.closingDate === '2026-02-25' &&
            i.status === 'overdue' &&
            i.coveredAmount === 0 &&
            i.remainingAmount === i.amount,
        ),
      ).toBe(true);
    });

    it('pagamento parcial quita fevereiro primeiro (FIFO) e o saldo rola: partially_paid', async () => {
      await cardInvoices.addPayment(card25x5.id, user.id, '2026-03', { amount: 189.9 });

      const feb = await reports.getInvoice(user.id, card25x5.id, '2026-02');
      expect(feb).toMatchObject({ status: 'paid', remaining: 0, amountDue: 0 });

      const invoice = await reports.getInvoice(user.id, card25x5.id, '2026-03');
      expect(invoice).toMatchObject({
        status: 'partially_paid',
        paymentsTotal: 189.9,
        coveredAmount: 89.9,
        remaining: 100,
        previousBalance: 0,
        amountDue: 100,
      });
      expect(invoice.items.map((i) => [i.status, i.coveredAmount, i.remainingAmount])).toEqual([
        ['overdue', 89.9, 10.1],
        ['overdue', 0, 89.9],
      ]);
      expect(invoice.payments).toEqual([
        { id: expect.any(String), amount: 189.9, paidOn: TODAY, paidLate: true }, // após 05/03
      ]);
    });

    it('quitando o restante a fatura fica paid', async () => {
      await cardInvoices.addPayment(card25x5.id, user.id, '2026-03', { amount: 100 });
      const invoice = await reports.getInvoice(user.id, card25x5.id, '2026-03');
      expect(invoice).toMatchObject({ status: 'paid', remaining: 0, amountDue: 0 });
      expect(invoice.items.every((i) => i.status === 'paid')).toBe(true);
    });

    it('cartão 10/17: março aberto; abril sem saldo anterior antes do vencimento de março', async () => {
      const march = await reports.getInvoice(user.id, card10x17.id, '2026-03');
      expect(march).toMatchObject({
        closingDate: '2026-03-10',
        dueDate: '2026-03-17',
        status: 'open', // hoje (08/03) é antes do fechamento (10/03)
        installmentsTotal: 100,
        remaining: 100,
      });
      expect(march.items[0].status).toBe('pending');

      // D10: março (100 em aberto) ainda não venceu → não aparece como saldo anterior em abril
      const april = await reports.getInvoice(user.id, card10x17.id, '2026-04');
      expect(april).toMatchObject({ previousBalance: 0, remaining: 100, amountDue: 100 });
    });

    it('mês sem itens devolve fatura vazia pelas datas do cartão', async () => {
      const invoice = await reports.getInvoice(user.id, card10x17.id, '2027-12');
      expect(invoice).toMatchObject({
        closingDate: '2027-12-10',
        dueDate: '2027-12-17',
        status: 'open',
        items: [],
        charges: [],
        installmentsTotal: 0,
        remaining: 0,
      });
    });

    it('cartão de outro usuário → 403; inexistente → 404', async () => {
      await expect(reports.getInvoice(otherUser.id, card25x5.id, '2026-03')).rejects.toThrow(
        ForbiddenException,
      );
      await expect(reports.getInvoice(user.id, randomUUID(), '2026-03')).rejects.toThrow(
        NotFoundException,
      );
    });

    describe('crédito, encargo, paidLate e cartão arquivado', () => {
      let card: CreditCard;

      beforeAll(async () => {
        invUser = await newUser(Plan.PREMIUM);
        card = await newCard(invUser.id, 'Crédito', 10, 17);
        await buy(invUser.id, 100, '2026-01-05', { cardId: card.id }); // vence 17/01
        await buy(invUser.id, 200, '2026-02-05', { cardId: card.id }); // vence 17/02
        // janeiro pago depois do vencimento (17/01)
        await cardInvoices.addPayment(card.id, invUser.id, '2026-01', {
          amount: 100,
          paidOn: '2026-01-20',
        });
        await cardInvoices.addCharge(card.id, invUser.id, '2026-02', {
          amount: 5,
          description: 'IOF',
        });
        // fevereiro pago a maior (305 devidos) em dia → 45 de crédito
        await cardInvoices.addPayment(card.id, invUser.id, '2026-02', {
          amount: 250,
          paidOn: '2026-02-15',
        });
      });

      it('paidLate relativo ao vencimento da fatura em que o pagamento foi lançado', async () => {
        const jan = await reports.getInvoice(invUser.id, card.id, '2026-01');
        expect(jan.status).toBe('paid');
        expect(jan.payments.map((p) => [p.paidOn, p.paidLate])).toEqual([['2026-01-20', true]]);

        const feb = await reports.getInvoice(invUser.id, card.id, '2026-02');
        expect(feb.payments.map((p) => [p.paidOn, p.paidLate])).toEqual([['2026-02-15', false]]);
      });

      it('encargo entra na fatura com descrição e é coberto depois das parcelas', async () => {
        const feb = await reports.getInvoice(invUser.id, card.id, '2026-02');
        expect(feb).toMatchObject({
          status: 'paid',
          installmentsTotal: 200,
          chargesTotal: 5,
          paymentsTotal: 250,
          coveredAmount: 205,
          remaining: 0,
          amountDue: 0,
        });
        expect(feb.charges).toEqual([
          {
            id: expect.any(String),
            amount: 5,
            description: 'IOF',
            createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
            status: 'paid',
            coveredAmount: 5,
            remainingAmount: 0,
          },
        ]);
      });

      it('excedente vira crédito: compra nova nasce coberta; encargo em fatura quitada fica descoberto', async () => {
        await buy(invUser.id, 30, '2026-03-01', { cardId: card.id }); // fatura de março (aberta)
        let march = await reports.getInvoice(invUser.id, card.id, '2026-03');
        expect(march).toMatchObject({ status: 'paid', coveredAmount: 30, remaining: 0 });

        await cardInvoices.addCharge(card.id, invUser.id, '2026-03', { amount: 20 });
        march = await reports.getInvoice(invUser.id, card.id, '2026-03');
        // crédito restante (15) cobre parte do encargo; só o encargo fica descoberto
        expect(march).toMatchObject({ status: 'open', remaining: 5, coveredAmount: 45 });
        expect(march.items[0]).toMatchObject({ status: 'paid', remainingAmount: 0 });
        expect(march.charges[0]).toMatchObject({
          description: null,
          coveredAmount: 15,
          remainingAmount: 5,
          status: 'pending',
        });
      });

      it('cartão arquivado continua com a fatura legível', async () => {
        await moduleRef.get(CardsService).archive(card.id, invUser.id);
        const feb = await reports.getInvoice(invUser.id, card.id, '2026-02');
        expect(feb).toMatchObject({ cardName: 'Crédito', status: 'paid', installmentsTotal: 200 });
      });
    });
  });

  describe('resumo mensal (caixa)', () => {
    it('março: parcelas que vencem no mês + transações sem parcelas, sem dupla contagem', async () => {
      const summary = await reports.getMonthlySummary(user.id, Plan.PREMIUM, '2026-03');

      // parcelas de março: 100 + 89.9 (Nubank, cobertas pelos pagamentos da fatura) + 100 (Inter)
      // + 70 (cartão removido: órfã, status gravado pending)
      expect(summary.totals).toEqual({
        spent: 405.4,
        cardInstallments: 359.9,
        cardCharges: 0,
        upfront: 45.5,
      });
      expect(summary.installments).toEqual({ paid: 189.9, pending: 170, overdue: 0 });
      // pagamentos de fatura com paidOn em março (189.9 + 100, hoje) + à vista (45.5)
      expect(summary.paidInMonth).toBe(335.4);
      expect(summary.byCategory).toEqual([
        { category: 'Casa', amount: 170 },
        { category: 'Mercado', amount: 145.5 },
        { category: 'Farmácia', amount: 89.9 },
      ]);
      expect(summary.byCard).toEqual([
        { cardId: card25x5.id, cardName: 'Nubank', amount: 189.9 },
        { cardId: card10x17.id, cardName: 'Inter', amount: 100 },
        { cardId: null, cardName: null, amount: 70 },
      ]);
      // sem forma informada no create → pix (D15); compras de cartão não entram aqui
      expect(summary.byPaymentMethod).toEqual([{ paymentMethod: PaymentMethod.PIX, amount: 45.5 }]);
      expect(summary.receivablesPending).toBe(0);
    });

    it('abaixo de premium, "a receber" vem null', async () => {
      const summary = await reports.getMonthlySummary(user.id, Plan.INTERMEDIATE, '2026-03');
      expect(summary.receivablesPending).toBeNull();
      expect(summary.totals.spent).toBe(405.4);
    });

    it('fevereiro: parcela de cartão coberta (FIFO) e órfã vencida pelo status gravado', async () => {
      const summary = await reports.getMonthlySummary(user.id, Plan.PREMIUM, '2026-02');
      // 100 (Nubank 05/02, coberta pelo pagamento lançado em março) + 30 (órfã pending, 17/02)
      expect(summary.installments).toEqual({ paid: 100, pending: 30, overdue: 30 });
      expect(summary.paidInMonth).toBe(0); // pagamentos foram em março
    });
  });

  describe('resumo mensal — casos de borda', () => {
    beforeAll(async () => {
      edgeUser = await newUser(Plan.PREMIUM);
      const edgeCard = await newCard(edgeUser.id, 'Borda', 10, 17);
      await buy(edgeUser.id, 12.34, '2026-03-31', { category: 'Pix' }); // último dia do mês
      await buy(edgeUser.id, 1, '2026-04-01', { category: 'Pix' }); // primeiro dia do mês seguinte
      await buy(edgeUser.id, 50, '2026-02-15', { cardId: edgeCard.id, category: 'Loja' }); // vence 17/03
      // Status "overdue" gravado (ex.: job diário) numa parcela que pela data ainda não venceu
      await db
        .getRepository(Installment)
        .createQueryBuilder()
        .update()
        .set({ status: InstallmentStatus.OVERDUE })
        .where(
          'transaction_id IN (SELECT id FROM transactions WHERE user_id = :userId AND card_id = :cardId)',
          { userId: edgeUser.id, cardId: edgeCard.id },
        )
        .execute();

      // Usuário que teve cartão (intermediate/premium) e foi rebaixado para BASIC
      downgradedUser = await newUser(Plan.PREMIUM);
      const oldCard = await newCard(downgradedUser.id, 'Antigo', 10, 17);
      await buy(downgradedUser.id, 80, '2026-02-15', {
        cardId: oldCard.id,
        installmentsCount: 2,
      }); // 17/03 e 17/04
      await db.getRepository(User).update(downgradedUser.id, { plan: Plan.BASIC });
    });

    it('pix no último dia do mês (31/03) entra em março; 01/04 fica de fora', async () => {
      const summary = await reports.getMonthlySummary(edgeUser.id, Plan.PREMIUM, '2026-03');
      expect(summary.totals).toEqual({
        spent: 62.34,
        cardInstallments: 50,
        cardCharges: 0,
        upfront: 12.34,
      });
      expect(summary.byCategory).toEqual([
        { category: 'Loja', amount: 50 },
        { category: 'Pix', amount: 12.34 },
      ]);
    });

    it('status gravado de parcela de cartão é ignorado: vale o razão (vence 17/03 → pending)', async () => {
      const summary = await reports.getMonthlySummary(edgeUser.id, Plan.PREMIUM, '2026-03');
      expect(summary.installments).toEqual({ paid: 0, pending: 50, overdue: 0 });
    });

    it('BASIC rebaixado: parcelas do cartão antigo aparecem e "a receber" vem null', async () => {
      const summary = await reports.getMonthlySummary(downgradedUser.id, Plan.BASIC, '2026-03');
      expect(summary.receivablesPending).toBeNull();
      expect(summary.totals.cardInstallments).toBeGreaterThan(0);
      expect(summary.totals).toEqual({
        spent: 40,
        cardInstallments: 40,
        cardCharges: 0,
        upfront: 0,
      });
    });
  });

  describe('forma de pagamento', () => {
    beforeAll(async () => {
      pmUser = await newUser(Plan.PREMIUM);
      const pmCard = await newCard(pmUser.id, 'Forma', 10, 17);
      await buy(pmUser.id, 100, '2026-02-15', { cardId: pmCard.id }); // credit_card, vence 17/03
      await buy(pmUser.id, 0.1, '2026-03-01', { paymentMethod: PaymentMethod.PIX });
      await buy(pmUser.id, 0.2, '2026-03-02'); // omitida → pix
      await buy(pmUser.id, 80, '2026-03-03', { paymentMethod: PaymentMethod.CASH });
      await buy(pmUser.id, 25.5, '2026-03-04', { paymentMethod: PaymentMethod.DEBIT });
      await buy(pmUser.id, 9.99, '2026-03-05', { paymentMethod: PaymentMethod.BOLETO });
      await buy(pmUser.id, 3, '2026-03-06', { paymentMethod: PaymentMethod.TRANSFER });
      // Legado: transação sem cartão anterior à forma de pagamento (backfill deixa NULL)
      const legacy = await buy(pmUser.id, 40, '2026-03-07');
      await db.getRepository(Transaction).update(legacy.id, { paymentMethod: null });
    });

    it('grava credit_card na compra com cartão e pix quando omitida sem cartão', async () => {
      const rows = await db.getRepository(Transaction).find({
        where: { userId: pmUser.id },
        order: { date: 'ASC' },
      });
      expect(rows.map((t) => [t.cardId !== null, t.paymentMethod])).toEqual([
        [true, PaymentMethod.CREDIT_CARD],
        [false, PaymentMethod.PIX],
        [false, PaymentMethod.PIX],
        [false, PaymentMethod.CASH],
        [false, PaymentMethod.DEBIT],
        [false, PaymentMethod.BOLETO],
        [false, PaymentMethod.TRANSFER],
        [false, null],
      ]);
    });

    it('resumo: upfront e byPaymentMethod (null = legado), cartão fora da quebra', async () => {
      const summary = await reports.getMonthlySummary(pmUser.id, Plan.BASIC, '2026-03');
      expect(summary.totals).toEqual({
        spent: 258.79,
        cardInstallments: 100,
        cardCharges: 0,
        upfront: 158.79,
      });
      expect(summary.byPaymentMethod).toEqual([
        { paymentMethod: PaymentMethod.CASH, amount: 80 },
        { paymentMethod: null, amount: 40 },
        { paymentMethod: PaymentMethod.DEBIT, amount: 25.5 },
        { paymentMethod: PaymentMethod.BOLETO, amount: 9.99 },
        { paymentMethod: PaymentMethod.TRANSFER, amount: 3 },
        { paymentMethod: PaymentMethod.PIX, amount: 0.3 },
      ]);
    });

    it('edição entre formas à vista reflete no resumo; legado null recebe forma', async () => {
      const [legacy] = await db
        .getRepository(Transaction)
        .find({ where: { userId: pmUser.id, totalAmount: 40 } });
      await transactions.update(legacy.id, pmUser.id, { paymentMethod: PaymentMethod.CASH });

      const summary = await reports.getMonthlySummary(pmUser.id, Plan.BASIC, '2026-03');
      expect(summary.byPaymentMethod[0]).toEqual({
        paymentMethod: PaymentMethod.CASH,
        amount: 120,
      });
      expect(summary.byPaymentMethod.some((g) => g.paymentMethod === null)).toBe(false);
    });

    it('compra de cartão não troca para forma à vista (422) e o banco barra cartão sem credit_card', async () => {
      const [cardTx] = await db
        .getRepository(Transaction)
        .find({ where: { userId: pmUser.id, totalAmount: 100 } });
      await expect(
        transactions.update(cardTx.id, pmUser.id, { paymentMethod: PaymentMethod.PIX }),
      ).rejects.toThrow(UnprocessableEntityException);

      await expect(
        db.getRepository(Transaction).update(cardTx.id, { paymentMethod: PaymentMethod.PIX }),
      ).rejects.toThrow(/CHK_transactions_payment_method_card/);
    });
  });

  describe('resumo mensal — razão: encargos, pagamentos, parcial e órfã', () => {
    let card: CreditCard;
    let orphanCard: CreditCard;

    beforeAll(async () => {
      payUser = await newUser(Plan.PREMIUM);
      card = await newCard(payUser.id, 'Razão', 10, 17);
      orphanCard = await newCard(payUser.id, 'Removido', 10, 17);
      // 3x de 100: vencem 17/01, 17/02, 17/03
      await buy(payUser.id, 300, '2026-01-05', {
        cardId: card.id,
        installmentsCount: 3,
        category: 'Casa',
      });
      await buy(payUser.id, 50, '2026-02-20', { cardId: card.id, category: 'Loja' }); // 17/03
      await buy(payUser.id, 10, '2026-03-02', { category: 'Mercado' }); // pix

      // Pagamento legado (migração D18): paid_on NULL, quita janeiro
      await db.getRepository(InvoicePayment).save({
        userId: payUser.id,
        cardId: card.id,
        invoiceMonth: '2026-01',
        amount: 100,
        paidOn: null,
      });
      // Fevereiro parcialmente pago em 01/03 (60 de 100)
      await cardInvoices.addPayment(card.id, payUser.id, '2026-02', {
        amount: 60,
        paidOn: '2026-03-01',
      });
      // Encargo na fatura aberta atual (março fecha 10/03)
      await cardInvoices.addCharge(card.id, payUser.id, '2026-03', {
        amount: 12.34,
        description: 'Juros',
      });

      // Órfã legada: cartão removido (antes do arquivamento) e parcela marcada paga pelo PATCH
      const orphanTx = await buy(payUser.id, 20, '2026-02-20', {
        cardId: orphanCard.id,
        category: 'Casa',
      }); // 17/03
      await db.getRepository(CreditCard).delete(orphanCard.id);
      const [orphan] = await db
        .getRepository(Installment)
        .find({ where: { transactionId: orphanTx.id } });
      await moduleRef
        .get(InstallmentsService)
        .update(orphan.id, payUser.id, { status: InstallmentStatus.PAID });
    });

    it('março: cardCharges em spent e byCard (fora de byCategory); paidInMonth sem legado', async () => {
      const summary = await reports.getMonthlySummary(payUser.id, Plan.BASIC, '2026-03');

      expect(summary.totals).toEqual({
        spent: 192.34,
        cardInstallments: 170,
        cardCharges: 12.34,
        upfront: 10,
      });
      // 100 (3ª parcela) + 50 não cobertos (o pago foi para fevereiro); órfã paga (gravado)
      expect(summary.installments).toEqual({ paid: 20, pending: 150, overdue: 0 });
      // 60 (paidOn 01/03) + 10 à vista; o legado (paid_on NULL) fica fora
      expect(summary.paidInMonth).toBe(70);
      expect(summary.byCard).toEqual([
        { cardId: card.id, cardName: 'Razão', amount: 162.34 },
        { cardId: null, cardName: null, amount: 20 },
      ]);
      expect(summary.byCategory).toEqual([
        { category: 'Casa', amount: 120 },
        { category: 'Loja', amount: 50 },
        { category: 'Mercado', amount: 10 },
      ]);
    });

    it('fevereiro: parcela parcialmente coberta conta por valor (coberto / não coberto vencido)', async () => {
      const summary = await reports.getMonthlySummary(payUser.id, Plan.BASIC, '2026-02');
      expect(summary.installments).toEqual({ paid: 60, pending: 40, overdue: 40 });
      expect(summary.paidInMonth).toBe(0);
    });

    it('janeiro: legado cobre a parcela; não conta em paidInMonth', async () => {
      const summary = await reports.getMonthlySummary(payUser.id, Plan.BASIC, '2026-01');
      expect(summary.installments).toEqual({ paid: 100, pending: 0, overdue: 0 });
      expect(summary.paidInMonth).toBe(0);
    });
  });
});
