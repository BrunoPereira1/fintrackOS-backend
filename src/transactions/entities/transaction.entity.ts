import {
  Check,
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { CreditCard } from '../../cards/entities/credit-card.entity';
import { TransactionItem } from './transaction-item.entity';
import { Installment } from '../../installments/entities/installment.entity';
import { CostSplit } from '../../splits/entities/cost-split.entity';
import { PaymentMethod } from '../payment-method.enum';

export enum TransactionType {
  FIXED = 'fixed',
  VARIABLE = 'variable',
}

export { PaymentMethod };

@Entity('transactions')
// Transação com cartão só pode ser credit_card (o inverso — credit_card sem cartão — é permitido
// no banco para transações de cartão removido, que mantêm as parcelas)
@Check('CHK_transactions_payment_method_card', `card_id IS NULL OR payment_method = 'credit_card'`)
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  description!: string;

  @Column({ name: 'total_amount', type: 'decimal', precision: 12, scale: 2 })
  totalAmount!: number;

  @Column({ type: 'date' })
  date!: Date;

  @Column({ type: 'enum', enum: TransactionType })
  type!: TransactionType;

  @Column({ nullable: true })
  category!: string;

  /**
   * `null` só em transações legadas (anteriores à forma de pagamento) sem cartão. Tipo no banco:
   * `transactions_payment_method_enum` — nome padrão do TypeORM; declarar `enumName` igual ao
   * padrão faz o `migration:check` acusar drift.
   */
  @Column({ name: 'payment_method', type: 'enum', enum: PaymentMethod, nullable: true })
  paymentMethod!: PaymentMethod | null;

  @Index('IDX_transactions_user_id')
  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_transactions_user' })
  user!: User;

  @Index('IDX_transactions_card_id')
  @Column({ name: 'card_id', type: 'uuid', nullable: true })
  cardId!: string | null;

  @ManyToOne(() => CreditCard, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'card_id', foreignKeyConstraintName: 'FK_transactions_card' })
  card!: CreditCard | null;

  @OneToMany(() => TransactionItem, (item) => item.transaction, { cascade: true })
  items!: TransactionItem[];

  @OneToMany(() => Installment, (installment) => installment.transaction, { cascade: true })
  installments!: Installment[];

  @OneToMany(() => CostSplit, (split) => split.transaction, { cascade: true })
  splits!: CostSplit[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
