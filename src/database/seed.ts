import 'reflect-metadata';
import * as dotenv from 'dotenv';
dotenv.config();

import { AppDataSource } from './data-source';
import { User, PreferredLanguage } from '../users/entities/user.entity';
import { Plan } from '../users/enums/plan.enum';
import { CreditCard, CardBrand } from '../cards/entities/credit-card.entity';
import {
  PaymentMethod,
  Transaction,
  TransactionType,
} from '../transactions/entities/transaction.entity';
import { TransactionItem } from '../transactions/entities/transaction-item.entity';
import { Installment, InstallmentStatus } from '../installments/entities/installment.entity';
import { invoiceDates } from '../common/invoice-dates';
import { CostSplit, SplitStatus } from '../splits/entities/cost-split.entity';
import { Contact } from '../contacts/entities/contact.entity';
import { Asset, AssetType, AssetStatus } from '../assets/entities/asset.entity';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function calcInstallments(
  totalAmount: number,
  count: number,
  purchaseDate: Date,
  card: CreditCard,
): Omit<Installment, 'id' | 'transactionId' | 'transaction'>[] {
  const purchaseDay = purchaseDate.getDate();
  let month = purchaseDate.getMonth();
  let year = purchaseDate.getFullYear();

  if (purchaseDay > card.closingDay) {
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }

  const firstDueDate = new Date(year, month, card.dueDay);
  const baseAmount = Math.floor((totalAmount / count) * 100) / 100;
  const lastAmount = Math.round((totalAmount - baseAmount * (count - 1)) * 100) / 100;

  return Array.from({ length: count }, (_, i) => {
    const dueDate = new Date(firstDueDate);
    dueDate.setMonth(dueDate.getMonth() + i);
    const month = `${dueDate.getFullYear()}-${String(dueDate.getMonth() + 1).padStart(2, '0')}`;
    const [cy, cm, cd] = invoiceDates(month, card).closingDate.split('-').map(Number);
    return {
      number: i + 1,
      totalInstallments: count,
      amount: i === count - 1 ? lastAmount : baseAmount,
      dueDate,
      closingDate: new Date(cy, cm - 1, cd),
      status: i < 2 ? InstallmentStatus.PAID : InstallmentStatus.PENDING,
    };
  });
}

// ─── Seed ────────────────────────────────────────────────────────────────────

