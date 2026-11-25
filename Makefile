.PHONY: setup dev up down reset \
        db-setup db-seed db-reset seed \
        migration-generate migration-run migration-revert migration-show migration-check \
        validate-env validate-setup \
        logs build test lint queue

## Configuração inicial para novos desenvolvedores
setup:
	@bash scripts/setup.sh

## Inicia o servidor em modo desenvolvimento
dev:
	npm run start:dev

## Sobe os containers (PostgreSQL + Redis)
up:
	docker compose up -d

## Para os containers
down:
	docker compose down

## Para, remove volumes e reinicia do zero (migrations)
reset:
	docker compose down -v
	docker compose up -d
	@bash scripts/db-setup.sh

## Executa migrations pendentes (aguarda PostgreSQL)
db-setup:
	@bash scripts/db-setup.sh

## Popula o banco com dados iniciais
db-seed:
	@bash scripts/db-setup.sh --seed

## Popula o banco com dados de desenvolvimento (sem rodar migrations)
seed:
	npm run seed

## Para containers, remove volumes e reaplica migrations + seed
db-reset:
	docker compose down -v
	docker compose up -d
	@bash scripts/db-setup.sh --seed

## Gera uma nova migration (uso: make migration-generate name=NomeDaMigration)
migration-generate:
	npm run migration:generate -- src/database/migrations/$(name)

## Executa as migrations pendentes
migration-run:
	npm run migration:run

## Reverte a última migration
migration-revert:
	npm run migration:revert

## Verifica se as entities batem com o schema das migrations (sem drift)
migration-check:
	npm run migration:check

## Lista o status das migrations
migration-show:
	npm run migration:show

## Valida variáveis de ambiente obrigatórias
validate-env:
	@bash scripts/validate-env.sh

## Verifica conectividade (PostgreSQL, Redis) e status das migrations
validate-setup:
	@bash scripts/validate-setup.sh

## Exibe os logs dos containers
logs:
	docker compose logs -f

## Build de produção
build:
	npm run build

## Executa os testes unitários
test:
	npm run test

## Executa os testes com coverage
test-cov:
	npm run test:cov

## Executa os testes e2e
test-e2e:
	npm run test:e2e

## Lint e formatação
lint:
	npm run lint

## Abre o dashboard de filas (Bull Board) na porta 3002
queue:
	npm run queue:dashboard
