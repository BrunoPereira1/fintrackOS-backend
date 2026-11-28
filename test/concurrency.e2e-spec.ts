import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, QueryRunner } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { Clock } from '../src/common/clock';
import { ClockModule } from '../src/common/clock.module';
import { ErrorMessages } from '../src/common/constants/error-messages';
import { CardsModule } from '../src/cards/cards.module';
import { CardsService } from '../src/cards/cards.service';
import { CardInvoicesService } from '../src/cards/card-invoices.service';
import { CardBrand, CreditCard } from '../src/cards/entities/credit-card.entity';
import { Installment } from '../src/installments/entities/installment.entity';
import { InvoicePayment } from '../src/invoices/entities/invoice-payment.entity';
import { TransactionsModule } from '../src/transactions/transactions.module';
import { TransactionsService } from '../src/transactions/transactions.service';
import { Transaction, TransactionType } from '../src/transactions/entities/transaction.entity';
import { SplitsModule } from '../src/splits/splits.module';
import { SplitsService } from '../src/splits/splits.service';
import { CostSplit, SplitStatus } from '../src/splits/entities/cost-split.entity';
import { ContactsService } from '../src/contacts/contacts.service';
import { User } from '../src/users/entities/user.entity';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * Invariantes sob requisições simultâneas, contra o Postgres real (trava FOR UPDATE na
 * linha da transação e, para compra no cartão, antes na do cartão — ordem cartão → transação).
 * "Hoje" fixo em 2026-03-15 (`overrideProvider(Clock)`). Requer migrations aplicadas
 * (`make migration-run`).
 */
