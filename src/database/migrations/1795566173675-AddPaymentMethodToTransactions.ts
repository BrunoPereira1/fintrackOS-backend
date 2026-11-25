import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Forma de pagamento da transação (spec 2026-11-24-modelo-de-pagamento, fase 1; D1, D15, D18).
 *
 * Backfill: `credit_card` onde há cartão **ou** parcelas (compra de cartão removido mantém as
 * parcelas e fica com `card_id` nulo). As demais transações legadas ficam `NULL` ("não informada")
 * — não dá para saber se foram pix ou dinheiro. O CHECK só é criado depois do backfill.
 */
export class AddPaymentMethodToTransactions1795566173675 implements MigrationInterface {
  name = 'AddPaymentMethodToTransactions1795566173675';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "public"."transactions_payment_method_enum" AS ENUM('credit_card', 'pix', 'cash', 'debit', 'transfer', 'boleto')`,
    );
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD "payment_method" "public"."transactions_payment_method_enum"`,
    );
    await queryRunner.query(`
      UPDATE "transactions" SET "payment_method" = 'credit_card'
      WHERE "card_id" IS NOT NULL
         OR EXISTS (SELECT 1 FROM "installments" i WHERE i."transaction_id" = "transactions"."id")
    `);
    await queryRunner.query(
      `ALTER TABLE "transactions" ADD CONSTRAINT "CHK_transactions_payment_method_card" CHECK (card_id IS NULL OR payment_method = 'credit_card')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "transactions" DROP CONSTRAINT "CHK_transactions_payment_method_card"`,
    );
    await queryRunner.query(`ALTER TABLE "transactions" DROP COLUMN "payment_method"`);
    await queryRunner.query(`DROP TYPE "public"."transactions_payment_method_enum"`);
  }
}
