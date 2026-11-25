import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Expansão do modelo de pagamento (spec 2026-11-24-modelo-de-pagamento §3, fase 4a):
 * - `credit_cards.archived_at` (D12: cartão é arquivado, nunca apagado);
 * - `installments.closing_date` (D14), backfill antes do NOT NULL:
 *   - parcela de cartão: **última ocorrência do `closing_day` atual do cartão estritamente antes
 *     de `due_date`** (C5: nunca `closing_date >= due_date`, mesmo que os dias do cartão tenham
 *     mudado depois da compra). `closing_day` é 1–28, então a data existe em todo mês;
 *   - parcela órfã (transação sem cartão): `due_date − 1 mês`;
 * - tabelas `invoice_payments` e `invoice_charges`;
 * - backfill de pagamentos legados (D18): parcelas `paid` de cartão existente viram **um
 *   pagamento por (cartão, mês da fatura)** com `paid_on NULL`. `overdue` gravado conta como
 *   não pago. O status gravado (`installments.status`) fica intacto — continua valendo para as
 *   órfãs e para os consumidores até a fase 4b.
 *
 * `down()` remove só o que foi criado aqui; não recupera pagamentos/encargos lançados depois da
 * migration (perda documentada).
 */
export class AddInvoicesLedger1795567795244 implements MigrationInterface {
  name = 'AddInvoicesLedger1795567795244';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "invoice_payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "card_id" uuid NOT NULL, "invoice_month" character(7) NOT NULL, "amount" numeric(12,2) NOT NULL, "paid_on" date, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_invoice_payments_month_format" CHECK (invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), CONSTRAINT "CHK_invoice_payments_amount_positive" CHECK (amount > 0), CONSTRAINT "PK_e19c9ebfa432289f510de7b4e99" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invoice_payments_user_id" ON "invoice_payments" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invoice_payments_card_month" ON "invoice_payments" ("card_id", "invoice_month") `,
    );
    await queryRunner.query(
      `CREATE TABLE "invoice_charges" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "card_id" uuid NOT NULL, "invoice_month" character(7) NOT NULL, "amount" numeric(12,2) NOT NULL, "description" character varying(255), "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_invoice_charges_month_format" CHECK (invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), CONSTRAINT "CHK_invoice_charges_amount_positive" CHECK (amount > 0), CONSTRAINT "PK_39247aa69733624fc6e0fee5c74" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invoice_charges_user_id" ON "invoice_charges" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_invoice_charges_card_month" ON "invoice_charges" ("card_id", "invoice_month") `,
    );
    await queryRunner.query(
      `ALTER TABLE "credit_cards" ADD "archived_at" TIMESTAMP WITH TIME ZONE`,
    );

    // closing_date: nullable → backfill → NOT NULL
    await queryRunner.query(`ALTER TABLE "installments" ADD "closing_date" date`);
    await queryRunner.query(`
      UPDATE "installments" i
      SET "closing_date" = CASE
        WHEN date_trunc('month', i."due_date")::date + (c."closing_day" - 1) < i."due_date"
          THEN date_trunc('month', i."due_date")::date + (c."closing_day" - 1)
        ELSE (date_trunc('month', i."due_date") - interval '1 month')::date + (c."closing_day" - 1)
      END
      FROM "transactions" t
      JOIN "credit_cards" c ON c."id" = t."card_id"
      WHERE t."id" = i."transaction_id"
    `);
    // Órfãs legadas (cartão removido antes do arquivamento): sem dias de cartão para usar
    await queryRunner.query(`
      UPDATE "installments" SET "closing_date" = ("due_date" - interval '1 month')::date
      WHERE "closing_date" IS NULL
    `);
    await queryRunner.query(`ALTER TABLE "installments" ALTER COLUMN "closing_date" SET NOT NULL`);

    await queryRunner.query(
      `ALTER TABLE "invoice_payments" ADD CONSTRAINT "FK_invoice_payments_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_payments" ADD CONSTRAINT "FK_invoice_payments_card" FOREIGN KEY ("card_id") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_charges" ADD CONSTRAINT "FK_invoice_charges_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_charges" ADD CONSTRAINT "FK_invoice_charges_card" FOREIGN KEY ("card_id") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // D18: parcelas pagas de cartão existente → um pagamento legado por (cartão, mês da fatura).
    // O join exige o cartão do mesmo usuário da transação; HAVING evita somas zero (CHECK > 0).
    await queryRunner.query(`
      INSERT INTO "invoice_payments" ("user_id", "card_id", "invoice_month", "amount", "paid_on")
      SELECT c."user_id", t."card_id", to_char(i."due_date", 'YYYY-MM'), SUM(i."amount"), NULL
      FROM "installments" i
      JOIN "transactions" t ON t."id" = i."transaction_id"
      JOIN "credit_cards" c ON c."id" = t."card_id" AND c."user_id" = t."user_id"
      WHERE i."status" = 'paid'
      GROUP BY c."user_id", t."card_id", to_char(i."due_date", 'YYYY-MM')
      HAVING SUM(i."amount") > 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invoice_charges" DROP CONSTRAINT "FK_invoice_charges_card"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_charges" DROP CONSTRAINT "FK_invoice_charges_user"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_payments" DROP CONSTRAINT "FK_invoice_payments_card"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invoice_payments" DROP CONSTRAINT "FK_invoice_payments_user"`,
    );
    await queryRunner.query(`ALTER TABLE "installments" DROP COLUMN "closing_date"`);
    await queryRunner.query(`ALTER TABLE "credit_cards" DROP COLUMN "archived_at"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_invoice_charges_card_month"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_invoice_charges_user_id"`);
    await queryRunner.query(`DROP TABLE "invoice_charges"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_invoice_payments_card_month"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_invoice_payments_user_id"`);
    await queryRunner.query(`DROP TABLE "invoice_payments"`);
  }
}
