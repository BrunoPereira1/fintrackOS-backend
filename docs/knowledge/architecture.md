# Arquitetura — FinTrack OS Backend

Como o sistema é organizado e quais fronteiras não podem ser cruzadas. Guardião: subagente `architect`.

## Stack
NestJS 10 · TypeScript strict · TypeORM 0.3 + PostgreSQL 16 · Redis (cache-manager/Keyv, throttler, BullMQ) · Firebase Admin · nestjs-i18n · Swagger · Node 20.

## Camadas e responsabilidades

```
HTTP ─► Guards (Throttler global → AuthGuard → TierGuard) ─► Controller ─► Service ─► Repository (TypeORM) ─► Postgres
                                                                   │
                                                                   ├─► outros Services (via módulo exportado)
                                                                   ├─► Cache (TokenCacheService / CACHE_MANAGER)
                                                                   └─► Filas BullMQ (producer) ─► Processor (worker)
```

| Camada | Pode | Não pode |
|---|---|---|
| **Controller** | Validar entrada (DTO + pipes), extrair `@CurrentUser()`, chamar **um** service, mapear para `*ResponseDto`, definir status HTTP e Swagger | Regra de negócio, acesso a repositório, chamadas externas, montar query |
| **Service** | Regra de negócio, isolamento por `userId`, orquestrar repositórios do próprio módulo e services de outros módulos, lançar exceções HTTP do Nest | Ler `process.env` direto (use `ConfigService`/config), conhecer `Request`/`Response`, acessar repositório de entidade de **outro** módulo |
| **Calculadoras / funções puras** (ex.: `InstallmentCalculatorService`, `common/money.ts`) | Regra determinística sem I/O | Acessar banco, cache, relógio implícito (receba datas por parâmetro) |
| **Entity** | Mapeamento do schema | Lógica de negócio |
| **Processor (BullMQ)** | Trabalho assíncrono, idempotente, com retries | Responder HTTP; confiar que roda uma única vez |

## Módulos

Um módulo por domínio em `src/<dominio>/`. Dependências permitidas (seta = "importa"):

```
transactions ─► cards, installments(calculadora), invoices(InvoiceLedgerQuery + funções puras do calculator: D20/D24 sob a trava do cartão), contacts(só ContactMapper, função pura)
splits       ─► transactions, contacts
contacts     ─► (nenhum)                (não importa splits: evita ciclo)
cards        ─► invoices, installments  (installments: só o reagendamento D14, ver exceção abaixo)
invoices     ─► (nenhum)                (lê installments/transactions/credit_cards via DataSource — exceção de leitura)
installments ─► invoices                (InvoiceLedgerQuery: status derivado na listagem/consulta)
reports      ─► cards, invoices, installments(só installment-state.ts, função pura)  (lê transactions/installments/credit_cards/cost_splits/contacts/invoice_charges via DataSource — exceção de leitura; `?contactId=` é só filtro SQL, sem ContactsService — D28)
users        ─► TokenCacheModule
auth         ─► users, TokenCacheModule
ocr          ─► (fila) 🔜 transactions, notifications
health       ─► (TypeORM, Redis)
```

Regras:
- **Sem ciclos.** Se dois módulos precisam um do outro, extraia o pedaço comum (exemplo real: `TokenCacheModule` saiu de `auth` para `users` poder derrubar sessões).
- Módulo expõe **services**, nunca repositórios. Quem precisa de dado de outro domínio chama o service dele (ex.: splits valida a transação via `TransactionsService.findOne(id, userId)`).
- Exceção controlada: **visões de leitura agregada** (relatórios, fatura, resumo) podem usar `QueryBuilder` com joins entre tabelas de domínios diferentes, em um módulo/serviço de leitura dedicado, **sempre filtrando por `user_id`** e sem escrever nada.
- **`invoices`** (razão do cartão, spec 2026-11-24-modelo-de-pagamento): entities `InvoicePayment`/`InvoiceCharge`; `invoice-ledger.calculator.ts` (puro); `invoice-status.ts` (arquivo folha, sem entities); `InvoiceLedgerQuery` (leitura **em lote por usuário** via `DataSource`/`EntityManager` opcional: cartões + 3 consultas — parcelas de transações com cartão, encargos, pagamentos —, sempre `user_id`, inclui cartões arquivados; `today` opcional para o chamador usar um único "hoje" por requisição); `InvoiceEntriesService` (grava/remove pagamento e encargo recebendo `em` + cartão **já verificado e travado**). Não importa módulos de domínio; as entities referenciam `CreditCard` só com `@ManyToOne` (sem `@OneToMany` inverso em `CreditCard`, para não criar ciclo de arquivo). As rotas ficam em `cards` (`CardInvoicesController`).
- **Exceção registrada (D14)**: a escrita de datas em parcelas ao mudar `closingDay`/`dueDay` fica em `InstallmentsService.rescheduleOpenInvoices(em, cardId, userId, days, today)`, chamada por `CardsService.update` **sob a trava do cartão** e na mesma transação de banco. É a única escrita em `Installment` fora do agregado Transação: muda só `closing_date`/`due_date` (mantém o mês da fatura) de faturas não fechadas. Lê `transactions` (SQL parametrizado) só para filtrar por `card_id`/`user_id`. Permitido porque `installments` não importa `cards` (sem ciclo); se um dia `installments` precisar de `CardsService`/`lockOwned`, a orquestração fica em `cards`/`transactions`, nunca em `installments`.
- Recursos globais: `ConfigModule`, `CacheModule`, `ThrottlerModule`, `I18nModule`, `BullModule`, `AuthModule` (`@Global`, reexporta `TokenCacheModule`), `ClockModule` (`@Global`, provider `Clock`).

