import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { Transaction } from '../../transactions/entities/transaction.entity';

import { InstallmentStatus } from '../installment-status.enum';

export { InstallmentStatus };

@Entity('installments')
export class Installment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  number!: number;

  @Column({ name: 'total_installments' })
  totalInstallments!: number;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount!: number;

  @Column({ name: 'due_date', type: 'date' })
  dueDate!: Date;

  /** Fechamento da fatura da parcela (D14): gravado na compra e ajustado se os dias mudarem. */
  @Column({ name: 'closing_date', type: 'date' })
  closingDate!: Date;

  @Column({ type: 'enum', enum: InstallmentStatus, default: InstallmentStatus.PENDING })
  status!: InstallmentStatus;

  @Index('IDX_installments_transaction_id')
  @Column({ name: 'transaction_id' })
  transactionId!: string;

  @ManyToOne(() => Transaction, (tx) => tx.installments, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transaction_id', foreignKeyConstraintName: 'FK_installments_transaction' })
  transaction!: Transaction;
}
