# Padrões de código — FinTrack OS

Como escrever código neste repositório. Guardião: subagente `patterns`. Na dúvida, copie o padrão de `src/cards/` (CRUD) e de `src/transactions/` (regra de negócio mais rica).

## Estrutura de módulo

```
src/<dominio>/
  entities/<singular>.entity.ts
  dto/create-<singular>.dto.ts  update-<singular>.dto.ts  <singular>-response.dto.ts  query-<plural>.dto.ts
  <dominio>.service.ts  <dominio>.service.spec.ts
  <dominio>.controller.ts  (+ .spec.ts quando houver lógica além de delegar)
  <dominio>.module.ts
```
Para criar um módulo novo, use a skill `/new-module`.

## Entities

- Tabela no plural, em snake_case; propriedades em camelCase com `name: 'snake_case'`; todas com `!`.
- Índices e FKs **com nome explícito**: `@Index('IDX_<tabela>_<coluna>')`, `@Index('UQ_<tabela>_<coluna>', { unique: true })`, `foreignKeyConstraintName: 'FK_<tabela>_<ref>'`.
- `createdAt`/`updatedAt` como `timestamptz`; datas de calendário como `type: 'date'`.
- Dinheiro: `decimal(12,2)` (`precision: 12, scale: 2`). Quantidade de ativo: `decimal(14,6)`.
- Enums exportados no arquivo da entity, com valores em snake_case minúsculo. Enum usado por regra pura (calculadora, `*-state.ts`) fica num **arquivo folha** `<nome>.enum.ts`, reexportado pela entity (ex.: `src/installments/installment-status.enum.ts`): regra pura não importa entity.
- CHECK sempre com nome explícito: `@Check('CHK_<tabela>_<regra>', '<expressão>')` (o TypeORM compara CHECK pelo nome). Em migration que adiciona CHECK sobre dado existente, crie o CHECK **depois** do backfill.
- Enum: não declare `enumName` quando ele for igual ao padrão do TypeORM (`<tabela>_<coluna>_enum`) — senão o `migration:check` acusa diferença falsa.
- Backfill de migration que depende de "hoje" usa `(now() AT TIME ZONE 'America/Sao_Paulo')::date` (padrão de `APP_TIMEZONE`; migration não lê `ConfigService`) e documenta isso no JSDoc da migration. Deploy com `APP_TIMEZONE` diferente do padrão precisa revisar esses backfills.
- Tabela com `user_id` que referencia recurso de usuário (ex.: cartão): FK **composta** `(ref_id, user_id) → <tabela>(id, user_id)` — na entity, `@JoinColumn([{ name: 'card_id', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_<tabela>_card' }, { name: 'user_id', referencedColumnName: 'userId' }])` (o TypeORM lê o nome só da 1ª coluna) e a tabela-alvo com `@Unique('UQ_<alvo>_id_user', ['id', 'userId'])`. Como `user_id` é compartilhada pelas relações `user` e `card`, grave **só as colunas escalares** (`cardId`/`userId`) ou SQL parametrizado — nunca atribua os objetos `card:`/`user:` num `save`.
- ⚠️ O TypeORM compara FK **só pelo nome**: mudar as colunas de uma FK mantendo o nome não gera diff — `migration:generate` diz "No changes" e `migration:check` passa **sem** a migration. Escreva-a à mão (`migration:create`), confira `pg_get_constraintdef` no Postgres e cubra com e2e que viole a constraint.
- Mudou a entity? Gere migration com `/create-migration` e rode `npm run migration:check`.

## DTOs

- `class-validator` em **todo** campo, mais `@ApiProperty`/`@ApiPropertyOptional` com `example`.
- Limites obrigatórios: `@MaxLength(255)` em textos livres, `@MaxLength(254)` em e-mail, `@ArrayMaxSize` em arrays, `@Min`/`@Max` em números, `@IsNumber({ maxDecimalPlaces: 2 })` em dinheiro.
- Datas de entrada: `@IsDateString()`, como string `YYYY-MM-DD`; **não** converta com `new Date(str)` (veja Datas).
- Update: `PartialType(OmitType(Create, [campos imutáveis]))`.
- **Nunca** aceite `userId`, `plan`, `role`, `firebaseUid` em DTO de entrada.
- Query DTO de listagem estende `PaginationDto` (`page`, `limit` ≤ 100).

## Services

- Todo método público de domínio recebe `userId` (e `userPlan` quando a regra depende do plano).
- Padrão de posse:
  ```ts
  async findOne(id: string, userId: string) {
    const x = await this.repo.findOne({ where: { id } });
    if (!x) throw new NotFoundException(ErrorMessages.NOT_FOUND.X);
    if (x.userId !== userId) throw new ForbiddenException(ErrorMessages.ACCESS_DENIED);
    return x;
  }
  ```
  `update` e `remove` reaproveitam `findOne`. Entidades sem `user_id` direto (parcelas, splits) usam `innerJoin` até a tabela dona com `t.user_id = :userId` e respondem 404.
