import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateInitialSchema1775001600000 implements MigrationInterface {
  name = 'CreateInitialSchema1775001600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Extensões ────────────────────────────────────────────────────────────
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);

    // ── Enums ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TYPE "users_plan_enum" AS ENUM ('basic', 'intermediate', 'premium')
    `);
    await queryRunner.query(`
      CREATE TYPE "users_preferred_language_enum" AS ENUM ('pt-BR', 'en', 'es')
    `);
    await queryRunner.query(`
      CREATE TYPE "credit_cards_brand_enum" AS ENUM ('amex', 'visa', 'master', 'elo', 'hipercard')
    `);
    await queryRunner.query(`
      CREATE TYPE "transactions_type_enum" AS ENUM ('fixed', 'variable')
    `);
    await queryRunner.query(`
      CREATE TYPE "installments_status_enum" AS ENUM ('pending', 'paid', 'overdue')
    `);
    await queryRunner.query(`
      CREATE TYPE "cost_splits_status_enum" AS ENUM ('pending', 'paid')
    `);
    await queryRunner.query(`
      CREATE TYPE "assets_type_enum" AS ENUM ('stocks', 'fii', 'crypto', 'fixed_income', 'others')
    `);
    await queryRunner.query(`
      CREATE TYPE "assets_status_enum" AS ENUM ('active', 'sold')
    `);

    // ── users ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id"                 UUID                           NOT NULL DEFAULT uuid_generate_v4(),
        "firebase_uid"       CHARACTER VARYING              NOT NULL,
        "email"              CHARACTER VARYING              NOT NULL,
        "display_name"       CHARACTER VARYING,
        "plan"               "users_plan_enum"              NOT NULL DEFAULT 'basic',
        "preferred_language" "users_preferred_language_enum" NOT NULL DEFAULT 'pt-BR',
        "created_at"         TIMESTAMP WITH TIME ZONE       NOT NULL DEFAULT now(),
        "updated_at"         TIMESTAMP WITH TIME ZONE       NOT NULL DEFAULT now(),
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_users_firebase_uid" ON "users" ("firebase_uid")
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_users_email" ON "users" ("email")
    `);

    // ── credit_cards ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "credit_cards" (
        "id"           UUID                        NOT NULL DEFAULT uuid_generate_v4(),
        "name"         CHARACTER VARYING           NOT NULL,
        "brand"        "credit_cards_brand_enum"   NOT NULL,
        "closing_day"  INTEGER                     NOT NULL,
        "due_day"      INTEGER                     NOT NULL,
        "credit_limit" NUMERIC(12, 2)              NOT NULL,
        "user_id"      UUID                        NOT NULL,
        "created_at"   TIMESTAMP WITH TIME ZONE    NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMP WITH TIME ZONE    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_credit_cards" PRIMARY KEY ("id"),
        CONSTRAINT "FK_credit_cards_user"
          FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_credit_cards_user_id" ON "credit_cards" ("user_id")
    `);

    // ── transactions ─────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "transactions" (
        "id"           UUID                        NOT NULL DEFAULT uuid_generate_v4(),
        "description"  CHARACTER VARYING           NOT NULL,
        "total_amount" NUMERIC(12, 2)              NOT NULL,
        "date"         DATE                        NOT NULL,
        "type"         "transactions_type_enum"    NOT NULL,
        "category"     CHARACTER VARYING,
        "user_id"      UUID                        NOT NULL,
        "card_id"      UUID,
        "created_at"   TIMESTAMP WITH TIME ZONE    NOT NULL DEFAULT now(),
        "updated_at"   TIMESTAMP WITH TIME ZONE    NOT NULL DEFAULT now(),
        CONSTRAINT "PK_transactions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_transactions_user"
          FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_transactions_card"
          FOREIGN KEY ("card_id") REFERENCES "credit_cards" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_user_id" ON "transactions" ("user_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_transactions_card_id" ON "transactions" ("card_id")
    `);

    // ── transaction_items ─────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "transaction_items" (
        "id"             UUID           NOT NULL DEFAULT uuid_generate_v4(),
        "name"           CHARACTER VARYING NOT NULL,
        "quantity"       INTEGER        NOT NULL DEFAULT 1,
        "unit_price"     NUMERIC(12, 2) NOT NULL,
        "transaction_id" UUID           NOT NULL,
        CONSTRAINT "PK_transaction_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_transaction_items_transaction"
          FOREIGN KEY ("transaction_id") REFERENCES "transactions" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_transaction_items_transaction_id" ON "transaction_items" ("transaction_id")
    `);

    // ── installments ──────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "installments" (
        "id"                 UUID                        NOT NULL DEFAULT uuid_generate_v4(),
        "number"             INTEGER                     NOT NULL,
        "total_installments" INTEGER                     NOT NULL,
        "amount"             NUMERIC(12, 2)              NOT NULL,
        "due_date"           DATE                        NOT NULL,
        "status"             "installments_status_enum"  NOT NULL DEFAULT 'pending',
        "transaction_id"     UUID                        NOT NULL,
        CONSTRAINT "PK_installments" PRIMARY KEY ("id"),
        CONSTRAINT "FK_installments_transaction"
          FOREIGN KEY ("transaction_id") REFERENCES "transactions" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_installments_transaction_id" ON "installments" ("transaction_id")
    `);

    // ── cost_splits ───────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "cost_splits" (
        "id"              UUID                       NOT NULL DEFAULT uuid_generate_v4(),
        "person_name"     CHARACTER VARYING          NOT NULL,
        "person_email"    CHARACTER VARYING,
        "assigned_amount" NUMERIC(12, 2)             NOT NULL,
        "status"          "cost_splits_status_enum"  NOT NULL DEFAULT 'pending',
        "paid_at"         TIMESTAMP WITH TIME ZONE,
        "transaction_id"  UUID                       NOT NULL,
        "item_id"         UUID,
        CONSTRAINT "PK_cost_splits" PRIMARY KEY ("id"),
        CONSTRAINT "FK_cost_splits_transaction"
          FOREIGN KEY ("transaction_id") REFERENCES "transactions" ("id") ON DELETE CASCADE,
        CONSTRAINT "FK_cost_splits_item"
          FOREIGN KEY ("item_id") REFERENCES "transaction_items" ("id") ON DELETE SET NULL
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_cost_splits_transaction_id" ON "cost_splits" ("transaction_id")
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_cost_splits_item_id" ON "cost_splits" ("item_id")
    `);

    // ── assets ────────────────────────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE "assets" (
        "id"               UUID                  NOT NULL DEFAULT uuid_generate_v4(),
        "name"             CHARACTER VARYING      NOT NULL,
        "type"             "assets_type_enum"     NOT NULL,
        "status"           "assets_status_enum"   NOT NULL DEFAULT 'active',
        "average_price"    NUMERIC(14, 6)         NOT NULL,
        "current_quantity" NUMERIC(14, 6)         NOT NULL,
        "acquisition_date" DATE                   NOT NULL,
        "user_id"          UUID                   NOT NULL,
        "created_at"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at"       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_assets" PRIMARY KEY ("id"),
        CONSTRAINT "FK_assets_user"
          FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_assets_user_id" ON "assets" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Tabelas em ordem inversa de dependência
    await queryRunner.query(`DROP TABLE IF EXISTS "assets"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "cost_splits"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "installments"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "transaction_items"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "transactions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "credit_cards"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "users"`);

    // Enums
    await queryRunner.query(`DROP TYPE IF EXISTS "assets_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "assets_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "cost_splits_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "installments_status_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "transactions_type_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "credit_cards_brand_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_preferred_language_enum"`);
    await queryRunner.query(`DROP TYPE IF EXISTS "users_plan_enum"`);
  }
}