## Dados

- Schema muda **só** por migration (`synchronize: false`); entities espelham exatamente o schema (`npm run migration:check` no CI garante).
- Toda tabela de domínio tem `user_id` (direto ou via FK para uma tabela que tem) e índice nele.
- Escritas que tocam mais de uma tabela de forma interdependente usam **transação de banco** (`repo.manager.transaction`) — ex.: troca de parcelas ao editar uma transação.
- **Checagem + escrita sob concorrência**: invariantes que dependem de ler e depois gravar (Σ splits ≤ total, D20/D24) são verificadas **depois** de travar a(s) linha(s) pai, dentro da mesma transação de banco. Para a transação financeira, use `TransactionsService.runLocked(id, userId, (tx, em, card?) => ..., { lockCard? })` (FOR UPDATE + relações recarregadas após a trava); escreva com `em.getRepository(...)`. Leituras que embasam a decisão (ex.: razão via `InvoiceLedgerQuery.loadLedger(userId, cardId, em)`) usam o mesmo `em`.
- **Concorrência — ordem global de travas: cartão → transação.** Quem precisa das duas trava primeiro o cartão (`CardsService.lockOwned(em, id, userId)`: `FOR UPDATE` + 404/403) e depois a transação. Travam o cartão: pagamento/encargo (e desfazer), arquivar/reativar, edição do cartão (inclusive o reagendamento D14) e **toda escrita de compra no cartão**: `create` (`lockOwned` antes de gravar transação + parcelas) e `update`/`remove` via `runLocked(..., { lockCard: true })` — lê `card_id` sem trava, trava o cartão, trava a transação (FOR UPDATE, sem relations) e confere que o `card_id` não mudou (senão 409), depois recarrega as relações. Splits (criar, mudar status, remover) usam `runLocked` **sem** `lockCard` (só a transação): quem segura só a transação nunca espera pelo cartão, então não existe a ordem inversa; `update`/`remove` reabrem o split a partir da transação travada, então não correm com a exclusão da transação (409 de split pendente). Edição só de valor (D26) atualiza o `amount` das parcelas existentes pelo cascade do `save` da transação (mesmos IDs, datas intactas); só a mudança de data apaga e recalcula. O recálculo apaga as parcelas com `em.delete(Installment, { transactionId })` simples: os escritores concorrentes estão cobertos — pagamento/encargo de fatura e reagendamento D14 rodam sob a trava do cartão, e o PATCH de status só vale para órfã legada sem cartão, que nunca recalcula (422). Deadlock/serialização (SQLSTATE `40P01`/`40001`) → 409 `CONCURRENT_UPDATE` via `mapTransactionConflict` (`src/common/db-errors.ts`) em toda transação de banco aberta por `cards` (`CardsService`, `CardInvoicesService`) e `transactions` (`create` com cartão, `runLocked`). Comprovado em `test/concurrency.e2e-spec.ts` (pagamento × recálculo, arquivar × criar, D14 × criar, split → pendente × excluir transação, sem deadlock — cada um falha se a trava for removida).
- **Agregado Transação**: `TransactionItem` e `Installment` pertencem ao agregado `Transaction` — criados, trocados e removidos só via `TransactionsService`; o módulo installments apenas lê, muda status e (exceção D14) reagenda datas de faturas não fechadas.
- **Cartão nunca é apagado** (D12): `DELETE /cards/:id` arquiva (`archived_at`). As FKs `FK_invoice_payments_card`/`FK_invoice_charges_card` são `CASCADE` só para a exclusão do usuário.
- Datas de calendário em coluna `date` (string `YYYY-MM-DD` no driver); instantes em `timestamptz`.
- Exclusão: `ON DELETE CASCADE` a partir de `users`; relações opcionais `SET NULL`; relações que não podem sumir barram a remoção com FK `NO ACTION DEFERRABLE INITIALLY DEFERRED` (ex.: `FK_cost_splits_contact`), convertida em 409 com `isForeignKeyViolation`. **Não use `RESTRICT`** em FK para tabela que também é apagada em cascata a partir de `users`: a checagem imediata depende da ordem dos triggers (OID, que muda após dump/restore) e pode impedir a exclusão do usuário.

