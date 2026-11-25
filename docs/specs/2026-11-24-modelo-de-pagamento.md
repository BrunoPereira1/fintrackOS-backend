# Spec — Modelo de pagamento (forma de pagamento, rotativo, limite)

> Status: **implementada (fases 1–4)** — v3 aprovada pelo usuário; v2 revisada por `business-rules` (bloqueios C1–C6 decididos) e `architect`. Lacunas L1/L2 e a regra de filtros decididas pelo usuário no fechamento da fase 4 (D26–D28).

## 1. Decisões de produto

| # | Decisão |
|---|---|
| D1 | Formas: `credit_card`, `pix`, `cash`, `debit`, `transfer`, `boleto`. Exceto `credit_card`, todas são **à vista, pagas na data da compra** (débito não referencia cartão; boleto sem vencimento futuro). |
| D2 | Fatura aceita **pagamento parcial (rotativo)**; saldo não pago vai para a fatura seguinte; pagamento a maior vira **crédito**. |
| D3 | **Encargos** (juros/IOF/multa/mora) **informados pelo usuário** como lançamento numa fatura. O app não calcula. |
| D4 | Pagamento é **da fatura**. Parcela de cartão não é marcada paga individualmente (`PATCH /installments/:id` vale só para órfãs legadas — D18; parcela de cartão → 422). |
| D5 | **Alocação em ordem (FIFO)**: o total pago quita a dívida mais antiga primeiro — por mês de fatura; dentro do mês, **parcelas pela ordem de lançamento** (`transactions.created_at`, id da transação, número) e **encargos por último** (`created_at`, id). Uma parcela está **paga** quando o total pago cobre tudo até ela. (C1/C2: lançamento novo — compra retroativa ou encargo — nunca desloca a cobertura do que já estava pago no mesmo mês.) |
| D6 | Vencida **calculada na consulta** (sem job): parcela não coberta com `due_date < hoje`. |
| D7 | Data do pagamento informada, padrão hoje, **≤ hoje**. Pagamento com data após o vencimento da fatura em que foi lançado é aceito e marcado **`paidLate`**. |
| D8 | Desfazer pagamento (apagar o lançamento) permitido. Pagamento, desfazer e **lançar/remover encargo**: **qualquer plano** (exceção explícita ao "rebaixado não cria" — sem isso o razão do rebaixado fica errado). |
| D9 | Pagamento/encargo só em fatura **já fechada** ou na **fatura aberta atual** (a primeira com fechamento > hoje). Mês além disso → 422. |
| D10 | "Saldo anterior" só aparece numa fatura depois que a anterior **venceu** (evita pagar em dobro). |
| D11 | Limite disponível = `creditLimit − max(dívida em aberto, 0)` (nunca acima do limite) + campo `credit` separado. `creditLimit = 0` → `null`. Em `GET /cards`. |
| D12 | Remover cartão = **arquivar** (sai das listas, não aceita compra nova; histórico, fatura, saldo e pagamentos continuam; pode ser reativado). Sem exclusão física. |
| D13 | Compra/edição em fatura **já fechada ou paga é permitida** (a fatura recalcula; saldo rola). Excluir compra já coberta **realoca** o valor para a próxima dívida; só sobra crédito se não houver dívida. |
| D14 | Cada parcela grava suas datas de fechamento e vencimento. Mudar `closingDay`/`dueDay` do cartão **ajusta as parcelas de faturas ainda não fechadas** (`closing_date > hoje`): mantêm o **mês da fatura** e recebem as novas datas daquele mês; faturas fechadas mantêm as datas (C4). |
| D15 | Sem cartão e sem forma informada → `pix` (compatibilidade). |
| D16 | Resumo mensal continua por **vencimento** (caixa devido) + encargos do mês (`cardCharges`, entram em `spent`) + total informativo `paidInMonth`. |
| D17 | Mês sem parcelas nem encargos segue as datas (`open`/`closed`), nunca `paid`. |
| D18 | Legado: transação antiga sem cartão → forma `null`; parcelas `paid` de cartão existente → um **pagamento de fatura** por (cartão, mês) com `paid_on NULL` (o FIFO só preserva exatamente o status legado quando as pagas formavam um prefixo — perda aceita, dados de desenvolvimento); parcelas de cartão **já removido** (órfãs) **mantêm o status gravado** e continuam podendo ser marcadas paga/pendente por `PATCH /installments/:id` (C6) — para parcela de cartão esse PATCH retorna 422. |
| D19 | Fuso único `APP_TIMEZONE` (padrão `America/Sao_Paulo`). "Quitar compra" (antecipação) fica fora desta fase. |
| D20 | **Edição de valor/data de compra no cartão** (P4, C3): bloqueada (422) somente se alguma parcela da compra **coberta (total ou parcialmente) estiver numa fatura já fechada** (`closing_date ≤ hoje`). Antes do fechamento edita livremente (o pagamento só se realoca). Vale também para cartão arquivado. Valor sem data: D26; data: recálculo + D24/D27. |
| D21 | Parcela parcialmente coberta expõe `coveredAmount`/`remainingAmount`; totais de parcelas no resumo são **por valor** (coberto / não coberto / não coberto vencido), não por contagem de status. |
| D22 | Faturas passadas refletem a **cobertura atual** (não são extrato histórico imutável). `paidLate` é informativo e relativo à fatura em que o pagamento foi lançado. `paidOn` sem limite inferior (≤ hoje). `paidInMonth` ignora pagamentos legados (`paid_on NULL`). |
| D23 | Resumo: `cardCharges` entra em `spent` e em `byCard`; **não** entra em `byCategory` (Σ byCategory = spent − cardCharges). |
| D24 | Edição da **data** de compra no cartão também é bloqueada (422) se alguma parcela **recalculada** cair numa fatura **já fechada** (`closing_date ≤ hoje`) — D24 protege o **destino**. Tirar parcela **não coberta** de fatura fechada é permitido (D27). |
| D25 | "Fatura fechada" e "vencida" usam sempre as **datas da fatura** (`invoiceDatesOf`: datas gravadas do mês, maior em caso de divergência), nunca as da parcela isolada — vale para D9, D20, D24 e o status da parcela. Timestamps de ordenação (D5) entram na calculadora **exclusivamente** como `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC, microssegundos, gerado no SQL com `to_char(... AT TIME ZONE 'UTC', ...)`); outro formato → erro. |
| D26 | (L1) Edição **só de valor** de compra no cartão (sem mudar `date`): as parcelas **mantêm** mês, `closing_date` e `due_date` gravados; só os **valores** são redistribuídos (floor em centavos, resto na última — mesma regra da criação, `splitCents`). Nunca muda de fatura por edição de valor (nem com dias do cartão alterados depois da compra — D14), então D24 não se aplica. D20 continua valendo. Mudança de **data** recalcula pelos dias atuais (com D24). |
| D27 | (L2) Mudança de data que **tira** parcela **não coberta** de fatura fechada é permitida: D20 protege o que está coberto em fatura fechada; D24 protege o destino; parcela não coberta pode sair de fatura fechada (a fatura recalcula — D13). |
| D28 | **Filtros por id na query string** (`?cardId=`, `?contactId=`, `?transactionId=`): id inexistente ou de outro usuário → **resultado vazio** (lista vazia / totais zerados), nunca 404/403 — não revela existência. 404/403 só para o recurso da rota. (IDs no body seguem as regras já existentes: `contactId`/`itemId` de split → 400 genérico; `cardId` da transação e `transactionId` do split → 404/403.) |

## 2. Razão do cartão (ledger) — regras

Para um cartão (todos os valores em centavos):

- **Itens de dívida** (ordem FIFO): para cada mês de fatura `M` (mês do vencimento) em ordem crescente, primeiro as **parcelas** de `M` (por `transactions.created_at`, id da transação, número), depois os **encargos** de `M` (por `created_at`, `id`).
- `debt(item)` = valor; `cum(item)` = soma acumulada até o item, na ordem.
- `P` = Σ de **todos** os pagamentos do cartão (o mês em que foi lançado não altera a alocação).
- **Item coberto** ⇔ `cum(item) ≤ P`. Parcela paga = parcela coberta.
- `outstanding = max(Σ debt − P, 0)`; `credit = max(P − Σ debt, 0)`.

**Visão da fatura `M`** (datas: `closingDate`/`dueDate` gravadas nas parcelas de `M`; sem parcelas, calculadas pelos dias atuais do cartão):
- `installmentsTotal`, `chargesTotal`, `payments` (lançados em `M`, com `paidOn`, `paidLate`).
- `remaining(M)` = Σ itens de `M` não cobertos (parcialmente coberto conta só a parte não coberta).
- `previousBalance(M)` = `dueDate(M−1) < hoje` ? Σ `remaining(K)` para todo `K < M` : 0.
- `amountDue(M)` = `previousBalance(M) + remaining(M)`.
- **Status** (precedência nesta ordem):
  1. `paid` — `M` tem itens e todos cobertos;
  2. `open` — `hoje < closingDate`;
  3. `closed` — `closingDate ≤ hoje ≤ dueDate`;
  4. `partially_paid` — `hoje > dueDate` e algum item de `M` coberto (total ou parcial);
  5. `unpaid` — `hoje > dueDate` e nenhum item coberto (saldo rolou).
- Parcela: `paid` (totalmente coberta) | `overdue` (não totalmente coberta e `due_date < hoje`) | `pending`; com `coveredAmount`/`remainingAmount` (D21). Fatura expõe `coveredAmount` (Σ coberto dos seus itens).
- Mês **sem itens**: `open`/`closed` pelas datas; após o vencimento, `unpaid` se `previousBalance > 0`, senão `closed` (D17).
- Órfãs legadas (transação sem cartão com parcelas) ficam **fora** do razão; status = gravado (D18).
- Invariantes testados: `Σ remaining(todos os meses) == outstanding`; a parte coberta forma um **prefixo** da ordem; `Σ coberto + credit == P`; se `previousBalance(M) > 0` nenhum item de `M` está coberto.

## 3. Modelo de dados (migration única de expansão)

**transactions**: `payment_method` enum `transactions_payment_method_enum`, nullable (D18). `@Check('CHK_transactions_payment_method_card', "card_id IS NULL OR payment_method = 'credit_card'")` — criado **depois** do backfill (`credit_card` onde há `card_id` ou parcelas). Regras no service: com `cardId` ⇒ `credit_card` (outro valor → 422); sem `cardId` ⇒ padrão `pix`, `credit_card` → 422; edição só entre formas à vista.

**credit_cards**: `archived_at timestamptz NULL`. Listagem ignora arquivados (`?includeArchived=true` para vê-los); compra nova em cartão arquivado → 422.

**installments**: `closing_date date` NOT NULL após backfill = **última ocorrência do `closingDay` atual do cartão estritamente antes de `due_date`** (C5: nunca ≥ vencimento); órfãs: `due_date` menos 1 mês. A coluna `status` **permanece** e passa a valer **só para parcelas órfãs legadas** (D18); para cartão o status é derivado. Remoção definitiva fica para uma migration futura (contract), se um dia não houver órfãs.

**invoice_payments**: `id`, `user_id` (`FK_invoice_payments_user` CASCADE, `IDX_invoice_payments_user_id`), `card_id` NOT NULL (`FK_invoice_payments_card` CASCADE — só dispara na exclusão do usuário, já que cartão é arquivado), `invoice_month char(7)` (`CHK_invoice_payments_month_format` `^[0-9]{4}-(0[1-9]|1[0-2])$`), `amount decimal(12,2)` (`CHK_invoice_payments_amount_positive`), `paid_on date NULL` (null só legado), `created_at timestamptz`. `IDX_invoice_payments_card_month`.

**invoice_charges**: idem com prefixo `invoice_charges`, `description varchar(255) NULL` (dado do usuário: nunca em log).

Backfill legado de pagamentos (D18): `INSERT ... SELECT c.user_id, t.card_id, to_char(i.due_date,'YYYY-MM'), SUM(i.amount), NULL FROM installments i JOIN transactions t ... JOIN credit_cards c ON c.id = t.card_id AND c.user_id = t.user_id WHERE i.status = 'paid' GROUP BY ...` (`overdue` gravado conta como não pago). `down()`: remove tabelas/colunas/check/enum novos (status legado intacto). Não recupera pagamentos criados depois da migration (documentado).

## 4. API

| Método | Rota | Plano | Notas |
|---|---|---|---|
| POST | `/cards/:cardId/invoices/:month/payments` | qualquer | `{ amount, paidOn? }` → 201 (D7, D9) |
| DELETE | `/cards/:cardId/invoices/:month/payments/:id` | qualquer | 204 |
| POST | `/cards/:cardId/invoices/:month/charges` | qualquer | `{ amount, description? }` → 201 (D9) |
| DELETE | `/cards/:cardId/invoices/:month/charges/:id` | qualquer | 204 |
| DELETE | `/cards/:id` | intermediate | **arquiva** (204) |
| POST | `/cards/:id/restore` | intermediate | reativa |
| GET | `/cards` (`?includeArchived`), `/cards/:id` | qualquer | `+ availableLimit`, `credit`, `outstanding`, `archivedAt` |
| GET | `/reports/cards/:cardId/invoices/:month` | qualquer | **muda** (§2): `previousBalance`, `installmentsTotal`, `chargesTotal`, `charges[]`, `payments[]`, `remaining`, `amountDue`, `status`, itens com status derivado |
| GET | `/installments?status=` | qualquer | filtro pelo status derivado (no SQL); `?cardId=` alheio/inexistente → lista vazia (D28) |
| PATCH | `/installments/:id` | qualquer | **só parcela órfã legada** (sem cartão); parcela de cartão → 422 (D18) |
| POST/PATCH | `/transactions` | como hoje | `paymentMethod` (D1, D15) |
| GET | `/reports/monthly-summary/:month` | basic | **muda**: `pixOrCash` → `totals.upfront` + `byPaymentMethod` (+ `null` = não informada — fase 1); `totals.cardCharges`, `paidInMonth`, `installments` por valor (D21); parcelas derivadas (fase 4) |
| GET | `/reports/receivables` | premium | progresso de parcelas derivado; `?contactId=` alheio/inexistente → resultado vazio (D28) |

Breaking para o frontend: `PATCH /installments/:id` só para órfã legada (parcela de cartão → 422); fatura e resumo mudam de formato; DELETE de cartão vira arquivamento; `GET /reports/receivables?contactId=` de contato alheio/inexistente responde vazio em vez de 404/403.

## 5. Arquitetura

- **`invoices`** (sem dependências de domínio): entities `InvoicePayment`/`InvoiceCharge`; `invoice-ledger.calculator.ts` (puro, §2); `InvoiceLedgerQuery` (leitura via `DataSource`, **em lote por usuário** — cartões + 3 consultas, agrupadas por cartão —, sempre `user_id`, aceita `EntityManager` opcional); `InvoiceEntriesService` (grava/remove pagamento e encargo recebendo `em` + cartão **já verificado e travado**).
- **`cards`** orquestra escrita: `CardsService.lockOwned(em, id, userId)` (`FOR UPDATE` + 404/403); `CardInvoicesController` com as rotas de pagamento/encargo; arquivar/reativar; `availableLimit` via `InvoiceLedgerQuery`.
- **Grafo**: `invoices ─► (nenhum)`; `cards ─► invoices, installments` (só o reagendamento D14, registrado em architecture.md); `transactions ─► cards, installments, invoices, contacts(mapper)`; `installments ─► invoices`; `reports ─► cards, invoices, installments(installment-state, puro)` (`contacts` saiu com D28). Status derivado em arquivos folha (`invoice-status.ts`, `installment-state.ts`, `installment-status.enum.ts` — sem importar entities). `InvoiceLedgerQuery` aceita `today` do chamador (um único "hoje" por requisição).
- **Concorrência — ordem global: cartão → transação.** Pagamento/encargo/arquivar travam o cartão. `runLocked(id, userId, work, { lockCard: true })`: lê `card_id` sem trava, trava o cartão (`lockOwned`), trava a transação e confere. Usado em create/update/remove de transação com cartão. O recálculo (só quando a **data** muda — D26) deixa o delete condicional e passa a `em.delete(Installment, { transactionId })`; edição só de valor atualiza os valores das parcelas existentes; a regra D20 ("parcela coberta em fatura fechada?") é consultada **sob a trava do cartão**. Editar os dias do cartão (D14) ajusta parcelas de faturas não fechadas sob a mesma trava. Deadlock/serialização (40P01/40001) → 409 em `db-errors.ts`.
- **Clock**: `ClockModule` global com `ConfigService`; `APP_TIMEZONE` validado no boot (`Intl.DateTimeFormat(..., { timeZone })` lança → boot falha); `formatToParts`; formatter criado uma vez. `.env.example` + `validate-env.sh` (opcional).

## 6. Fases

Todas concluídas.

1. ✅ **Forma de pagamento** (migration própria) + resumo `byPaymentMethod` — paralela.
2. ✅ **ClockModule + `APP_TIMEZONE`** — paralela.
3. ✅ **Calculadora do ledger** (pura, FIFO, visão da fatura, status, credit, limite) com testes exaustivos — paralela.
4. ✅ **Entrega única** (depende de 1–3): migration de expansão; `invoices` (query + entries); `cards` (lockOwned, rotas, arquivar, limite); `runLocked` com cartão + P4 + criação travada; consumidores (fatura, resumo, receivables, listagem de parcelas); PATCH de parcela restrito a órfãs; e2e de concorrência. Fechamento: D26–D28, um único "hoje" por requisição, splits `update`/`remove` sob a trava da transação.
5. Guardiões sobre o diff + docs (`business-rules` §1/§4/§5/§7/§9, `architecture` grafo/ADR, `integrations` env de fuso) — em cada fase, não no fim.

## 7. Testes essenciais

**Ledger**: pagamento integral; parcial (rola); excedente (crédito); encargo em fatura quitada (só o encargo fica descoberto); compra nova **e retroativa** em fatura já paga (só ela fica descoberta no mês); compra nova com crédito existente (nasce coberta); exclusão de compra coberta com dívida posterior (realoca); parcela parcialmente coberta (`coveredAmount`, totais por valor); mês vazio após vencimento com saldo anterior (`unpaid`); invariantes de prefixo e `Σ coberto + credit == P`; pagamento lançado em fatura posterior quita a anterior em aberto; meses vazios no meio; `previousBalance` antes/depois do vencimento da anterior; status em cada fronteira (véspera/dia do fechamento, dia do vencimento, dia seguinte) com `dueDay < closingDay`, `>` e `==`; virada de ano; `partially_paid` vs `unpaid` (inclusive crédito vindo de antes); `Σ remaining == outstanding`; centavos (33,33×3 + 0,01); limite nunca acima de `creditLimit`; `creditLimit = 0` → `null`.
**Pagamento/encargo**: mês além da fatura aberta atual → 422; `paidOn` futuro → 400 (inclusive 23h30 SP = 02h30 UTC); `paidLate`; cartão de outro usuário → 404/403; desfazer de outro cartão → 404; rebaixado basic paga e lança encargo.
**Migration**: legado pago → pagamento agregado `paid_on NULL`; legado fora de prefixo; órfãs mantêm status e aceitam PATCH; `closing_date` backfill sempre < `due_date` mesmo com dias do cartão alterados; check criado após backfill; `down()`; `migration:check` sem drift.
**Concorrência (e2e)**: pagamento × recálculo; dois pagamentos simultâneos; arquivar × criar compra; criar/editar compra com cartão sem deadlock.
**Forma de pagamento**: validações cruzadas; edição à vista↔à vista; `credit_card` sem cartão → 422; legado `null` no resumo.
**Cartão**: arquivado some da lista, aparece com `includeArchived`, rejeita compra nova, aceita pagamento e edição de compra existente, reativa; editar `closingDay`/`dueDay` ajusta só parcelas de faturas não fechadas (mantendo o mês). **Edição de compra (D20)**: coberta em fatura aberta → permitida; coberta em fatura fechada → 422. **D26**: só valor mantém mês/datas gravados (inclusive com dias alterados) e redistribui com resto na última. **D27**: nova data tira parcela não coberta de fatura fechada → permitido.
**Filtros (D28)**: `?cardId=` (transações, parcelas), `?contactId=` (receivables), `?transactionId=` (splits) com id alheio ou inexistente → vazio.
**Splits × exclusão da transação (e2e)**: voltar split para pendente × excluir → nunca os dois (409 ou 404), sem 500.
