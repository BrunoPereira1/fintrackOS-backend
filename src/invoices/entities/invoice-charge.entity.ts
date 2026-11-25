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
 * Encargo (juros/IOF/multa/mora) informado pelo usuário numa fatura (spec
 * 2026-11-24-modelo-de-pagamento §3, D3). `description` é dado do usuário: nunca em log.
 * Sem `@OneToMany` inverso em `CreditCard`: evita ciclo de arquivo cards ↔ invoices.
 */
@Entity('invoice_charges')
@Index('IDX_invoice_charges_card_month', ['cardId', 'invoiceMonth'])
@Check('CHK_invoice_charges_amount_positive', 'amount > 0')
@Check('CHK_invoice_charges_month_format', `invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`)
export class InvoiceCharge {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_invoice_charges_user_id')
  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_invoice_charges_user' })
  user!: User;

  @Column({ name: 'card_id', type: 'uuid' })
  cardId!: string;

  // CASCADE só dispara na exclusão do usuário: cartão é arquivado, nunca apagado (D12)
  @ManyToOne(() => CreditCard, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'card_id', foreignKeyConstraintName: 'FK_invoice_charges_card' })
  card!: CreditCard;

  /** Fatura (mês do vencimento) em que o encargo foi lançado, `YYYY-MM`. */
  @Column({ name: 'invoice_month', type: 'char', length: 7 })
  invoiceMonth!: string;

  @Column({ type: 'decimal', precision: 12, scale: 2 })
  amount!: number;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