async function seed() {
  await AppDataSource.initialize();
  console.log('✔ Database connected');

  // ── Limpar em ordem reversa (respeita FKs) ──────────────────────────────
  await AppDataSource.query('DELETE FROM invoice_payments');
  await AppDataSource.query('DELETE FROM invoice_charges');
  await AppDataSource.query('DELETE FROM cost_splits');
  await AppDataSource.query('DELETE FROM contacts');
  await AppDataSource.query('DELETE FROM installments');
  await AppDataSource.query('DELETE FROM transaction_items');
  await AppDataSource.query('DELETE FROM transactions');
  await AppDataSource.query('DELETE FROM assets');
  await AppDataSource.query('DELETE FROM credit_cards');
  await AppDataSource.query('DELETE FROM users');
  console.log('✔ Tables cleared');

  const userRepo = AppDataSource.getRepository(User);
  const cardRepo = AppDataSource.getRepository(CreditCard);
  const transactionRepo = AppDataSource.getRepository(Transaction);
  const itemRepo = AppDataSource.getRepository(TransactionItem);
  const installmentRepo = AppDataSource.getRepository(Installment);
  const splitRepo = AppDataSource.getRepository(CostSplit);
  const contactRepo = AppDataSource.getRepository(Contact);
  const assetRepo = AppDataSource.getRepository(Asset);

  // ── Usuário fixo ────────────────────────────────────────────────────────
  const user = await userRepo.save(
    userRepo.create({
      firebaseUid: 'test-firebase-uid-dev',
      email: 'dev@fintrack.test',
      displayName: 'Dev User',
      plan: Plan.PREMIUM,
      preferredLanguage: PreferredLanguage.PT_BR,
    }),
  );
  console.log(`✔ User created: ${user.email} (${user.id})`);

  // ── Cartões ─────────────────────────────────────────────────────────────
  const nubank = await cardRepo.save(
    cardRepo.create({
      name: 'Nubank Platinum',
      brand: CardBrand.VISA,
      closingDay: 3,
      dueDay: 10,
      creditLimit: 5000,
      userId: user.id,
    }),
  );

  const inter = await cardRepo.save(
    cardRepo.create({
      name: 'Inter Gold',
      brand: CardBrand.MASTER,
      closingDay: 15,
      dueDay: 22,
      creditLimit: 8000,
      userId: user.id,
    }),
  );
  console.log('✔ Cards created: Nubank Platinum, Inter Gold');

  // ── Transação 1: Supermercado (variável, sem cartão, com itens) ─────────
  const supermarket = await transactionRepo.save(
    transactionRepo.create({
      description: 'Supermercado Extra',
      totalAmount: 187.5,
      date: new Date('2026-03-15'),
      type: TransactionType.VARIABLE,
      category: 'Alimentação',
      userId: user.id,
      cardId: null,
      paymentMethod: PaymentMethod.DEBIT,
    }),
  );

  const smItems = await itemRepo.save([
    itemRepo.create({
      name: 'Arroz 5kg',
      quantity: 2,
      unitPrice: 22.9,
      transactionId: supermarket.id,
    }),
    itemRepo.create({
      name: 'Feijão 1kg',
      quantity: 3,
      unitPrice: 8.9,
      transactionId: supermarket.id,
    }),
    itemRepo.create({
      name: 'Frango',
      quantity: 1,
      unitPrice: 45.9,
      transactionId: supermarket.id,
    }),
    itemRepo.create({
      name: 'Leite integral',
      quantity: 4,
      unitPrice: 7.5,
      transactionId: supermarket.id,
    }),
    itemRepo.create({
      name: 'Outros',
      quantity: 1,
      unitPrice: 38.6,
      transactionId: supermarket.id,
    }),
  ]);
  console.log(`✔ Transaction 1 created: Supermercado Extra (${smItems.length} items)`);

  // ── Transação 2: Aluguel (fixo, sem cartão) ──────────────────────────────
  await transactionRepo.save(
    transactionRepo.create({
      description: 'Aluguel Apartamento',
      totalAmount: 1850.0,
      date: new Date('2026-04-01'),
      type: TransactionType.FIXED,
      category: 'Moradia',
      userId: user.id,
      cardId: null,
      paymentMethod: PaymentMethod.BOLETO,
    }),
  );
  console.log('✔ Transaction 2 created: Aluguel Apartamento');

  // ── Transação 3: Notebook (variável, Nubank, 6x) ─────────────────────────
  const notebookDate = new Date('2026-03-20');
  const notebook = await transactionRepo.save(
    transactionRepo.create({
      description: 'Notebook Dell Inspiron',
      totalAmount: 4200.0,
      date: notebookDate,
      type: TransactionType.VARIABLE,
      category: 'Tecnologia',
      userId: user.id,
      cardId: nubank.id,
      paymentMethod: PaymentMethod.CREDIT_CARD,
    }),
  );

  const notebookInstallments = calcInstallments(4200, 6, notebookDate, nubank);
  await installmentRepo.save(
    notebookInstallments.map((inst) =>
      installmentRepo.create({ ...inst, transactionId: notebook.id }),
    ),
  );
  console.log('✔ Transaction 3 created: Notebook Dell Inspiron (6x Nubank)');

  // ── Transação 4: Academia (fixo, Inter, 12x) ─────────────────────────────
  const gymDate = new Date('2026-01-05');
  const gym = await transactionRepo.save(
    transactionRepo.create({
      description: 'Anuidade Academia SmartFit',
      totalAmount: 960.0,
      date: gymDate,
      type: TransactionType.FIXED,
      category: 'Saúde',
      userId: user.id,
      cardId: inter.id,
      paymentMethod: PaymentMethod.CREDIT_CARD,
    }),
  );

  const gymInstallments = calcInstallments(960, 12, gymDate, inter);
  await installmentRepo.save(
    gymInstallments.map((inst) => installmentRepo.create({ ...inst, transactionId: gym.id })),
  );
  console.log('✔ Transaction 4 created: Anuidade Academia SmartFit (12x Inter)');

  // ── Transação 5: Jantar (variável, Nubank, com splits) ───────────────────
  const dinner = await transactionRepo.save(
    transactionRepo.create({
      description: 'Jantar Restaurante Fogo de Chão',
      totalAmount: 480.0,
      date: new Date('2026-03-28'),
      type: TransactionType.VARIABLE,
      category: 'Alimentação',
      userId: user.id,
      cardId: nubank.id,
      paymentMethod: PaymentMethod.CREDIT_CARD,
    }),
  );

  const [carlos, ana, rafael] = await contactRepo.save([
    contactRepo.create({ name: 'Carlos Mendes', email: 'carlos@example.com', userId: user.id }),
    contactRepo.create({ name: 'Ana Souza', email: 'ana@example.com', userId: user.id }),
    contactRepo.create({ name: 'Rafael Lima', email: null, userId: user.id }),
  ]);
  console.log('✔ Contacts created: Carlos Mendes, Ana Souza, Rafael Lima');

  await splitRepo.save([
    splitRepo.create({
      contactId: carlos.id,
      assignedAmount: 120.0,
      status: SplitStatus.PAID,
      paidAt: new Date('2026-03-29'),
      transactionId: dinner.id,
      itemId: null,
    }),
    splitRepo.create({
      contactId: ana.id,
      assignedAmount: 120.0,
      status: SplitStatus.PENDING,
      paidAt: null,
      transactionId: dinner.id,
      itemId: null,
    }),
    splitRepo.create({
      contactId: rafael.id,
      assignedAmount: 120.0,
      status: SplitStatus.PENDING,
      paidAt: null,
      transactionId: dinner.id,
      itemId: null,
    }),
  ]);
  console.log('✔ Transaction 5 created: Jantar Fogo de Chão (3 splits)');

  // ── Assets ───────────────────────────────────────────────────────────────
  await assetRepo.save([
    assetRepo.create({
      name: 'PETR4',
      type: AssetType.STOCKS,
      status: AssetStatus.ACTIVE,
      averagePrice: 38.42,
      currentQuantity: 200,
      acquisitionDate: new Date('2025-06-10'),
      userId: user.id,
    }),
    assetRepo.create({
      name: 'MXRF11',
      type: AssetType.FII,
      status: AssetStatus.ACTIVE,
      averagePrice: 10.15,
      currentQuantity: 500,
      acquisitionDate: new Date('2025-09-03'),
      userId: user.id,
    }),
    assetRepo.create({
      name: 'Bitcoin',
      type: AssetType.CRYPTO,
      status: AssetStatus.ACTIVE,
      averagePrice: 312500.0,
      currentQuantity: 0.08,
      acquisitionDate: new Date('2025-11-20'),
      userId: user.id,
    }),
    assetRepo.create({
      name: 'Tesouro IPCA+ 2029',
      type: AssetType.FIXED_INCOME,
      status: AssetStatus.ACTIVE,
      averagePrice: 1000.0,
      currentQuantity: 5,
      acquisitionDate: new Date('2026-01-15'),
      userId: user.id,
    }),
    assetRepo.create({
      name: 'VALE3',
      type: AssetType.STOCKS,
      status: AssetStatus.SOLD,
      averagePrice: 61.8,
      currentQuantity: 0,
      acquisitionDate: new Date('2024-03-01'),
      userId: user.id,
    }),
  ]);
  console.log('✔ Assets created: PETR4, MXRF11, Bitcoin, Tesouro IPCA+, VALE3 (sold)');

  await AppDataSource.destroy();
  console.log('\n✅ Seed completed successfully');
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