- IDs de relação vindos do body são validados **contra o usuário** (ex.: `cardsService.findOne(cardId, userId)`).
- Exceções do Nest com mensagens de `ErrorMessages`:
  - `BadRequest` (400): entrada inválida ou referência inválida;
  - `Forbidden` (403): recurso de outro usuário ou plano insuficiente;
  - `NotFound` (404);
  - `Conflict` (409): estado impede a operação, por exemplo remover algo referenciado;
  - `UnprocessableEntity` (422): regra de negócio violada (somas que não batem, parcela coberta em fatura fechada);
  - `ServiceUnavailable` (503): dependência fora.
- Nada de string solta em mensagem de erro: adicione em `src/common/constants/error-messages.ts`.

### Violações do banco, IDs do body e concorrência
- Erro do Postgres → exceção HTTP com `isUniqueViolation(err, 'UQ_...')` / `isForeignKeyViolation(err, 'FK_...')` (`src/common/db-errors.ts`), **sempre com o nome da constraint**. Faça a checagem prévia (resposta amigável) **e** capture a violação no `save` (corrida).
- ID de relação vindo do **body** (não da URL) inexistente ou de outro usuário → **400 com mensagem genérica única** (ex.: `SPLIT_INVALID_CONTACT`), para não virar oráculo de IDs. 404/403 ficam para o recurso da rota.
  - Quando o ID do body passa por um helper que já checa posse com trava (`CardsService.lockOwned`, `TransactionsService.runLocked`), passe `{ onNotOwned: () => new BadRequestException(ErrorMessages.X_INVALID_Y) }`: o `SELECT ... FOR UPDATE` filtra por `id` **e** `user_id` (linha alheia nunca é travada — sem canal de tempo) e só a checagem de posse vira 400; erros do trabalho passam intactos. A posse vem antes de qualquer regra que revele o estado da referência (alheio + arquivado → 400, nunca 422 `CARD_ARCHIVED`). Teste inexistente **e** alheio com a mesma resposta (D30).
- ID usado como **filtro de listagem na query string** (`?cardId=`, `?contactId=`, `?transactionId=`) → **só entra no `WHERE`** junto do `user_id` (e de `user_id` em todo join): inexistente ou de outro usuário → **resultado vazio** (lista vazia, totais zerados), nunca 404/403 e sem `findOne` prévio — a resposta é a mesma nos dois casos, então não revela existência (business-rules §1, D28). e2e cobre id alheio **e** inexistente.
- Regra "ler, checar e gravar" que outra requisição pode violar no meio → dentro de `runLocked` (ou trava equivalente na linha pai), com e2e de concorrência (`Promise.allSettled`) — padrão em `test/concurrency.e2e-spec.ts`. Prove o teste removendo a trava: ele precisa falhar.

- Escrita que depende do estado do **cartão** (pagamento/encargo, arquivar/reativar, mudar dias): transação → `CardsService.lockOwned(em, id, userId, opts?)` (`FOR UPDATE` + 404/403; com `{ onNotOwned }`, ID do body: trava filtrando por `user_id` e lança o erro custom — D30) → serviço de domínio que recebe `(em, entidadeTravada, ...)` e **não** revalida posse; as leituras da regra usam o mesmo `em`. Ordem global de travas: cartão → transação. Envolva a transação em `mapTransactionConflict` (`db-errors.ts`): deadlock/serialização (40P01/40001) → 409 `CONCURRENT_UPDATE`.

### Leitura agregada (relatórios)
- Regras puras em `<nome>.calculator.ts` (sem I/O, `today` por parâmetro, decimais `string | number` somados em centavos) com spec próprio.
- O service só monta queries com `user_id` em **todo** join e formata `date` no SQL com `to_char(..., 'YYYY-MM-DD')` (em `getRawMany` o driver devolve `Date`). "Hoje" vem do provider `Clock`.
- **Um único "hoje" por requisição**: o service lê `clock.today()` **uma vez** e repassa o mesmo valor a tudo o que depende da data — calculadoras e `InvoiceLedgerQuery.loadLedgers(userId, { today })` / `loadLedger(userId, cardId, em, today)` (sem `today`, a query lê o `Clock` por conta própria). Evita razão e regra divergindo na virada do dia.
- **Snapshot de leitura**: visão que combina o razão (`InvoiceLedgerQuery`) com linhas descritivas/agregadas (fatura, resumo, "quem me deve", `GET /installments`) lê tudo numa transação `REPEATABLE READ` (`dataSource.transaction('REPEATABLE READ', em => ...)` ou `repo.manager.transaction(...)`; também `GET /installments/:id`) e passa o mesmo `em` ao razão — razão e linhas enxergam o mesmo estado mesmo com pagamento/compra concorrente.
- **Status derivado filtrado no SQL**: quando a listagem filtra/pagina por um status que só o razão conhece (`GET /installments?status=`), não materialize a lista no service. Reduza o razão a parâmetros (por cartão, o **limiar FIFO** da última parcela totalmente coberta — as cobertas de valor > 0 são prefixo da ordem; parcela de valor zero é `paid` em qualquer posição e é tratada à parte no `CASE` (`WHEN i.amount = 0`) — e os meses de fatura vencidos; `listingCoverage`), derive o status num `CASE` no SQL comparando tuplas com tipos nativos (`date`, `timestamptz`, `uuid`, `int`) e faça `count`/`LIMIT`/`OFFSET` no banco. O e2e compara o status do SQL com o da calculadora.
- e2e obrigatório contra o banco real (somas, limites de mês, isolamento).

