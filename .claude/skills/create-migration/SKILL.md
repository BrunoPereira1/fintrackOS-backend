---
name: create-migration
description: Gera, revisa e valida uma migration TypeORM a partir das mudanças nas entities, testando run/revert/run e ausência de drift num banco descartável.
argument-hint: <NomeEmPascalCase>
disable-model-invocation: true
---

# create-migration

Gera a migration `$ARGUMENTS` a partir da diferença entre as entities e o banco local, revisa o SQL e valida num banco descartável.

## Pré-condições
1. `$ARGUMENTS` é obrigatório e em PascalCase descritivo (ex.: `AddCategoryToTransactions`). Se vier vazio, pergunte.
2. Postgres local de pé: `docker ps` deve listar `fintrack_postgres`. Se não, peça para rodar `make up`.
3. O banco local precisa estar em dia, senão o diff inclui migrations antigas:
   ```bash
   npm run migration:show
   ```
   Se houver pendentes (`[ ]`), rode `npm run migration:run` antes de gerar.

## Passos
1. **Gerar**
   ```bash
   make migration-generate name=$ARGUMENTS
   ```
   Se responder "No changes in database schema were found", pare e avise: as entities não mudaram.

2. **Revisar o arquivo gerado** em `src/database/migrations/<timestamp>-$ARGUMENTS.ts` e mostrar ao usuário um resumo do `up()`. Sinalize explicitamente:
   - `DROP COLUMN` / `DROP TABLE` → **perda de dados**. Confirme com o usuário; para renomear coluna, troque por `ALTER TABLE ... RENAME COLUMN`.
   - `ADD COLUMN ... NOT NULL` sem `DEFAULT` em tabela existente → falha com dados existentes. Sugira default ou migração em 2 passos (nullable → backfill → NOT NULL).
   - Mudança de tipo de coluna (`ALTER COLUMN ... TYPE`) → verifique se precisa de `USING`.
   - Novas FKs/índices sem nome explícito → prefira nomear na entity (`@Index('IDX_<tabela>_<coluna>')`, `foreignKeyConstraintName: 'FK_<tabela>_<ref>'`), como as entities existentes fazem.
   - `down()` deve desfazer exatamente o `up()`, em ordem inversa.

   A migration recém-gerada pode ser editada (o hook só bloqueia migrations já versionadas no Git).

3. **Validar num banco descartável** (não toca no `fintrack_db`):
   ```bash
   .claude/skills/create-migration/scripts/validate-migrations.sh
   ```
   O script aplica tudo, reverte e reaplica a última e confirma que não há drift entre entities e schema. Se falhar, corrija a migration e rode de novo.

4. **Aplicar no banco local** só depois da validação passar:
   ```bash
   npm run migration:run
   ```

5. **Verificação final**
   ```bash
   npm run lint:check && npm run typecheck && npm test
   ```

## Saída
Informe: o caminho da migration, um resumo das mudanças de schema, os alertas de risco (se houver) e o resultado real de cada verificação. Não faça commit — deixe para o usuário.