describe('Concorrência (e2e, banco real)', () => {
  let moduleRef: TestingModule;
  let db: DataSource;
  let transactions: TransactionsService;
  let splits: SplitsService;
  let cards: CardsService;
  let cardInvoices: CardInvoicesService;
  let user: User;
  let contactId: string;

  const pix = (totalAmount: number) =>
    transactions.create(user.id, Plan.PREMIUM, {
      description: 'Pix e2e',
      totalAmount,
      date: '2026-03-01',
      type: TransactionType.VARIABLE,
    });

  const sumSplits = async (transactionId: string) =>
    (await db.getRepository(CostSplit).find({ where: { transactionId } })).reduce(
      (acc, s) => acc + Math.round(Number(s.assignedAmount) * 100),
      0,
    );

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClockModule,
        DatabaseModule,
        CardsModule,
        TransactionsModule,
        SplitsModule,
      ],
    })
      .overrideProvider(Clock)
      .useValue({ today: () => '2026-03-15' })
      .compile();
    db = moduleRef.get(DataSource);
    transactions = moduleRef.get(TransactionsService);
    splits = moduleRef.get(SplitsService);
    cards = moduleRef.get(CardsService);
    cardInvoices = moduleRef.get(CardInvoicesService);

    user = await db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan: Plan.PREMIUM,
    });
    contactId = (await moduleRef.get(ContactsService).create(user.id, { name: 'Ana' })).id;
  });

  afterAll(async () => {
    if (user) await db.getRepository(User).delete(user.id);
    await moduleRef?.close();
  });

  it('splits simultâneos nunca passam do total da transação', async () => {
    const tx = await pix(100);

    // 6 pedidos de R$ 30 ao mesmo tempo numa compra de R$ 100: só 3 cabem
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        splits.create(user.id, { transactionId: tx.id, contactId, assignedAmount: 30 }),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(ok).toHaveLength(3);
    expect(rejected.every((r) => r.reason instanceof UnprocessableEntityException)).toBe(true);
    expect(await sumSplits(tx.id)).toBe(9000);
  });

  it('reduzir o total ao mesmo tempo que se cria split mantém Σ splits ≤ total', async () => {
    for (let round = 0; round < 5; round++) {
      const tx = await pix(100);
      await splits.create(user.id, { transactionId: tx.id, contactId, assignedAmount: 50 });

      await Promise.allSettled([
        transactions.update(tx.id, user.id, { totalAmount: 60 }),
        splits.create(user.id, { transactionId: tx.id, contactId, assignedAmount: 40 }),
      ]);

      const [{ total_amount }] = await db.query(
        'SELECT total_amount FROM transactions WHERE id = $1',
        [tx.id],
      );
      expect(await sumSplits(tx.id)).toBeLessThanOrEqual(Math.round(Number(total_amount) * 100));
    }
  });

  it('excluir transação com split pendente → 409; com tudo pago, exclui', async () => {
    const tx = await pix(100);
    const split = await splits.create(user.id, {
      transactionId: tx.id,
      contactId,
      assignedAmount: 20,
    });

    await expect(transactions.remove(tx.id, user.id)).rejects.toThrow(ConflictException);

    await splits.update(split.id, user.id, { status: SplitStatus.PAID });
    await transactions.remove(tx.id, user.id);
    expect(await db.getRepository(CostSplit).count({ where: { transactionId: tx.id } })).toBe(0);
  });

  it('voltar split para pendente × excluir a transação: nunca os dois (sem 500)', async () => {
    // Sob a trava da transação: ou o split volta a pendente e a exclusão dá 409, ou a exclusão
    // vence e a mudança do split dá 404. Sem a trava, as duas passariam (transação apagada
    // com alguém devendo) ou o save reinseriria o split apagado (FK → 500).
    for (let round = 0; round < 10; round++) {
      const tx = await pix(100);
      const split = await splits.create(user.id, {
        transactionId: tx.id,
        contactId,
        assignedAmount: 20,
      });
      await splits.update(split.id, user.id, { status: SplitStatus.PAID });

      const [toPending, removal] = await Promise.allSettled([
        splits.update(split.id, user.id, { status: SplitStatus.PENDING }),
        transactions.remove(tx.id, user.id),
      ]);

      if (removal.status === 'fulfilled') {
        expect(toPending.status).toBe('rejected');
        expect((toPending as PromiseRejectedResult).reason).toEqual(
          new NotFoundException(ErrorMessages.NOT_FOUND.SPLIT),
        );
        expect(await db.getRepository(CostSplit).count({ where: { id: split.id } })).toBe(0);
      } else {
        expect(removal.reason).toBeInstanceOf(ConflictException);
        expect(toPending.status).toBe('fulfilled');
        const stored = await db.getRepository(CostSplit).findOneByOrFail({ id: split.id });
        expect(stored.status).toBe(SplitStatus.PENDING);
      }
    }
  });

  describe('compra no cartão sob a trava do cartão (fase 4c)', () => {
    // Fecha 10, vence 17; hoje 15/03: fatura 2026-03 fechada, 2026-04 é a aberta atual
    const newCard = () =>
      db.getRepository(CreditCard).save({
        name: 'Cartão concorrência',
        brand: CardBrand.VISA,
        closingDay: 10,
        dueDay: 17,
        creditLimit: 5000,
        userId: user.id,
      });

    const buy = (cardId: string, totalAmount: number, date: string, installmentsCount?: number) =>
      transactions.create(user.id, Plan.PREMIUM, {
        description: 'Compra e2e',
        totalAmount,
        date,
        type: TransactionType.VARIABLE,
        cardId,
        installmentsCount,
      });

    const installmentsOf = async (transactionId: string) =>
      (
        await db
          .getRepository(Installment)
          .find({ where: { transactionId }, order: { number: 'ASC' } })
      ).map((i) => [String(i.closingDate), String(i.dueDate), Number(i.amount)]);

    /**
     * Segura a trava do cartão numa conexão à parte, para enfileirar as requisições numa ordem
     * determinística (fila de `FOR UPDATE` na mesma linha é FIFO no Postgres).
     */
    const holdCardLock = async (cardId: string) => {
      const qr: QueryRunner = db.createQueryRunner();
      await qr.connect();
      await qr.startTransaction();
      await qr.query('SELECT id FROM credit_cards WHERE id = $1 FOR UPDATE', [cardId]);
      const [{ pid }] = await qr.query('SELECT pg_backend_pid() AS pid');
      const release = async () => {
        await qr.commitTransaction();
        await qr.release();
      };
      return { pid: pid as number, release };
    };

    /** Conexões esperando (direta ou transitivamente) a conexão `pid`. */
    const waitersOf = async (pid: number): Promise<number> => {
      const [{ n }] = await db.query(
        `WITH RECURSIVE w(pid) AS (
           SELECT a.pid FROM pg_stat_activity a WHERE $1 = ANY(pg_blocking_pids(a.pid))
           UNION
           SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid))
         ) SELECT count(*)::int AS n FROM w`,
        [pid],
      );
      return n;
    };

    const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 3000): Promise<boolean> => {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        if (await cond()) return true;
        await new Promise((r) => setTimeout(r, 20));
      }
      return false;
    };

    /**
     * Enfileira `first` e depois `second` atrás de uma trava do cartão e solta: com a trava do
     * cartão nas duas, `second` roda depois de `first` ter comitado.
     */
    const inOrder = async <A, B>(
      cardId: string,
      first: () => Promise<A>,
      second: () => Promise<B>,
    ) => {
      const lock = await holdCardLock(cardId);
      try {
        const a = first();
        a.catch(() => undefined);
        // `first` precisa estar na fila antes de `second` (senão a ordem não é determinística)
        expect(await waitFor(async () => (await waitersOf(lock.pid)) >= 1)).toBe(true);
        const b = second();
        const bSettled = b.then(
          () => true,
          () => true,
        );
        // sem a trava do cartão `second` não espera: segue assim que terminar
        await Promise.race([bSettled, waitFor(async () => (await waitersOf(lock.pid)) >= 2)]);
        await lock.release();
        return await Promise.allSettled([a, b]);
      } catch (err) {
        await lock.release().catch(() => undefined);
        throw err;
      }
    };

    it('(a) pagamento na frente do recálculo: o recálculo vê o pagamento e aplica D20', async () => {
      const card = await newCard();
      const tx = await buy(card.id, 100, '2026-02-20'); // fatura 2026-03 (fechou 10/03)
      const before = await installmentsOf(tx.id);

      const [payment, recalc] = await inOrder(
        card.id,
        () => cardInvoices.addPayment(card.id, user.id, '2026-03', { amount: 100 }),
        () => transactions.update(tx.id, user.id, { totalAmount: 150 }),
      );

      expect(payment.status).toBe('fulfilled');
      expect(recalc).toEqual({
        status: 'rejected',
        reason: new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
      });
      expect(await installmentsOf(tx.id)).toEqual(before);
    });

    it('(a) pagamento × recálculo simultâneos: nunca estado misto', async () => {
      for (let round = 0; round < 5; round++) {
        const card = await newCard();
        const tx = await buy(card.id, 100, '2026-02-20');

        const [payment, recalc] = await Promise.allSettled([
          cardInvoices.addPayment(card.id, user.id, '2026-03', { amount: 100 }),
          transactions.update(tx.id, user.id, { totalAmount: 150 }),
        ]);

        expect(payment.status).toBe('fulfilled');
        const amounts = (await installmentsOf(tx.id)).map(([, , amount]) => amount);
        if (recalc.status === 'fulfilled') {
          // recálculo primeiro: o pagamento cobriu parte das parcelas novas
          expect(amounts).toEqual([150]);
        } else {
          // pagamento primeiro: D20 barrou e as parcelas são as originais
          expect(recalc.reason).toEqual(
            new UnprocessableEntityException(ErrorMessages.PURCHASE_COVERED_IN_CLOSED_INVOICE),
          );
          expect(amounts).toEqual([100]);
        }
        expect(await db.getRepository(InvoicePayment).count({ where: { cardId: card.id } })).toBe(
          1,
        );
      }
    });

    it('(b) arquivar × criar compra: nunca compra nova em cartão arquivado', async () => {
      const card = await newCard();

      const [archive, purchase] = await inOrder(
        card.id,
        () => cards.archive(card.id, user.id),
        () => buy(card.id, 80, '2026-03-20'),
      );

      expect(archive.status).toBe('fulfilled');
      expect(purchase).toEqual({
        status: 'rejected',
        reason: new UnprocessableEntityException(ErrorMessages.CARD_ARCHIVED),
      });
      expect(await db.getRepository(Transaction).count({ where: { cardId: card.id } })).toBe(0);
    });

    it('(c) mudar os dias do cartão (D14) × criar compra: a compra sai com os dias novos', async () => {
      const card = await newCard();

      const [edit, purchase] = await inOrder(
        card.id,
        () => cards.update(card.id, user.id, { closingDay: 5, dueDay: 12 }),
        () => buy(card.id, 90, '2026-03-20'),
      );

      expect(edit.status).toBe('fulfilled');
      expect(purchase.status).toBe('fulfilled');
      const tx = (purchase as PromiseFulfilledResult<Transaction>).value;
      // dias antigos dariam fechamento 10/04 e vencimento 17/04 (fatura aberta)
      expect(await installmentsOf(tx.id)).toEqual([['2026-04-05', '2026-04-12', 90]]);
    });

    it('(c) criar compra × mudar os dias: a reprogramação alcança a compra nova', async () => {
      const card = await newCard();

      const [purchase, edit] = await inOrder(
        card.id,
        () => buy(card.id, 90, '2026-03-20'),
        () => cards.update(card.id, user.id, { closingDay: 5, dueDay: 12 }),
      );

      expect(edit.status).toBe('fulfilled');
      const tx = (purchase as PromiseFulfilledResult<Transaction>).value;
      expect(await installmentsOf(tx.id)).toEqual([['2026-04-05', '2026-04-12', 90]]);
    });

    it('(c) mudar os dias × compra no fechamento gravado: a compra vê a data gravada (D31/D32)', async () => {
      // Fecha 10/vence 17 → fecha 16/vence 20, hoje 15/03: a 2026-03 fechou em 10/03 e é gravada
      // (pelos dias novos fecharia 16/03 — reabriria). Compra de 12/03: com a gravação vai para
      // 2026-04 (16/04, 20/04); sem ela (findRecorded lido antes da trava, quando a mudança ainda
      // não comitou) cairia na 2026-03 pelos dias novos (16/03, 20/03).
      const card = await newCard();

      const [edit, purchase] = await inOrder(
        card.id,
        () => cards.update(card.id, user.id, { closingDay: 16, dueDay: 20 }),
        () => buy(card.id, 70, '2026-03-12'),
      );

      expect(edit.status).toBe('fulfilled');
      expect(purchase.status).toBe('fulfilled');
      const [recorded] = await db.query(
        `SELECT to_char(closing_date, 'YYYY-MM-DD') AS c FROM card_invoice_dates
         WHERE card_id = $1 AND invoice_month = '2026-03'`,
        [card.id],
      );
      expect(recorded).toEqual({ c: '2026-03-10' });
      const tx = (purchase as PromiseFulfilledResult<Transaction>).value;
      expect(await installmentsOf(tx.id)).toEqual([['2026-04-16', '2026-04-20', 70]]);
    });

    it('D30: cardId alheio no body não trava a linha da vítima (responde 400 sem esperar)', async () => {
      const victim = await db.getRepository(User).save({
        firebaseUid: `e2e-${randomUUID()}`,
        email: `e2e-${randomUUID()}@test.local`,
        plan: Plan.PREMIUM,
      });
      try {
        const victimCard = await db.getRepository(CreditCard).save({
          name: 'Cartão da vítima',
          brand: CardBrand.VISA,
          closingDay: 10,
          dueDay: 17,
          creditLimit: 5000,
          userId: victim.id,
        });
        const lock = await holdCardLock(victimCard.id);
        try {
          const attempt = buy(victimCard.id, 10, '2026-03-20');
          attempt.catch(() => undefined);
          const outcome = await Promise.race([
            attempt.then(
              () => 'fulfilled',
              (err: unknown) => err,
            ),
            new Promise((r) => setTimeout(() => r('blocked'), 1500)),
          ]);
          // trava só por id: ficaria esperando a vítima soltar a linha (canal de tempo)
          expect(outcome).toEqual(new BadRequestException(ErrorMessages.TRANSACTION_INVALID_CARD));
          expect(await waitersOf(lock.pid)).toBe(0);
        } finally {
          await lock.release();
        }
      } finally {
        await db.getRepository(User).delete(victim.id);
      }
    });

    it('(d) recálculos, remoções, splits e pagamentos simultâneos: sem deadlock nem 500', async () => {
      const outcomes: unknown[] = [];
      for (let round = 0; round < 8; round++) {
        const card = await newCard();
        const a = await buy(card.id, 300, '2026-03-12', 3);
        const b = await buy(card.id, 200, '2026-03-13', 2);

        const results = await Promise.allSettled([
          transactions.update(a.id, user.id, { totalAmount: 330 }),
          transactions.remove(a.id, user.id),
          transactions.update(a.id, user.id, { date: '2026-03-14' }),
          splits.create(user.id, { transactionId: a.id, contactId, assignedAmount: 10 }),
          transactions.update(b.id, user.id, { totalAmount: 210 }),
          transactions.remove(b.id, user.id),
          cardInvoices.addPayment(card.id, user.id, '2026-04', { amount: 50 }),
          buy(card.id, 40, '2026-03-14'),
        ]);
        outcomes.push(
          ...results
            .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
            .map((r) => r.reason),
        );
      }

      // com a ordem cartão → transação em todos os caminhos não há deadlock (40P01 → 409)
      expect(outcomes.map((r) => (r as Error).message)).not.toContain(
        ErrorMessages.CONCURRENT_UPDATE,
      );
      // só erros de regra (404 de quem chegou depois da remoção — ou 400 genérico do split, cujo
      // transactionId vem do body (D30); 409 de split pendente; 422)
      for (const reason of outcomes) {
        expect(reason).toBeInstanceOf(HttpException);
        expect(
          reason instanceof NotFoundException ||
            (reason instanceof BadRequestException &&
              reason.message === ErrorMessages.SPLIT_INVALID_TRANSACTION) ||
            reason instanceof UnprocessableEntityException ||
            (reason instanceof ConflictException &&
              reason.message === ErrorMessages.TRANSACTION_HAS_PENDING_SPLITS),
        ).toBe(true);
      }
      // folga para um deadlock (deadlock_timeout = 1s) virar falha de asserção, não timeout
    }, 60_000);
  });
});