### Projeções
- Contato embutido em outro recurso: `ContactMapper.toSummary` (id, nome, e-mail — sem telefone nem `userId`).

## Dinheiro e datas

- Some e compare **em centavos**: `toCents`/`sumCents` (`src/common/money.ts`). Nunca `a + b === c` com floats nem `Number(decimal)` sem arredondar.
- Divisão de valores: em centavos inteiros, com o resto na última parte — use `splitCents(totalCents, partes)` (`src/common/money.ts`), a mesma função da calculadora de parcelas e da edição só de valor (D26).
- Data de calendário entra como string `YYYY-MM-DD` e é tratada como `{ year, month, day }`. Para persistir em coluna `date`, use `new Date(y, m, d)` (meia-noite local, critério do TypeORM). Coluna `date` lida do banco chega como string.
- "Hoje" é recebido por parâmetro em lógica pura e, nos services, vem do `Clock` (`ClockModule` global), que calcula a data de calendário no fuso `APP_TIMEZONE` (padrão `America/Sao_Paulo`), independente do `TZ` do processo. **Nunca** obtenha a data de calendário com `new Date().getDate()`/`toISOString()`; não chame `new Date()` escondido dentro de regras.
- Testes: unitários usam `{ provide: Clock, useValue: { today: () => 'YYYY-MM-DD' } }`; e2e que montam módulos com `Clock` importam `ClockModule` e usam `overrideProvider(Clock)`; para testar o próprio fuso, `new Clock('Asia/Tokyo')` + fake timers.

## Controllers

```ts
@ApiTags('x') @ApiBearerAuth('firebase-jwt')
@UseGuards(AuthGuard, TierGuard) @RequiresTier(Plan.X)
@Controller('x')
```
- `@CurrentUser() user: User`, passando `user.id` (e `user.plan` quando necessário); `@Param('id', ParseUUIDPipe)`.
- Resposta tipada (`*ResponseDto`, com mapper quando a entity tem campos internos) e decorators `@ApiOkResponse`/`@ApiCreatedResponse`/`@ApiNoContentResponse`.
- `DELETE` → `@HttpCode(HttpStatus.NO_CONTENT)`.
- Rotas com vários parâmetros de caminho (ex.: `/cards/:cardId/invoices/:month/payments/:id`): `@Param() params: XParamsDto` com `@IsUUID`/`@Matches` em cada campo. Remoção de sub-recurso filtra por todos os segmentos (`id`, dono, pai, mês) e responde 404 se `affected = 0`.
- Exceção registrada: `GET /cards` (`QueryCardsDto`, só `includeArchived`) não estende `PaginationDto` — nunca foi paginado e paginar mudaria o contrato.

## Cache, logs e config

- Chaves de cache via `CacheKeys`, TTL via `CacheTTL`; invalidar após escrita.
- `private readonly logger = new Logger(Classe.name)`; logue **IDs**, nunca nome, e-mail, telefone, documento, descrição de compra ou token.
- Env só via `ConfigService` ou `src/config/*`.

## Testes

- Unitário ao lado do código (`*.spec.ts`), repositórios mockados com `getRepositoryToken(Entity)`; padrão em `src/cards/cards.service.spec.ts`.
- Obrigatório por service: caminho feliz checando **o que foi passado ao repositório**, 404, 403 com `OTHER_USER_ID` e cada regra de negócio com seus limites (ex.: soma exata passa, soma +1 centavo falha).
- Valores decimais nos mocks como **string** (`'200.00'`), como o Postgres devolve.
- Datas: strings `YYYY-MM-DD`; para "hoje", use `jest.useFakeTimers().setSystemTime(...)`.
- Escrita multi-tabela ou query complexa (agregações, joins): **e2e contra o Postgres real** em `test/*.e2e-spec.ts`, criando o próprio usuário e limpando no final (padrão em `test/transactions-installments.e2e-spec.ts`).
- TDD: escreva o teste que falha antes da implementação.

## Antes de concluir

```bash
npm run lint:check && npm run typecheck && npm test
npm run test:e2e        # se mexeu em query/escrita multi-tabela (requer make up)
npm run migration:check # se mexeu em entity
```
Atualize `docs/knowledge/*` quando a mudança alterar uma regra, um padrão ou uma integração.
