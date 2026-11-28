import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = ['invoice_payments', 'invoice_charges'] as const;

/**
 * FK composta de posse do cartão em `invoice_payments` e `invoice_charges`: troca
 * `FK_<tabela>_card` (card_id → credit_cards.id) por uma FK de MESMO nome
 * `(card_id, user_id)` → `credit_cards(id, user_id)` (alvo `UQ_credit_cards_id_user`, criada pela
 * AddCardInvoiceDates1795827191986), ON DELETE CASCADE como antes. O banco passa a recusar
 * lançamento com cartão de outro usuário. As FKs para `users` não mudam.
 *
 * Antes de trocar, verifica linhas em que o dono do cartão difere do `user_id` da linha: se houver,
 * a migration FALHA sem apagar nem corrigir nada (dado a ser analisado à mão).
 *
 * Escrita à mão: o TypeORM compara FK só pelo nome, então `migration:generate` não detecta a troca
 * de colunas de uma FK que mantém o nome.
 *
 * `down()` volta às FKs simples, com os mesmos nomes e ON DELETE CASCADE.
 */
export class CompositeCardOwnerFks1795829417270 implements MigrationInterface {
  name = 'CompositeCardOwnerFks1795829417270';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      const [{ n }] = (await queryRunner.query(
        `SELECT count(*)::int AS n FROM "${table}" r
         JOIN "credit_cards" c ON c."id" = r."card_id"
         WHERE c."user_id" <> r."user_id"`,
      )) as { n: number }[];
      if (n > 0) {
        throw new Error(
          `${table}: ${n} linha(s) com card_id de cartão de outro usuário (credit_cards.user_id <> ${table}.user_id). ` +
            'Corrija os dados manualmente antes de rodar esta migration; nada foi alterado.',
        );
      }
    }

    for (const table of TABLES) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "FK_${table}_card"`);
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "FK_${table}_card" FOREIGN KEY ("card_id", "user_id") REFERENCES "credit_cards"("id","user_id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...TABLES].reverse()) {
      await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT "FK_${table}_card"`);
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "FK_${table}_card" FOREIGN KEY ("card_id") REFERENCES "credit_cards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
      );
    }
  }
}
