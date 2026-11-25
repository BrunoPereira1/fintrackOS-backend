import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { CreditCard } from '../../cards/entities/credit-card.entity';

/**
 * Pagamento de fatura de cartão (spec 2026-11-24-modelo-de-pagamento §3, D2/D7/D18).
 * Sem `@OneToMany` inverso em `CreditCard`: evita ciclo de arquivo cards ↔ invoices.
 */
@Entity('invoice_payments')
@Index('IDX_invoice_payments_card_month', ['cardId', 'invoiceMonth'])
@Check('CHK_invoice_payments_amount_positive', 'amount > 0')
@Check('CHK_invoice_payments_month_format', `invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`)
export class InvoicePayment {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_invoice_payments_user_id')
  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_invoice_payments_user' })
  user!: User;

  @Column({ name: 'card_id', type: 'uuid' })
  cardId!: string;

  // CASCADE só dispara na exclusão do usuário: cartão é arquivado, nunca apagado (D12)
  @ManyToOne(() => CreditCard, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'card_id', foreignKeyConstraintName: 'FK_invoice_payments_card' })
  card!: CreditCard;

  /** Fatura (mês do vencimento) em que o pagamento foi lançado, `YYYY-MM`. */
  @Column({ name: 'invoice_month', type: 'char', length: 7 })
  invoiceMonth!: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount!: number;

  /** Data de calendário do pagamento (`YYYY-MM-DD`); `null` só em pagamento legado (D18). */
  @Column({ name: 'paid_on', type: 'date', nullable: true })
  paidOn!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
