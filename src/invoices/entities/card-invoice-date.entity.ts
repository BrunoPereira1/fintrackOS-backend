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
 * Datas gravadas por fatura (D31): fechamento e vencimento vigentes de uma fatura já fechada,
 * gravados ao mudar os dias do cartão (D14) para a fatura nunca "reabrir". Têm precedência sobre
 * as datas das parcelas e os dias atuais do cartão (D25). Imutável: mês já gravado não é
 * sobrescrito (`ON CONFLICT DO NOTHING`).
 * Sem `@OneToMany` inverso em `CreditCard`: evita ciclo de arquivo cards ↔ invoices.
 */
@Entity('card_invoice_dates')
@Index('UQ_card_invoice_dates_card_month', ['cardId', 'invoiceMonth'], { unique: true })
@Check('CHK_card_invoice_dates_month_format', `invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`)
@Check('CHK_card_invoice_dates_closing_before_due', 'closing_date < due_date')
export class CardInvoiceDate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_card_invoice_dates_user_id')
  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_card_invoice_dates_user' })
  user!: User;

  @Column({ name: 'card_id', type: 'uuid' })
  cardId!: string;

  // FK composta (card_id, user_id) → credit_cards(id, user_id): o banco garante que o cartão é do
  // mesmo usuário da gravação. CASCADE só dispara na exclusão do usuário: cartão é arquivado,
  // nunca apagado (D12). O TypeORM lê o nome da FK composta da 1ª coluna.
  @ManyToOne(() => CreditCard, { onDelete: 'CASCADE' })
  @JoinColumn([
    {
      name: 'card_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'FK_card_invoice_dates_card',
    },
    { name: 'user_id', referencedColumnName: 'userId' },
  ])
  card!: CreditCard;

  /** Fatura (mês do vencimento), `YYYY-MM`. */
  @Column({ name: 'invoice_month', type: 'char', length: 7 })
  invoiceMonth!: string;

  /** Data de calendário `YYYY-MM-DD` (coluna `date` chega do driver como string). */
  @Column({ name: 'closing_date', type: 'date' })
  closingDate!: string;

  @Column({ name: 'due_date', type: 'date' })
  dueDate!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