## Autenticação e sessão

1. `AuthGuard` (Passport `firebase`) → `FirebaseStrategy`:
   - nível 1: sessão em cache `auth:session:<sha256(token)>` (TTL ≤ 5 min e ≤ `exp` do token), validada contra a versão de sessão do usuário `auth:sessver:<uid>`;
   - senão `verifyIdToken(token, checkRevoked=true)`;
   - nível 2: perfil em cache `user:profile:<uid>` (10 min, não renovado na leitura);
   - fallback: banco (`findOrCreate`).
2. `TierGuard` + `@RequiresTier(plan)`.
3. Invalidação: `TokenCacheService.invalidateAllSessions(uid)` (troca a versão) — usada em logout, update de perfil, mudança de plano.

## Cache e Redis

- Chaves **sempre** via `CacheKeys` (`src/common/cache-keys.ts`) e TTL via `CacheTTL`.
- Cache é otimização: falha de cache **nunca** derruba a requisição (try/catch + log) — exceto rate limit de `/auth/*` (fail-closed, 503).
- Conexão Redis centralizada em `src/config/redis-connection.ts` (senha/TLS por env). DBs: cache, BullMQ, throttler (db 2).

## Configuração

- Tudo por variável de ambiente, lida via `ConfigService` ou funções de `src/config/*` (testáveis com `EnvReader`). Novo env → `.env.example` + `scripts/validate-env.sh` (se obrigatório em produção).
- `APP_TIMEZONE` (opcional, padrão `America/Sao_Paulo`): fuso único que define "hoje" nas regras de data; não depende do `TZ` do servidor.
- Produção: SSL do Postgres validando certificado, Swagger desligado, helmet, `TRUST_PROXY` conforme a infra.

## Observabilidade

- `Logger` do Nest por classe; logs com IDs, nunca dados pessoais.
- `GET /health/live` (processo) e `GET /health` (Postgres + Redis), públicos e sem throttle.

## Peças comuns
- `src/common/clock.ts` (`Clock`) + `src/common/clock.module.ts` (`ClockModule`, `@Global`, registrado no `AppModule`): fonte injetável de "hoje" (`YYYY-MM-DD`) no fuso `APP_TIMEZONE` (padrão `America/Sao_Paulo`), **independente do `TZ` do processo** — `Intl.DateTimeFormat` + `formatToParts`, formatter criado uma vez. O fuso é lido via `ConfigService` na factory do módulo; fuso inválido derruba o boot. Calculadoras recebem `today` por parâmetro. Testes com `Test.createTestingModule` que montam um módulo dependente de `Clock` importam `ClockModule` (junto do `ConfigModule` global) e, se precisarem de data fixa, `overrideProvider(Clock)`; unitários de service passam `{ provide: Clock, useValue }`.
- `src/auth/token-cache.module.ts`: módulo folha (só depende do `CACHE_MANAGER`), importado por auth e users.

## Decisões registradas (ADR curto)

