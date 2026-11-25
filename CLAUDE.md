# FinTrack OS — Backend API

API REST do FinTrack OS Pro Edition: finanças pessoais (cartões, transações, parcelas, divisão de custos, investimentos, leitura de NF-e).

## Stack
NestJS 10 · TypeScript (strict) · TypeORM 0.3 + PostgreSQL 16 · Redis (cache-manager, throttler, BullMQ) · Firebase Admin (auth) · nestjs-i18n (pt-BR padrão, en, es) · Swagger em `/docs` · Node 20.

## Comandos
```bash
make up                 # sobe Postgres + Redis (docker compose)
make dev                # API em watch mode (porta 3001)
npm run lint:check      # ESLint sem --fix (o que o CI roda)
npm run typecheck       # tsc --noEmit
npm test                # unitários (src/**/*.spec.ts)
npm run test:e2e        # e2e (test/**/*.e2e-spec.ts) — precisa de `make up`
make migration-generate name=NomeDaMigration
make migration-run | migration-revert | migration-show
npm run migration:check # falha se entities divergirem do schema (roda no CI)
```
Antes de dizer que algo está pronto: `npm run lint:check && npm run typecheck && npm test`.

## Base de conhecimento (obrigatória)
Fonte única das regras, em `docs/knowledge/`. **Leia o documento antes de mexer na área** e atualize-o no mesmo PR quando a mudança alterar uma regra:

| Vai mexer em… | Leia | Guardião (subagente) |
|---|---|---|
| Regra financeira: planos, transações, cartões, faturas, parcelas, splits, contatos, resumo | `docs/knowledge/business-rules.md` | `business-rules` |
| Módulo novo, entity/migration, dependência entre módulos, auth/sessão, cache, config | `docs/knowledge/architecture.md` | `architect` |
| Firebase, Redis, BullMQ, HTTP de saída, SDK/pacote novo, webhooks | `docs/knowledge/integrations.md` | `integration-guard` |
| Qualquer código (DTO, service, controller, testes, logs, dinheiro, datas) | `docs/knowledge/patterns.md` | `patterns` |

Fluxo para funcionalidades:
1. **Antes**: consulte `business-rules` e/ou `architect` (e `integration-guard` se houver integração). Lacunas de regra são perguntadas ao usuário, nunca decididas sozinho.
2. **Implementação** com TDD seguindo `patterns.md`.
3. **Depois**: rode os guardiões relevantes sobre o diff (sempre `patterns`; `business-rules` se tocou regra financeira; `architect` se mudou estrutura/dados; `integration-guard` se tocou integração) e corrija as violações antes de concluir.

## Arquitetura
Um módulo por domínio em `src/<dominio>/` com `entities/`, `dto/`, `*.service.ts`, `*.controller.ts`, `*.module.ts` e `*.service.spec.ts`.
- `auth/`: estratégia Passport `firebase` (`AuthGuard`), `TierGuard` + `@RequiresTier(Plan.X)`, `RolesGuard`, `@CurrentUser()`.
- `common/`: `ErrorMessages`, `CacheKeys`/`CacheTTL`, `PaginationDto`, validadores (CPF/CNPJ).
- `config/`: factories de TypeORM, Redis, cache, throttler, Firebase, Swagger (exportadas por `config/index.ts`).
- `health/`: `GET /health/live` (liveness) e `GET /health` (Postgres + Redis), públicos e sem throttle.
- `ocr/` (fila BullMQ `OCR_QUEUE`) e `notifications/` (WhatsApp) ainda são stubs com `TODO`.

## Convenções (resumo — detalhes em `docs/knowledge/patterns.md`)
- **Isolamento por usuário é obrigatório**: todo método de service recebe `userId`; `findOne` lança `NotFoundException(ErrorMessages.NOT_FOUND.X)` e `ForbiddenException(ErrorMessages.ACCESS_DENIED)` se `entity.userId !== userId`. `update`/`remove` reaproveitam `findOne`.
- Controllers: `@ApiTags`, `@ApiBearerAuth('firebase-jwt')`, `@UseGuards(AuthGuard, TierGuard)`, `ParseUUIDPipe` em `:id`, respostas tipadas com `*ResponseDto` + decorators `@Api*Response`.
- DTOs com `class-validator`; o `ValidationPipe` global usa `whitelist` + `forbidNonWhitelisted` (campo extra → 400).
- Novas mensagens de erro vão em `common/constants/error-messages.ts`; textos para o usuário vão nos 3 arquivos de `src/i18n/translations/*/common.json`.
- Chaves de cache sempre via `CacheKeys` e invalidadas explicitamente após escrita.
- Schema só muda via migration (`synchronize: false`). **Nunca edite uma migration versionada** — gere uma nova.
- Índices e FKs têm nome explícito na entity (`@Index('IDX_<tabela>_<coluna>')`, `foreignKeyConstraintName: 'FK_<tabela>_<ref>'`) e timestamps são `timestamptz`, para bater com as migrations.
- Prettier: aspas simples, trailing comma, `printWidth: 100`.
- Testes unitários mockam repositórios com `getRepositoryToken(Entity)`; siga o padrão de `cards.service.spec.ts`.

## Automações do Claude Code
- Skills: `/new-module <nome> [plano]` (módulo CRUD completo no padrão) e `/create-migration <Nome>` (gera, revisa e valida em banco descartável).
- Subagentes: guardiões `business-rules`, `architect`, `integration-guard`, `patterns` (somente leitura, veja acima); `security-reviewer` (IDOR, guards, LGPD) e `test-writer` (Jest no padrão do projeto).
- MCP: `context7` (`.mcp.json`) para documentação atualizada de NestJS/TypeORM/BullMQ.

## Cuidados
- `.env` contém credenciais reais do Firebase — nunca leia, copie ou commite. `.env.example` só com placeholders.
- Hooks em `.claude/settings.json`: bloqueiam edição de `.env*`, `package-lock.json` e migrations já versionadas; formatam e rodam ESLint em todo `.ts` editado.
