import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Transaction } from '../../transactions/entities/transaction.entity';
import { TransactionItem } from '../../transactions/entities/transaction-item.entity';
import { Contact } from '../../contacts/entities/contact.entity';
import { SplitStatus } from '../split-status.enum';

export { SplitStatus };

@Entity('cost_splits')
export class CostSplit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * Quem deve a parte. Contato com splits não pode ser removido: FK `NO ACTION` **diferida**
   * (checada no COMMIT). Não é `RESTRICT` porque, ao apagar o usuário, as cascatas
   * users→contacts e users→transactions→cost_splits rodam em ordem de trigger; com checagem
   * imediata a exclusão do usuário falharia quando contacts fosse apagado antes dos splits.
   */
  @Index('IDX_cost_splits_contact_id')
  @Column({ name: 'contact_id', type: 'uuid' })
  contactId!: string;

  @ManyToOne(() => Contact, { onDelete: 'NO ACTION', deferrable: 'INITIALLY DEFERRED' })
  @JoinColumn({ name: 'contact_id', foreignKeyConstraintName: 'FK_cost_splits_contact' })
  contact!: Contact;

  @Column({ name: 'assigned_amount', type: 'decimal', precision: 12, scale: 2 })
  assignedAmount!: number;

  @Column({ type: 'enum', enum: SplitStatus, default: SplitStatus.PENDING })
  status!: SplitStatus;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Index('IDX_cost_splits_transaction_id')
  @Column({ name: 'transaction_id' })
  transactionId!: string;

  @ManyToOne(() => Transaction, (tx) => tx.splits, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transaction_id', foreignKeyConstraintName: 'FK_cost_splits_transaction' })
  transaction!: Transaction;

  @Index('IDX_cost_splits_item_id')
  @Column({ name: 'item_id', type: 'uuid', nullable: true })
  itemId!: string | null;

  @ManyToOne(() => TransactionItem, (item) => item.splits, {
    nullable: true,
    onDelete: 'SET NULL',
  })
  @JoinColumn({ name: 'item_id', foreignKeyConstraintName: 'FK_cost_splits_item' })
  item!: TransactionItem | null;
}