| Decisão | Motivo |
|---|---|
| Firebase para identidade, Postgres para perfil/plano | Auth gerenciada; regras de plano ficam no nosso banco |
| Versão de sessão por usuário em vez de índice de tokens | O store Keyv não expõe SADD; versão é O(1) e invalida tudo de uma vez |
| Parcelas materializadas na criação | Fatura/resumo viram somas simples; edição de data recalcula atomicamente; edição só de valor redistribui os valores mantendo as parcelas (D26) |
| Um único "hoje" por requisição: o service lê `clock.today()` uma vez e repassa a `InvoiceLedgerQuery` (`today` opcional) e às calculadoras | Razão e regras não divergem na virada do dia (D19) |
| Enum usado por regra pura em arquivo folha `<nome>.enum.ts`, reexportado pela entity (`installment-status.enum.ts`, `payment-method.enum.ts`, `split-status.enum.ts`) | Calculadoras e `*-state.ts` sem importar entities (spec §5) |
| Vencida calculada na consulta até existir job | Evita status desatualizado sem infraestrutura de agendamento |
| Contato como entidade | Agrupamento confiável de "quem me deve" (decisão de 2026-11-22) |
| FK de referência obrigatória como `NO ACTION DEFERRABLE INITIALLY DEFERRED` (ex.: `FK_cost_splits_contact`) | RESTRICT é imediato e falha na exclusão em cascata do usuário conforme a ordem dos triggers; diferida checa no COMMIT. Contrato: o `remove()` precisa comitar a própria transação para o 23503 virar 409 |
| Relatórios em SQL de leitura (`DataSource` + `getRawMany`) com datas via `to_char` | Agregação entre domínios sem acoplar services; evita o fuso do driver pg em colunas `date`. Nomes de tabela literais são cobertos pelos e2e |
| Trava pessimista na transação financeira (`runLocked`) | Corrida real comprovada em e2e: sem trava, 4 splits de R$ 30 entraram numa compra de R$ 100 |
| Rebaixado lê, paga fatura (D8) e marca paga só parcela órfã legada (D18) | Não perder acesso ao próprio histórico nem impedir registrar pagamentos (decisão de 2026-11-22; parcela de cartão é paga pela fatura desde a spec 2026-11-24) |
| Razão do cartão (ledger) derivado na consulta: pagamentos são **da fatura** e alocados em FIFO; status de parcela/fatura calculados, não gravados (spec 2026-11-24 §2/§5) | Rotativo, pagamento parcial e crédito sem estado duplicado; compra retroativa ou exclusão realoca sozinha. `installments.status` só vale para órfãs legadas (D18) |
| Carga do razão **em lote por usuário** (`InvoiceLedgerQuery`, cartões + 3 consultas) | Listagem de cartões com limite disponível sem N+1 |
| `GET /installments?status=` filtra e pagina **no SQL**: o razão vira, por cartão, o limiar da última parcela totalmente coberta (as cobertas são prefixo da ordem FIFO) + os meses de fatura vencidos (`listingCoverage`), comparados com tipos nativos (`date`, `timestamptz`, `uuid`, `int`) | Página e `total` corretos sem materializar a lista inteira no service; e2e compara o status do SQL com o da calculadora e falha se o limiar mudar |
| Visões que combinam razão + linhas descritivas (fatura, resumo, "quem me deve", listagem de parcelas) leem num snapshot `REPEATABLE READ` | Razão e linhas enxergam o mesmo estado mesmo com pagamento/compra concorrente (sem parcela "fora do razão") |
| Timestamps de ordenação entram na calculadora só como `YYYY-MM-DDTHH:MM:SS.ffffffZ` (gerados no SQL com `to_char(... AT TIME ZONE 'UTC', ...)`) | Ordem FIFO estável sem depender do fuso do driver; formato errado é erro de programação (D25) |
| Cada parcela grava `closing_date` (D14); mudar os dias do cartão reagenda só faturas não fechadas, sob a trava do cartão | Fatura fechada não muda de data; backfill = última ocorrência do `closing_day` atual estritamente antes do vencimento (C5) |
| Cartão arquivado em vez de apagado (D12) | Histórico, faturas, saldo e pagamentos continuam; FK CASCADE só para exclusão do usuário |
| `cards ─► installments` só para o reagendamento D14 (`InstallmentsService.rescheduleOpenInvoices` com o `em` do chamador) | Escrita de datas sob a trava do cartão, na mesma transação, sem criar ciclo; `installments` nunca importa `cards` |
| Ordem global de travas cartão → transação (`runLocked({ lockCard })`, `create` com `lockOwned`); 40P01/40001 → 409 | Evita deadlock entre pagamento/arquivamento/D14 e criação/edição/exclusão de compra e torna D20/D24/arquivado/D14 consistentes sob concorrência (e2e com prova de mutação); quando acontecer conflito, o cliente tenta de novo |
| "Hoje" no fuso da aplicação (`APP_TIMEZONE`, padrão `America/Sao_Paulo`) via `ClockModule` global, independente do `TZ` do processo | Datas de vencimento/fatura/pagamento não podem depender da configuração do servidor; fuso inválido derruba o boot (fail-closed) em vez de calcular datas erradas (spec 2026-11-24, D19) |
