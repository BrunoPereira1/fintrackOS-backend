import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cria `contacts` e troca `cost_splits.person_name/person_email` por `contact_id`.
 *
 * Migração de dados (backfill): para cada usuário dono da transação, um contato por pessoa
 * distinta. Chave de agrupamento: e-mail normalizado (`lower(trim(person_email))`) quando houver,
 * senão o nome normalizado (trim, espaços colapsados, minúsculas). Os prefixos `e:`/`n:` evitam
 * que um nome igual a um e-mail caia no mesmo grupo. O nome do contato é o do split mais antigo
 * do grupo (com espaços normalizados, caixa preservada).
 */
export class CreateContactsAndLinkSplits1795318458680 implements MigrationInterface {
  name = 'CreateContactsAndLinkSplits1795318458680';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. contacts
    await queryRunner.query(`
      CREATE TABLE "contacts" (
        "id"         uuid                      NOT NULL DEFAULT uuid_generate_v4(),
        "name"       character varying(255)    NOT NULL,
        "email"      character varying(254),
        "phone"      character varying(32),
        "user_id"    uuid                      NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE  NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE  NOT NULL DEFAULT now(),
        CONSTRAINT "PK_contacts" PRIMARY KEY ("id"),
        CONSTRAINT "FK_contacts_user"
          FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(`CREATE INDEX "IDX_contacts_user_id" ON "contacts" ("user_id")`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_contacts_user_email" ON "contacts" ("user_id", "email")
      WHERE "email" IS NOT NULL
    `);

    // 2. coluna nova, ainda opcional, para o backfill
    await queryRunner.query(`ALTER TABLE "cost_splits" ADD "contact_id" uuid`);

    // 3. backfill: cria os contatos e liga os splits a eles (uma única instrução)
    await queryRunner.query(`
      WITH keyed AS (
        SELECT
          s."id"      AS split_id,
          t."user_id" AS user_id,
          CASE
            WHEN NULLIF(trim(s."person_email"), '') IS NOT NULL
              THEN 'e:' || lower(trim(s."person_email"))
            ELSE 'n:' || lower(regexp_replace(trim(s."person_name"), '\\s+', ' ', 'g'))
          END AS person_key,
          NULLIF(regexp_replace(trim(s."person_name"), '\\s+', ' ', 'g'), '') AS clean_name,
          lower(NULLIF(trim(s."person_email"), '')) AS clean_email,
          row_number() OVER (ORDER BY t."created_at", t."id", s."id") AS ord
        FROM "cost_splits" s
        JOIN "transactions" t ON t."id" = s."transaction_id"
      ),
      picked AS (
        -- volátil (uuid_generate_v4) → o Postgres materializa o CTE uma única vez
        SELECT DISTINCT ON (user_id, person_key)
          uuid_generate_v4() AS contact_id,
          user_id,
          person_key,
          left(COALESCE(clean_name, clean_email, '(sem nome)'), 255) AS name,
          -- e-mail acima do limite da coluna não é truncado (truncar poderia colidir no UQ)
          CASE WHEN length(clean_email) <= 254 THEN clean_email END AS email
        FROM keyed
        ORDER BY user_id, person_key, ord
      ),
      inserted AS (
        INSERT INTO "contacts" ("id", "user_id", "name", "email")
        SELECT contact_id, user_id, name, email FROM picked
      )
      UPDATE "cost_splits" s
      SET "contact_id" = p.contact_id
      FROM keyed k
      JOIN picked p ON p.user_id = k.user_id AND p.person_key = k.person_key
      WHERE s."id" = k.split_id
    `);

    // 4. obrigatório + FK + índice. Contato com splits não pode ser removido, mas a checagem é
    //    diferida (COMMIT) e não RESTRICT: ao apagar o usuário, as cascatas users→contacts e
    //    users→transactions→cost_splits rodam em ordem de trigger (OID; muda após dump/restore)
    //    e, com checagem imediata, a exclusão falharia se contacts fosse apagado primeiro.
    await queryRunner.query(`ALTER TABLE "cost_splits" ALTER COLUMN "contact_id" SET NOT NULL`);
    await queryRunner.query(`
      ALTER TABLE "cost_splits" ADD CONSTRAINT "FK_cost_splits_contact"
      FOREIGN KEY ("contact_id") REFERENCES "contacts"("id")
      ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_cost_splits_contact_id" ON "cost_splits" ("contact_id")`,
    );

    // 5. o contato passa a ser a fonte do nome/e-mail
    await queryRunner.query(
      `ALTER TABLE "cost_splits" DROP COLUMN "person_name", DROP COLUMN "person_email"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "cost_splits" ADD "person_name" character varying, ADD "person_email" character varying`,
    );
    await queryRunner.query(`
      UPDATE "cost_splits" s
      SET "person_name" = c."name", "person_email" = c."email"
      FROM "contacts" c
      WHERE c."id" = s."contact_id"
    `);
    await queryRunner.query(`ALTER TABLE "cost_splits" ALTER COLUMN "person_name" SET NOT NULL`);

    await queryRunner.query(`ALTER TABLE "cost_splits" DROP CONSTRAINT "FK_cost_splits_contact"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_cost_splits_contact_id"`);
    await queryRunner.query(`ALTER TABLE "cost_splits" DROP COLUMN "contact_id"`);

    // Índices e FK_contacts_user caem junto com a tabela
    await queryRunner.query(`DROP TABLE "contacts"`);
  }
}
