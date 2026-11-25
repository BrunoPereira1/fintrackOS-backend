import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  OneToMany,
  JoinColumn,
  Index,
} from 'typeorm';
import { Transaction } from './transaction.entity';
import { CostSplit } from '../../splits/entities/cost-split.entity';

@Entity('transaction_items')
export class TransactionItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @Column({ name: 'unit_price', type: 'decimal', precision: 12, scale: 2 })
  unitPrice!: number;

  @Index('IDX_transaction_items_transaction_id')
  @Column({ name: 'transaction_id' })
  transactionId!: string;

  @ManyToOne(() => Transaction, (tx) => tx.items, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'transaction_id',
    foreignKeyConstraintName: 'FK_transaction_items_transaction',
  })
  transaction!: Transaction;

  @OneToMany(() => CostSplit, (split) => split.item, { cascade: true })
  splits!: CostSplit[];
}
