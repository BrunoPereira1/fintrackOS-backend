import { randomUUID } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { DatabaseModule } from '../src/database/database.module';
import { ClockModule } from '../src/common/clock.module';
import { ErrorMessages } from '../src/common/constants/error-messages';
import { SplitsModule } from '../src/splits/splits.module';
import { SplitsService } from '../src/splits/splits.service';
import { SplitMapper } from '../src/splits/split.mapper';
import { ContactsService } from '../src/contacts/contacts.service';
import { Contact } from '../src/contacts/entities/contact.entity';
import { TransactionsService } from '../src/transactions/transactions.service';
import { TransactionType } from '../src/transactions/entities/transaction.entity';
import { User } from '../src/users/entities/user.entity';
import { Plan } from '../src/users/enums/plan.enum';

/**
 * Contatos e splits contra o Postgres real: índice único parcial do e-mail (sem caixa) e
 * FK diferida (NO ACTION, checada no COMMIT) de cost_splits → contacts convertida em 409.
 * Requer PostgreSQL com as migrations aplicadas (local: `make up && make migration-run`).
 */
describe('Contatos e splits (e2e, banco real)', () => {
  let moduleRef: TestingModule;
  let contacts: ContactsService;
  let splits: SplitsService;
  let transactions: TransactionsService;
  let db: DataSource;
  let user: User;
  let otherUser: User;

  const newUser = () =>
    db.getRepository(User).save({
      firebaseUid: `e2e-${randomUUID()}`,
      email: `e2e-${randomUUID()}@test.local`,
      plan: Plan.PREMIUM,
    });

  const newTx = (userId: string) =>
    transactions.create(userId, Plan.PREMIUM, {
      description: 'Jantar e2e',
      totalAmount: 300,
      date: '2026-03-10',
      type: TransactionType.VARIABLE,
    });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ClockModule,
        DatabaseModule,
        SplitsModule,
      ],
    }).compile();
    contacts = moduleRef.get(ContactsService);
    splits = moduleRef.get(SplitsService);
    transactions = moduleRef.get(TransactionsService);
    db = moduleRef.get(DataSource);

    user = await newUser();
    otherUser = await newUser();
  });

  afterAll(async () => {
    // Splits caem em cascata com as transações (via users); contatos depois deles
    for (const u of [user, otherUser]) {
      if (u) await db.getRepository(User).delete(u.id);
    }
    await moduleRef?.close();
  });

  it('contato com split não pode ser removido (409); sem splits, pode', async () => {
    const contact = await contacts.create(user.id, { name: 'Carlos', email: 'carlos@e2e.test' });
    const tx = await newTx(user.id);

    const split = await splits.create(user.id, {
      contactId: contact.id,
      assignedAmount: 100,
      transactionId: tx.id,
    });
    expect(SplitMapper.toDto(split).contact).toEqual({
      id: contact.id,
      name: 'Carlos',
      email: 'carlos@e2e.test',
    });

    // A leitura traz o contato do banco; editar o contato reflete no split
    await contacts.update(contact.id, user.id, { name: 'Carlos Mendes' });
    const loaded = await splits.findOne(split.id, user.id);
    expect(SplitMapper.toDto(loaded).contact.name).toBe('Carlos Mendes');

    await expect(contacts.remove(contact.id, user.id)).rejects.toThrow(ConflictException);
    expect(await db.getRepository(Contact).existsBy({ id: contact.id })).toBe(true);

    await splits.remove(split.id, user.id);
    await contacts.remove(contact.id, user.id);
    expect(await db.getRepository(Contact).existsBy({ id: contact.id })).toBe(false);
  });

  it('e-mail duplicado com outra caixa → 409; outro usuário pode usar o mesmo e-mail', async () => {
    const first = await contacts.create(user.id, { name: 'Ana', email: 'Ana@E2E.test' });
    expect(first.email).toBe('ana@e2e.test');

    await expect(
      contacts.create(user.id, { name: 'Ana 2', email: '  ANA@e2e.TEST ' }),
    ).rejects.toThrow(ConflictException);

    const other = await contacts.create(otherUser.id, { name: 'Ana', email: 'ana@e2e.test' });
    expect(other.id).not.toBe(first.id);
  });

  it('índice único parcial: vários contatos sem e-mail no mesmo usuário', async () => {
    await contacts.create(user.id, { name: 'Sem e-mail 1' });
    await expect(contacts.create(user.id, { name: 'Sem e-mail 2' })).resolves.toBeDefined();
  });

  it('o índice único barra o duplicado no banco mesmo sem a checagem prévia (corrida)', async () => {
    await contacts.create(user.id, { name: 'Bia', email: 'bia@e2e.test' });
    // Pula a checagem prévia simulando a corrida: insert direto com o mesmo e-mail
    const repo = db.getRepository(Contact);
    await expect(
      repo.save(repo.create({ name: 'Bia 2', email: 'bia@e2e.test', userId: user.id })),
    ).rejects.toMatchObject({ driverError: { constraint: 'UQ_contacts_user_email' } });
  });

  it('split com contato de outro usuário → 400, nada gravado', async () => {
    const foreign = await contacts.create(otherUser.id, { name: 'Alheio' });
    const tx = await newTx(user.id);

    await expect(
      splits.create(user.id, { contactId: foreign.id, assignedAmount: 10, transactionId: tx.id }),
    ).rejects.toThrow(BadRequestException);
    expect(await splits.findAllByTransaction(tx.id, user.id)).toEqual([]);
  });

  it('D30: split em transação de outro usuário ou inexistente → 400 genérico, nada gravado', async () => {
    const contact = await contacts.create(user.id, { name: 'Meu contato' });
    const foreignTx = await newTx(otherUser.id);
    const invalidTx = new BadRequestException(ErrorMessages.SPLIT_INVALID_TRANSACTION);

    await expect(
      splits.create(user.id, {
        contactId: contact.id,
        assignedAmount: 10,
        transactionId: foreignTx.id,
      }),
    ).rejects.toThrow(invalidTx);
    await expect(
      splits.create(user.id, {
        contactId: contact.id,
        assignedAmount: 10,
        transactionId: randomUUID(),
      }),
    ).rejects.toThrow(invalidTx);
    expect(await splits.findAllByTransaction(foreignTx.id, otherUser.id)).toEqual([]);
  });

  it('?transactionId= alheio ou inexistente → lista vazia (filtro não revela existência)', async () => {
    const contact = await contacts.create(otherUser.id, { name: 'Dono' });
    const foreignTx = await newTx(otherUser.id);
    await splits.create(otherUser.id, {
      contactId: contact.id,
      assignedAmount: 10,
      transactionId: foreignTx.id,
    });

    expect(await splits.findAllByTransaction(foreignTx.id, user.id)).toEqual([]);
    expect(await splits.findAllByTransaction(randomUUID(), user.id)).toEqual([]);
  });

  it('excluir o usuário apaga contatos e splits em cascata (LGPD), mesmo com FK diferida', async () => {
    const u = await newUser();
    const contact = await contacts.create(u.id, { name: 'Cascata' });
    const tx = await newTx(u.id);
    await splits.create(u.id, { contactId: contact.id, assignedAmount: 10, transactionId: tx.id });

    await db.getRepository(User).delete(u.id);

    expect(await db.getRepository(Contact).existsBy({ id: contact.id })).toBe(false);
    const [{ n }] = await db.query(
      'SELECT count(*)::int AS n FROM cost_splits WHERE contact_id = $1',
      [contact.id],
    );
    expect(n).toBe(0);
  });

  it('listagem busca por nome/e-mail sem caixa e ordena por nome', async () => {
    const u = await newUser();
    try {
      await contacts.create(u.id, { name: 'Zeca', email: 'zeca@busca.test' });
      await contacts.create(u.id, { name: 'amanda', email: 'amanda@busca.test' });
      await contacts.create(u.id, { name: 'Bruno 100%' });

      const all = await contacts.findAll(u.id, { page: 1, limit: 20 });
      expect(all.total).toBe(3);

      const byEmail = await contacts.findAll(u.id, { page: 1, limit: 20, search: 'BUSCA.test' });
      expect(byEmail.data.map((c) => c.name).sort()).toEqual(['Zeca', 'amanda']);

      const literal = await contacts.findAll(u.id, { page: 1, limit: 20, search: '0%' });
      expect(literal.data.map((c) => c.name)).toEqual(['Bruno 100%']);

      const page2 = await contacts.findAll(u.id, { page: 2, limit: 2 });
      expect(page2).toMatchObject({ total: 3, page: 2, limit: 2 });
      expect(page2.data).toHaveLength(1);
    } finally {
      await db.getRepository(User).delete(u.id);
    }
  });

  it('busca com % e _ é literal: não casa com todos os contatos', async () => {
    const u = await newUser();
    try {
      await contacts.create(u.id, { name: 'Ana', email: 'ana@curinga.test' });
      await contacts.create(u.id, { name: 'Beto' });
      await contacts.create(u.id, { name: 'Taxa 10%' });
      await contacts.create(u.id, { name: 'joao_silva' });

      const percent = await contacts.findAll(u.id, { page: 1, limit: 20, search: '%' });
      expect(percent.data.map((c) => c.name)).toEqual(['Taxa 10%']);

      const underscore = await contacts.findAll(u.id, { page: 1, limit: 20, search: '_' });
      expect(underscore.data.map((c) => c.name)).toEqual(['joao_silva']);
    } finally {
      await db.getRepository(User).delete(u.id);
    }
  });
});
