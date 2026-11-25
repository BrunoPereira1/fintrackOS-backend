import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum CardBrand {
  AMEX = 'amex',
  VISA = 'visa',
  MASTER = 'master',
  ELO = 'elo',
  HIPERCARD = 'hipercard',
}

@Entity('credit_cards')
export class CreditCard {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ type: 'enum', enum: CardBrand })
  brand!: CardBrand;

  @Column({ name: 'closing_day' })
  closingDay!: number;

  @Column({ name: 'due_day' })
  dueDay!: number;

  @Column({ name: 'credit_limit', type: 'decimal', precision: 12, scale: 2 })
  creditLimit!: number;

  @Index('IDX_credit_cards_user_id')
  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_credit_cards_user' })
  user!: User;

  /** Cartão arquivado (D12): sai das listas e não aceita compra nova; o histórico continua. */
  @Column({ name: 'archived_at', type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
