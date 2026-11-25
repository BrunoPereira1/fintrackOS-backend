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

export enum AssetType {
  STOCKS = 'stocks',
  FII = 'fii',
  CRYPTO = 'crypto',
  FIXED_INCOME = 'fixed_income',
  OTHERS = 'others',
}

export enum AssetStatus {
  ACTIVE = 'active',
  SOLD = 'sold',
}

@Entity('assets')
export class Asset {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  name!: string;

  @Column({ type: 'enum', enum: AssetType })
  type!: AssetType;

  @Column({ type: 'enum', enum: AssetStatus, default: AssetStatus.ACTIVE })
  status!: AssetStatus;

  @Column({ name: 'average_price', type: 'decimal', precision: 14, scale: 6 })
  averagePrice!: number;

  @Column({ name: 'current_quantity', type: 'decimal', precision: 14, scale: 6 })
  currentQuantity!: number;

  @Column({ name: 'acquisition_date', type: 'date' })
  acquisitionDate!: Date;

  @Index('IDX_assets_user_id')
  @Column({ name: 'user_id' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id', foreignKeyConstraintName: 'FK_assets_user' })
  user!: User;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
