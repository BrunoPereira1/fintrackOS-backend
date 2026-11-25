import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDocumentToUsers1775174400000 implements MigrationInterface {
  name = 'AddDocumentToUsers1775174400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "users_document_type_enum" AS ENUM ('cpf', 'cnpj', 'passport')
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "document_type" "users_document_type_enum",
      ADD COLUMN "document"      CHARACTER VARYING
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_users_document" ON "users" ("document")
      WHERE "document" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_users_document"`);
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "document_type", DROP COLUMN "document"`,
    );
    await queryRunner.query(`DROP TYPE IF EXISTS "users_document_type_enum"`);
  }
}
