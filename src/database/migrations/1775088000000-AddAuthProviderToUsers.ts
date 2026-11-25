import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuthProviderToUsers1775088000000 implements MigrationInterface {
  name = 'AddAuthProviderToUsers1775088000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN "auth_provider" CHARACTER VARYING NOT NULL DEFAULT 'password'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "auth_provider"
    `);
  }
}
