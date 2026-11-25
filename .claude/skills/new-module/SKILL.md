---
name: new-module
description: Cria um módulo de domínio NestJS completo no padrão do FinTrack (entity, DTOs, service com isolamento por userId, controller com guards de auth/plano e Swagger, spec, migration e registro no AppModule). Use quando o usuário pedir um novo recurso/endpoint CRUD, nova entidade ou novo módulo.
argument-hint: <nome-no-plural> [plano-minimo] [descrição dos campos]
---

# new-module

Cria `src/<modulo>/` seguindo exatamente o padrão dos módulos existentes e `docs/knowledge/patterns.md` (leia antes). Se o módulo envolve regra financeira ou dependência nova entre módulos, consulte antes os subagentes `business-rules` e `architect`. **Referência canônica: `src/assets/` e `src/cards/`** — leia-os antes de gerar, e copie o estilo deles em vez de inventar.

## Entrada
- `$ARGUMENTS`: nome do módulo no plural em kebab-case (ex.: `budgets`), plano mínimo opcional (`basic` | `intermediate` | `premium`, default `basic`) e descrição dos campos.
- Se os campos não estiverem claros (tipos, obrigatoriedade, enums, relações), pergunte antes de gerar.

## Arquivos a criar
```
src/<modulo>/
  entities/<singular>.entity.ts
  dto/create-<singular>.dto.ts
  dto/update-<singular>.dto.ts
  dto/<singular>-response.dto.ts
  <modulo>.service.ts
  <modulo>.service.spec.ts
  <modulo>.controller.ts
  <modulo>.module.ts
```

## Regras por arquivo

**Entity**
- `@Entity('<tabela_snake_case_plural>')`, `@PrimaryGeneratedColumn('uuid') id!: string`.
- Colunas camelCase no TS com `name: 'snake_case'` no banco. Propriedades com `!`.
- Dinheiro/quantidade: `type: 'decimal', precision: 14, scale: 2` (ou `6` para quantidade de ativos).
- Enums exportados no próprio arquivo da entity, valores em snake_case minúsculo; coluna `type: 'enum'`.
- Sempre: `@Index() @Column({ name: 'user_id' }) userId`, `@ManyToOne(() => User, { onDelete: 'CASCADE' }) @JoinColumn({ name: 'user_id' }) user`, `createdAt`/`updatedAt` com `@CreateDateColumn`/`@UpdateDateColumn` (`created_at`/`updated_at`).

**DTOs**
- Create: `@ApiProperty({ example })` + validadores `class-validator` em todo campo; datas como `@IsDateString()` string; números com `@IsNumber({ maxDecimalPlaces })` e `@Min`. **Nunca** inclua `userId` no DTO — vem do token.
- Update: `export class Update<X>Dto extends PartialType(Create<X>Dto) {}` (de `@nestjs/swagger`).
- Response: uma linha por campo, `@ApiProperty() campo!: tipo;`, `enum:` nos enums.

**Service** (`Logger` com `<X>Service.name`)
- `create(userId, dto)`, `findAllByUser(userId)` (ordenado por `createdAt DESC`), `findOne(id, userId)`, `update(id, userId, dto)`, `remove(id, userId)`.
- `findOne`: `NotFoundException(ErrorMessages.NOT_FOUND.<X>)` se não existir; `ForbiddenException(ErrorMessages.ACCESS_DENIED)` se `entity.userId !== userId`. `update`/`remove` chamam `findOne`.
- Adicione a chave `<X>` em `ErrorMessages.NOT_FOUND` (`src/common/constants/error-messages.ts`).

**Controller**
- Decorators de classe: `@ApiTags('<modulo>')`, `@ApiBearerAuth('firebase-jwt')`, `@UseGuards(AuthGuard, TierGuard)`, `@RequiresTier(Plan.<PLANO>)`, `@Controller('<modulo>')`.
- `@CurrentUser() user: User` e passe `user.id`; `@Param('id', ParseUUIDPipe)`.
- `@ApiCreatedResponse` / `@ApiOkResponse({ type: [Dto] })` / `DELETE` com `@HttpCode(HttpStatus.NO_CONTENT)` + `@ApiNoContentResponse()`.

**Module**: `TypeOrmModule.forFeature([Entity])`, service em `providers`, controller em `controllers`. Exporte o service só se outro módulo precisar.

**Spec** (padrão de `src/cards/cards.service.spec.ts`)
- Repositório mockado via `getRepositoryToken(Entity)` com `create/save/find/findOne/remove` como `jest.fn()`.
- Cubra no mínimo: create salva com `userId`; findAllByUser filtra por `userId`; findOne → `NotFoundException` quando ausente e `ForbiddenException` com `OTHER_USER_ID`; update aplica campos; remove chama `repo.remove`.

## Integração
1. Importe o módulo em `src/app.module.ts` (antes de `HealthModule`).
2. Adicione `.addTag('<modulo>', '<descrição pt-BR>')` em `src/config/swagger.config.ts`.
3. Gere a migration com a skill `/create-migration` (ou `make migration-generate name=Create<X>Table`) — nunca use `synchronize`.

## Verificação (obrigatória antes de concluir)
```bash
npm run lint:check && npm run typecheck && npx jest src/<modulo>
```
Depois rode o subagente `patterns` sobre os arquivos criados e corrija as violações. Reporte os resultados reais. Se a migration foi gerada, mostre o SQL dela ao usuário.
