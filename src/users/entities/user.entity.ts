import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { Plan } from '../enums/plan.enum';
import { DocumentType } from '../enums/document-type.enum';

export enum PreferredLanguage {
  PT_BR = 'pt-BR',
  EN = 'en',
  ES = 'es',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_users_firebase_uid', { unique: true })
  @Column({ name: 'firebase_uid' })
  firebaseUid!: string;

  @Index('UQ_users_email', { unique: true })
  @Column()
  email!: string;

  @Column({ name: 'display_name', nullable: true })
  displayName!: string;

  @Column({ type: 'enum', enum: Plan, default: Plan.BASIC })
  plan!: Plan;

  @Column({
    type: 'enum',
    enum: PreferredLanguage,
    default: PreferredLanguage.PT_BR,
    name: 'preferred_language',
  })
  preferredLanguage!: PreferredLanguage;

  /**
   * Provider usado no primeiro login: 'password', 'google.com', 'apple.com', etc.
   * Valor vem de DecodedIdToken.firebase.sign_in_provider.
   */
  @Column({ name: 'auth_provider', default: 'password' })
  authProvider!: string;

  @Column({ name: 'document_type', type: 'enum', enum: DocumentType, nullable: true })
  documentType!: DocumentType | null;

  /** Armazenado normalizado: somente dígitos (CPF/CNPJ) ou maiúsculas (Passport). */
  @Index('UQ_users_document', { unique: true, where: '"document" IS NOT NULL' })
  @Column({ name: 'document', type: 'varchar', nullable: true })
  document!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
