import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * D31 — datas gravadas por fatura (`card_invoice_dates`): fechamento e vencimento de faturas já
 * fechadas, com precedência sobre as datas das parcelas e os dias atuais do cartão (D25), para a
 * fatura fechada nunca "reabrir" quando os dias do cartão mudam (D14).
 *
 * Backfill: para cada cartão, cada mês de fatura (mês do vencimento, como no razão) com parcelas
 * cujo fechamento — a maior `closing_date` do mês — já passou (≤ hoje no fuso
 * `America/Sao_Paulo`, o padrão de `APP_TIMEZONE`) grava `max(closing_date)`/`max(due_date)`.
 * Só cartões do mesmo usuário da transação (como o razão). Meses fechados sem parcelas e cujos
 * dias já mudaram não são recuperáveis (perda aceita, business-rules §5). Como cada parcela tem
 * `closing_date < due_date`, o máximo também tem; o `HAVING` só protege o CHECK de dado legado
 * inconsistente (o mês fica sem gravação e segue pelas parcelas).
 *
 * Integridade: `FK_card_invoice_dates_card` é composta — `(card_id, user_id)` → `credit_cards(id,
 * user_id)`, alvo `UQ_credit_cards_id_user` — então o banco recusa gravação com cartão de outro
 * usuário.
 *
 * `down()` apaga a tabela (as gravações feitas depois da migration se perdem) e a
 * `UQ_credit_cards_id_user`.
 */
export class AddCardInvoiceDates1795827191986 implements MigrationInterface {
  name = 'AddCardInvoiceDates1795827191986';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Alvo da FK composta: o banco garante que o cartão da gravação é do mesmo usuário
    await queryRunner.query(
      `ALTER TABLE "credit_cards" ADD CONSTRAINT "UQ_credit_cards_id_user" UNIQUE ("id", "user_id")`,
    );
    await queryRunner.query(
      `CREATE TABLE "card_invoice_dates" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "user_id" uuid NOT NULL, "card_id" uuid NOT NULL, "invoice_month" character(7) NOT NULL, "closing_date" date NOT NULL, "due_date" date NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_card_invoice_dates_closing_before_due" CHECK (closing_date < due_date), CONSTRAINT "CHK_card_invoice_dates_month_format" CHECK (invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'), CONSTRAINT "PK_e17b6ab2933668a78ff1563ad4a" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_card_invoice_dates_user_id" ON "card_invoice_dates" ("user_id") `,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_card_invoice_dates_card_month" ON "card_invoice_dates" ("card_id", "invoice_month") `,
    );
    await queryRunner.query(
      `ALTER TABLE "card_invoice_dates" ADD CONSTRAINT "FK_card_invoice_dates_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "card_invoice_dates" ADD CONSTRAINT "FK_card_invoice_dates_card" FOREIGN KEY ("card_id", "user_id") REFERENCES "credit_cards"("id","user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );

    // Backfill: meses já fechados de cada cartão, pelas datas gravadas nas parcelas (D25)
    await queryRunner.query(`
      INSERT INTO "card_invoice_dates" ("user_id", "card_id", "invoice_month", "closing_date", "due_date")
      SELECT c."user_id", c."id", to_char(i."due_date", 'YYYY-MM'),
             MAX(i."closing_date"), MAX(i."due_date")
      FROM "installments" i
      JOIN "transactions" t ON t."id" = i."transaction_id"
      JOIN "credit_cards" c ON c."id" = t."card_id" AND c."user_id" = t."user_id"
      GROUP BY c."user_id", c."id", to_char(i."due_date", 'YYYY-MM')
      HAVING MAX(i."closing_date") <= (now() AT TIME ZONE 'America/Sao_Paulo')::date
         AND MAX(i."closing_date") < MAX(i."due_date")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "card_invoice_dates" DROP CONSTRAINT "FK_card_invoice_dates_card"`,
    );
    await queryRunner.query(
      `ALTER TABLE "card_invoice_dates" DROP CONSTRAINT "FK_card_invoice_dates_user"`,
    );
    await queryRunner.query(`DROP INDEX "public"."UQ_card_invoice_dates_card_month"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_card_invoice_dates_user_id"`);
    await queryRunner.query(`DROP TABLE "card_invoice_dates"`);
    await queryRunner.query(`ALTER TABLE "credit_cards" DROP CONSTRAINT "UQ_credit_cards_id_user"`);
  }
}
