import { randomUUID } from 'crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionsController } from '../src/transactions/transactions.controller';
import { TransactionType } from '../src/transactions/entities/transaction.entity';
import { SplitsModule } from '../src/splits/splits.module';
import { SplitsService } from '../src/splits/splits.service';
import { SplitStatus } from '../src/splits/entities/cost-split.entity';
import { ContactsService } from '../src/contacts/contacts.service';
import { ReportsModule } from '../src/reports/reports.module';
import { ReportsService } from '../src/reports/reports.service';
import { Clock } from '../src/common/clock';
import { ClockModule } from '../src/common/clock.module';
import { CardBrand, CreditCard } from '../src/cards/entities/credit-card.entity';
import { Installment, InstallmentStatus } from '../src/installments/entities/installment.entity';
import { CardsModule } from '../src/cards/cards.module';
import { CardInvoicesService } from '../src/cards/card-invoices.service';
import { User } from '../src/users/entities/user.entity';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * "Quem me deve" contra o Postgres real: joins splits × contatos × transações × parcelas,
 * isolamento por usuário e datas. Requer migrations aplicadas (`make migration-run`).
 */
describe('Quem me deve (e2e, banco real)', () => {
  let moduleRef: TestingModule;
  let reports: ReportsService;
  let db: DataSource;
  let user: User;
  let otherUser: User;
  let ana: { id: string };
  let bruno: { id: string };
  let carla: { id: string };
  let cardTxId: string;
  let cardId: string;

  const newUser = () =>
    moduleRef
      .get(DataSource)
      .getRepository(User)
      .save({
        firebaseUid: `e2e-${randomUUID()}`,
        email: `e2e-${randomUUID()}@test.local`,
        plan: Plan.PREMIUM,
      });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClockModule,
        DatabaseModule,
        CardsModule,
        TransactionsModule,
        SplitsModule,
        ReportsModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue({ today: () => '2026-03-08' })
      .compile();

    reports = moduleRef.get(ReportsService);
    db = moduleRef.get(DataSource);
    const tx = moduleRef.get(TransactionsService);
    const splits = moduleRef.get(SplitsService);
    const contacts = moduleRef.get(ContactsService);

    user = await newUser();
    otherUser = await newUser();
    ana = await contacts.create(user.id, { name: 'Ana', email: 'Ana@X.com' });
    bruno = await contacts.create(user.id, { name: 'Bruno' });
    carla = await contacts.create(user.id, { name: 'Carla' }); // sem splits
    const otherContact = await contacts.create(otherUser.id, { name: 'Ana' });

    const card = await db.getRepository(CreditCard).save({
      name: 'Nubank',
      brand: CardBrand.VISA,
      closingDay: 25,
      dueDay: 5,
      creditLimit: 10000,
      userId: user.id,
    });
    const buy = (userId: string, totalAmount: number, date: string, cardId?: string, n?: number) =>
      tx.create(userId, Plan.PREMIUM, {
        description: `Compra ${date}`,
        totalAmount,
        date,
        type: TransactionType.VARIABLE,
        cardId,
        installmentsCount: n,
      });

    // Compra de R$ 600 em 3x no cartão (parcelas 05/02, 05/03, 05/04); Ana deve tudo
    const cardTx = await buy(user.id, 600, '2026-01-20', card.id, 3);
    cardTxId = cardTx.id;
    await splits.create(user.id, {
      transactionId: cardTx.id,
      contactId: ana.id,
      assignedAmount: 600,
    });

    // Pix de R$ 100 em 01/03: Ana deve 33.33, Bruno 33.33 (pago)
    const pix = await buy(user.id, 100, '2026-03-01');
    await splits.create(user.id, {
      transactionId: pix.id,
      contactId: ana.id,
      assignedAmount: 33.33,
    });
    const brunoSplit = await splits.create(user.id, {
      transactionId: pix.id,
      contactId: bruno.id,
      assignedAmount: 33.33,
    });
    await splits.update(brunoSplit.id, user.id, { status: SplitStatus.PAID });

    // Dados de outro usuário (mesmo nome de contato) não podem aparecer
    const otherPix = await buy(otherUser.id, 999, '2026-03-01');
    await splits.create(otherUser.id, {
      transactionId: otherPix.id,
      contactId: otherContact.id,
      assignedAmount: 999,
    });

    // Primeira parcela da compra no cartão paga pela fatura (FIFO); o status gravado é ignorado
    cardId = card.id;
    await moduleRef
      .get(CardInvoicesService)
      .addPayment(card.id, user.id, '2026-02', { amount: 200, paidOn: '2026-02-05' });
    await db
      .getRepository(Installment)
      .update({ transactionId: cardTx.id, number: 3 }, { status: InstallmentStatus.PAID });
  });

  afterAll(async () => {
    for (const u of [user, otherUser]) if (u) await db.getRepository(User).delete(u.id);
    await moduleRef?.close();
  });

  it('padrão (pending): só quem deve, valor cheio do parcelado e situação das parcelas', async () => {
    const result = await reports.getReceivables(user.id, { status: 'pending' });

    expect(result.totals).toEqual({ pending: 633.33, paid: 0 });
    expect(result.contacts).toHaveLength(1);
    const [anaRow] = result.contacts;
    expect(anaRow).toMatchObject({
      contactId: ana.id,
      name: 'Ana',
      email: 'ana@x.com', // normalizado no contato
      pending: 633.33,
      paid: 0,
      pendingCount: 2,
      oldestPendingDate: '2026-01-20',
    });
    expect(anaRow).not.toHaveProperty('phone');
    expect(anaRow.splits.map((s) => [s.transactionDate, s.amount, s.status])).toEqual([
      ['2026-01-20', 600, 'pending'],
      ['2026-03-01', 33.33, 'pending'],
    ]);
    expect(anaRow.splits[0]).toMatchObject({
      transactionId: cardTxId,
      installments: { total: 3, paid: 1, remaining: 2, nextDueDate: '2026-03-05' },
    });
    expect(anaRow.splits[1].installments).toBeNull(); // pix
  });

  it('parcela parcialmente coberta continua não paga; órfã usa o status gravado', async () => {
    await moduleRef
      .get(CardInvoicesService)
      .addPayment(cardId, user.id, '2026-03', { amount: 50, paidOn: '2026-03-08' });
    let [anaRow] = (await reports.getReceivables(user.id, { status: 'pending' })).contacts;
    expect(anaRow.splits[0].installments).toEqual({
      total: 3,
      paid: 1,
      remaining: 2,
      nextDueDate: '2026-03-05',
    });

    // Cartão removido antes do arquivamento (legado): parcelas viram órfãs, vale o gravado
    // (só a 3ª foi gravada como paga)
    await db.getRepository(CreditCard).delete(cardId);
    [anaRow] = (await reports.getReceivables(user.id, { status: 'pending' })).contacts;
    expect(anaRow.splits[0].installments).toEqual({
      total: 3,
      paid: 1,
      remaining: 2,
      nextDueDate: '2026-02-05',
    });
  });

  it('status=paid: Bruno aparece com o split pago e paidAt ISO', async () => {
    const result = await reports.getReceivables(user.id, { status: 'paid' });
    expect(result.contacts.map((c) => c.name)).toEqual(['Bruno']);
    expect(result.contacts[0].splits[0].paidAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect(result.totals).toEqual({ pending: 0, paid: 33.33 });
  });

  it('status=all: Ana e Bruno (Carla, sem splits, não aparece), ordenados por pendente', async () => {
    const result = await reports.getReceivables(user.id, { status: 'all' });
    expect(result.contacts.map((c) => c.name)).toEqual(['Ana', 'Bruno']);
    expect(result.contacts.find((c) => c.contactId === carla.id)).toBeUndefined();
  });

  it('filtro por contato', async () => {
    const result = await reports.getReceivables(user.id, { status: 'all', contactId: bruno.id });
    expect(result.contacts.map((c) => c.contactId)).toEqual([bruno.id]);
  });

  // Filtro de listagem (query string): id alheio ou inexistente → vazio, nunca 404/403
  // (não revela existência — patterns.md, business-rules §6)
  const EMPTY = { totals: { pending: 0, paid: 0 }, contacts: [] };

  it('filtro por contato inexistente → resultado vazio', async () => {
    expect(
      await reports.getReceivables(user.id, { status: 'all', contactId: randomUUID() }),
    ).toEqual(EMPTY);
  });

  it('contato de outro usuário no filtro → resultado vazio (mesma resposta do inexistente)', async () => {
    expect(
      await reports.getReceivables(otherUser.id, { status: 'all', contactId: ana.id }),
    ).toEqual(EMPTY);
  });

  it('outro usuário só vê os próprios splits', async () => {
    const result = await reports.getReceivables(otherUser.id, { status: 'all' });
    expect(result.totals).toEqual({ pending: 999, paid: 0 });
    expect(result.contacts).toHaveLength(1);
  });

  it('renomear o contato reflete na visão', async () => {
    await moduleRef.get(ContactsService).update(ana.id, user.id, { name: 'Ana Souza' });
    const result = await reports.getReceivables(user.id, { status: 'pending' });
    expect(result.contacts[0].name).toBe('Ana Souza');
  });
  it('GET /transactions/:id (premium) traz splits com contato resumido, sem telefone', async () => {
    await moduleRef.get(ContactsService).update(bruno.id, user.id, { phone: '+5581999990000' });
    const controller = moduleRef.get(TransactionsController);
    const pix = (await reports.getReceivables(user.id, { status: 'paid' })).contacts[0].splits[0];

    const tx = await controller.findOne(user, pix.transactionId);

    const brunoSplit = tx.splits?.find((s) => s.contactId === bruno.id);
    expect(brunoSplit?.contact).toEqual({ id: bruno.id, name: 'Bruno', email: null });
    expect(JSON.stringify(tx)).not.toContain('+5581999990000');
  });
});
