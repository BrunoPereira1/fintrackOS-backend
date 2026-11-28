# Regras de negócio — FinTrack OS

Fonte única das regras de produto. Toda mudança de comportamento financeiro **atualiza este arquivo no mesmo PR**. Regras marcadas com 🔜 estão decididas mas ainda não implementadas.

Guardião: subagente `business-rules`.

---

## 1. Usuários e planos

- Todo dado financeiro pertence a **um** usuário (`user_id`). Nenhum usuário lê, altera ou referencia dado de outro — inclusive por IDs vindos no body (ex.: `cardId`, `itemId`, `contactId`).
- **IDs de outro usuário nunca são revelados** (D28). A resposta depende de onde o ID vem:
  - **recurso da rota** (`/x/:id`): inexistente → 404, de outro usuário → 403 (ou 404 quando a posse é checada por join, como em parcelas e splits);
  - **filtro de listagem na query string** (`?cardId=`, `?contactId=`, `?transactionId=`): inexistente ou de outro usuário → **resultado vazio** (lista vazia, totais zerados), nunca 404/403;
  - **referência no body** (D30): inexistente ou de outro usuário → **400 genérico**, sem distinguir os dois casos — `contactId`/`itemId` de split, `cardId` em `POST /transactions` (`Invalid card`) e `transactionId` em `POST /splits` (`Invalid transaction`). A checagem de posse vem antes de qualquer outra regra sobre a referência (ex.: cartão alheio **e** arquivado → 400, nunca o 422 `CARD_ARCHIVED`, que revelaria o estado). A checagem de plano, que independe do ID, continua antes.
- Planos em ordem crescente: `basic` < `intermediate` < `premium`. Um plano satisfaz todos os de nível menor (`hasRequiredPlan` em `src/auth/plan-access.ts`). Usuário sem plano = `basic`.

| Recurso | Plano mínimo |
|---|---|
| Transações sem cartão | basic |
| Criar/editar/arquivar/reativar cartões, transação com `cardId`, investimentos (assets) | intermediate (ler cartões e parcelas e marcar paga/pendente parcela **órfã legada** — D18: qualquer plano, sobre o que já existe) |
| Pagar fatura, desfazer pagamento, lançar/remover encargo (`/cards/:cardId/invoices/:month/payments` e `.../charges`) | **qualquer plano** — exceção explícita ao "rebaixado não cria" (D8): sem isso o razão do rebaixado fica errado |
| Criar/remover splits; criar/editar/remover contatos; "quem me deve" | premium (ler splits/contatos e marcar split recebido: qualquer plano, sobre o que já existe) |
| OCR de nota fiscal 🔜 | premium |
| Fatura do cartão (`GET /reports/cards/:cardId/invoices/:month`) | sem plano mínimo na rota (só existe para quem tem cartão — criado em intermediate; rebaixado lê) |
| Resumo mensal (`GET /reports/monthly-summary/:month`) | basic (inclui tudo o que o usuário tem, inclusive parcelas de cartões criados em plano anterior; "a receber" só para premium) |

- **Usuário rebaixado** (abaixo do plano de um recurso que já usou): **lê** o que já criou (cartões, parcelas, fatura, contatos, splits — inclusive splits em `GET /transactions/:id`) e **muda status** (marcar parcela órfã legada paga/pendente, split recebido). **Não cria, não edita outros campos e não remove** recursos do plano perdido. Exceção (D8): **pagar fatura, desfazer pagamento e lançar/remover encargo** valem para qualquer plano. Exceções: "quem me deve" e `receivablesPending` do resumo continuam premium (403 / `null`). Transações em si são basic: o rebaixado edita e exclui normalmente (sem vincular cartão novo).
- Mudança de plano ou de perfil derruba as sessões em cache do usuário (vale na próxima requisição).

## 2. Documento (CPF/CNPJ/passaporte)

- Armazenado normalizado: só dígitos (CPF/CNPJ) ou maiúsculas (passaporte); validado por `common/validators/document.validator.ts`.
- Único entre usuários. Documento já usado → **400 genérico** `Document cannot be used` (nunca revelar que pertence a outra conta). No cadastro, a checagem acontece **antes** de criar a conta no Firebase.

## 3. Valores monetários

- Moeda única (BRL), 2 casas decimais. Toda soma/comparação é feita em **centavos inteiros** (`toCents`/`sumCents` em `src/common/money.ts`). Colunas `decimal` chegam do Postgres como string.
- Valores de compra, item e split são sempre positivos (`> 0`, item pode ser `>= 0`). Parcela: `> 0` — **D29**: total em centavos **menor que o número de parcelas** (geraria parcelas de R$ 0,00, ex.: R$ 0,02 em 3x) → 422 `TOTAL_LESS_THAN_INSTALLMENTS`, na criação **e** na edição de `totalAmount` (D26 ou com data). É checado antes da posse do cartão (não depende do ID, não revela nada) e, na edição, antes de `CARD_REQUIRED_FOR_RECALC`/D20/D24. Edição **só de data** de compra antiga que já esteja nesse estado não é bloqueada (regenera as parcelas como estavam). Como `installmentsCount` é imutável, para reduzir as parcelas o usuário exclui e recria a compra. Transações que já estejam nesse estado continuam legíveis (parcela de R$ 0,00 de cartão aparece coberta pelo razão; órfã legada de R$ 0,00 segue o status gravado, D18).
- "Hoje" (fatura fechada/vencida, D9, D20, D24, `paidOn`, status) é sempre a data de calendário no fuso `APP_TIMEZONE` (padrão `America/Sao_Paulo`, D19), nunca o do servidor.

## 4. Transações

- Uma transação é uma compra/gasto com `totalAmount`, `date` (data de calendário **exatamente** `YYYY-MM-DD`, sem hora nem fuso — outro formato é 400), `type` (`fixed` | `variable`), `category` livre e `cardId` opcional. `installmentsCount`, quando enviado, é inteiro de 1 a 48 (com ou sem cartão; >1 sem cartão é 422).
- **Itens**: se a transação tem itens, `Σ quantidade × preço unitário == totalAmount` (em centavos), senão 422. Sem itens, não há validação.
  - ⚠️ Não há representação de desconto/frete. Revisar antes do OCR de NF-e (provável campo `discount`).
- **Forma de pagamento** (`paymentMethod`): `credit_card`, `pix`, `cash` (dinheiro), `debit`, `transfer`, `boleto`. Só `credit_card` gera parcelas e entra em fatura; as demais são **à vista, pagas na data da compra** (débito não referencia cartão; boleto sem vencimento futuro).
  - Com `cardId`: a forma é sempre `credit_card` (omitida ⇒ `credit_card`; outra forma → 422 `CARD_REQUIRES_CREDIT_CARD_METHOD`).
  - Sem `cardId`: omitida ⇒ `pix` (compatibilidade); `credit_card` → 422 `CREDIT_CARD_METHOD_REQUIRES_CARD`. Sem cartão não pode ter `installmentsCount > 1` (422).
  - O banco garante `card_id IS NULL OR payment_method = 'credit_card'` (`CHK_transactions_payment_method_card`). Compra de cartão removido fica com `cardId` nulo e continua `credit_card` (mantém as parcelas).
  - **Legado**: transações anteriores à forma de pagamento com cartão ou parcelas viraram `credit_card`; as demais ficaram com forma `null` ("não informada" — não dá para saber se foi pix ou dinheiro).
  - **Edição** (PATCH `paymentMethod`, sob a trava da transação): só **entre formas à vista**. De/para `credit_card` → 422 `PAYMENT_METHOD_CHANGE_NOT_ALLOWED` (compra de cartão, inclusive de cartão removido ou com parcelas, não troca de forma). Legado `null` sem cartão e sem parcelas pode receber uma forma à vista. Reenviar a mesma forma não é troca.
- `cardId`, `installmentsCount` e `items` **não podem ser alterados** após a criação.
- **Listagem** (`GET /transactions`): filtro `?cardId=` de cartão inexistente ou de outro usuário → lista vazia (D28).
- **Exclusão** bloqueada (409) enquanto houver split `pending` (alguém ainda deve parte dela); splits pagos não bloqueiam e são apagados junto.
- **Compra nova no cartão**: criada sob a trava do cartão. Cartão **arquivado** → 422 `CARD_ARCHIVED` (D12). As parcelas saem com `closingDate`/`dueDate` pelos dias **atuais** do cartão, exceto em mês com datas gravadas por fatura (D31/D32, §5). Compra nova (inclusive retroativa) pode cair em fatura já fechada ou paga (D13: a fatura recalcula, o saldo rola) — D24 vale só para **edição** de data.
- **Concorrência**: edição, exclusão e criação de splits de uma mesma transação são serializadas (trava na transação). Compra no cartão (criar, editar, excluir) também trava o **cartão**, antes da transação (ordem cartão → transação): pagamento/encargo de fatura, arquivar e mudar os dias do cartão (D14) nunca correm no meio — ou a operação vê o pagamento/arquivamento/novos dias, ou eles veem o resultado dela. Conflito de banco (deadlock/serialização) → 409 `CONCURRENT_UPDATE` (o cliente tenta de novo).
- **Edição de `totalAmount` ou `date`** numa transação com parcelas (compra no cartão):
  - **D20**: bloqueada (422 `PURCHASE_COVERED_IN_CLOSED_INVOICE`) **somente** se alguma parcela da compra **coberta pelo pagamento (total ou parcialmente)** estiver numa fatura **já fechada** (`closingDate ≤ hoje`, pelas datas da fatura — D25). Coberta em fatura ainda aberta, ou em fatura fechada sem cobertura, edita livremente (o pagamento se realoca — D13);
  - **D26 — só valor** (sem mudar `date`): as parcelas **mantêm** mês, `closingDate` e `dueDate` gravados; só os **valores** são redistribuídos (mesma regra da criação: `floor` em centavos, resto na última — §5). Edição de valor **nunca muda a parcela de fatura** (nem se os dias do cartão mudaram depois da compra — D14), então D24 não se aplica;
  - **data** (com ou sem valor): as parcelas são **recalculadas** (mesmo número de parcelas, dias **atuais** do cartão) e substituídas atomicamente, sujeitas a D24;
  - **D24**: mudança de **data** bloqueada (422 `PURCHASE_DATE_IN_CLOSED_INVOICE`) se alguma parcela **recalculada** cair numa fatura já fechada;
  - **D27**: mudança de data que **tira** parcela **não coberta** de fatura fechada é permitida — D20 protege o que está coberto em fatura fechada; D24 protege o destino; parcela não coberta pode sair de fatura fechada (a fatura recalcula, D13);
  - bloqueada (422) se o cartão foi removido antes do arquivamento (`cardId` nulo — órfã legada, D18);
  - cartão **arquivado** edita normalmente (D12);
  - as regras são checadas sob a trava do cartão, com o razão lido na mesma transação de banco.
- **Excluir compra no cartão** (sob a trava do cartão): permitido mesmo coberta; o valor pago **realoca** para a próxima dívida do cartão, e só vira `credit` se não houver dívida (D13).
- Novo `totalAmount` precisa bater com os itens e não pode ficar abaixo da soma dos splits.

## 5. Cartões, faturas e parcelas

- Cartão: `closingDay` e `dueDay` entre 1 e 28 (evita meses curtos), `creditLimit >= 0`.
- **Toda compra no cartão gera parcelas** — à vista = 1 parcela. Máximo 48.
- **Fatura da compra** ("melhor dia de compra", como os bancos):
  - compra **até a véspera** do `closingDay` → fatura que fecha no mês da compra;
  - compra **no dia do fechamento ou depois** → fatura que fecha no mês seguinte.
  - **D32** (regra geral, respeitando as datas gravadas): a compra entra na **primeira fatura** (em ordem de mês, a partir do mês da compra) cujo **fechamento efetivo** é **depois** da data da compra — fechamento efetivo = o gravado por fatura (D31), senão o dos dias atuais do cartão. Sem datas gravadas, é exatamente a regra acima. Ex.: cartão mudou de "fecha 25" para "fecha 28"; 2026-12 gravada com fechamento 25/11; compra de 27/11 → 2027-01. Ex.: dias novos "fecha 20"; 2026-12 gravada com fechamento 25/11; compra retroativa de 22/11 → **2026-12** (fechada: permitido na criação — D13; na edição de data, D24 bloqueia). Vale na criação e no recálculo por mudança de data (D24 continua valendo para o resultado). Parcelas seguintes: +1 mês cada.
  - Parcela em mês com datas gravadas (D31) recebe **essas** datas; nos demais meses, as dos dias atuais do cartão.
- **Vencimento da fatura**: o primeiro `dueDay` depois do fechamento — mesmo mês do fechamento se `dueDay > closingDay`, senão mês seguinte (ex.: fecha 25, vence 5).
- Parcela N vence N−1 meses depois da primeira.
- **Valor das parcelas**: `floor(total / n)` em centavos; a diferença vai para a **última** parcela. Σ parcelas == total, sempre (na criação e na edição só de valor — D26).
- **Datas gravadas na parcela** (D14): cada parcela grava `closing_date` (fechamento da sua fatura) e `due_date`. Compra nova calcula as duas pela regra acima (o fechamento é sempre anterior ao vencimento). Parcelas anteriores receberam, na migration, a **última ocorrência do `closingDay` atual do cartão estritamente antes do vencimento** (nunca `closing_date >= due_date`, mesmo se os dias do cartão mudaram depois da compra); órfãs (sem cartão), `due_date − 1 mês`.
- **Mudar `closingDay`/`dueDay`** (D14, `PATCH /cards/:id`, sob a trava do cartão): as parcelas desse cartão em faturas **ainda não fechadas** (fechamento da fatura — a maior data gravada do mês — depois de hoje) **mantêm o mês da fatura** (mês do vencimento) e recebem as datas daquele mês pelos novos dias. Faturas fechadas mantêm as datas (C4) — e mês com datas gravadas por fatura (D31) nunca é reagendado. Se a nova data de fechamento já tiver passado, aquela fatura passa a contar como fechada.
- **D31 — datas gravadas por fatura** (`card_invoice_dates`: cartão, mês, `closing_date`, `due_date`): na mudança de dias (D14), **antes** de reagendar, na mesma trava do cartão, o sistema grava as datas vigentes (D25) de cada fatura **já fechada** (fechamento ≤ hoje) que tenha parcela, encargo ou pagamento, **e** da fatura fechada mais recente mesmo vazia, **e** de todo mês que está fechado pelas datas vigentes e ficaria **aberto** pelos dias novos (fechamento pelos dias novos > hoje), mesmo vazio. Mês já gravado não é sobrescrito. Assim, fatura fechada nunca "reabre" por perder a última parcela (D27/exclusão) nem por receber compra nova (D32), e D9/D24/encargos/`paidLate` usam as datas reais. A migration preenche, a partir das parcelas, os meses já fechados de cada cartão (fechamento ≤ hoje no fuso `America/Sao_Paulo`; meses fechados sem parcelas e cujos dias já mudaram não são recuperáveis).
  - **Colisão de mês na transição (aceita, D33)**: a fatura é identificada pelo mês do **vencimento**. Se a mudança faz o vencimento passar de "mês seguinte ao fechamento" para "mesmo mês" (ou o contrário), um ciclo pelos dias novos pode cair num mês já ocupado por fatura gravada — esse ciclo não existe e a compra vai para a fatura seguinte (ex.: "fecha 25/vence 5" → "fecha 27/vence 28", com 2026-12 gravada vencendo 05/12: compra de 26/11 → 2027-01, vence 28/01; a transição tem um ciclo mais longo).
  - **Retroativa em fatura antiga vazia (aceita, D34)**: mês fechado **vazio** que não é o fechado mais recente nem reabriria não é gravado (D31). Depois de mudar os dias, uma compra **retroativa** nesse mês usa os dias **novos** e pode cair num ciclo que nunca existiu (ex.: "fecha 10/vence 20" → "fecha 20/vence 28" em 27/11; 2026-10 vazia fechou 10/10; compra retroativa de 15/10 → 2026-10, fecha 20/10, vence 28/10 — pelos dias reais iria para 2026-11). Na criação é permitido (D13); na edição de data, D24 bloqueia.
- Status da parcela: `pending` | `paid` | `overdue`, sempre **calculado na consulta** (D6) em todas as visões (fatura, resumo, `GET /installments` e `/:id`, "quem me deve"):
  - **parcela de cartão**: derivado do razão (abaixo) — `paid` = totalmente coberta pelos pagamentos; `overdue` = não totalmente coberta e **vencimento da fatura** (datas da fatura, D25) antes de hoje; senão `pending`. Expõe `coveredAmount`/`remainingAmount` (D21; parcialmente coberta continua `pending`/`overdue`). O status gravado é **ignorado**.
  - **parcela órfã legada** (transação sem cartão, D18): vale o **status gravado**; `pending` com `dueDate < hoje` é exibida como `overdue` (sem gravar). `coveredAmount` = valor inteiro se `paid`, senão 0.
  - `PATCH /installments/:id` (`{ status }`, qualquer plano) só para **órfã legada**; parcela de cartão → 422 `CARD_INSTALLMENT_PAID_VIA_INVOICE` (o pagamento é da fatura, D4); parcela de outro usuário → 404.
  - `GET /installments?status=` filtra pelo status **derivado** (com `cardId`, `dateFrom`, `dateTo`, paginação); resposta com `status`, `coveredAmount`, `remainingAmount`, `closingDate`, `cardId` (`null` = órfã) e `amount` numérico. `?cardId=` de cartão inexistente ou de outro usuário → lista vazia (D28).
- **Fatura** (`GET /reports/cards/:cardId/invoices/:month`) = parcelas e encargos de um cartão com **vencimento no mês** informado, vistos pelo razão (abaixo). A fatura "2026-03" é a que **vence em março/2026**. Posse via `CardsService.findOne` (404/403); cartão **arquivado** também.
  - Datas da fatura (D25, usadas em toda regra que fala em "datas da fatura"): 1º as **gravadas por fatura** (D31); senão as gravadas nas parcelas do mês (a maior, se divergirem); sem parcelas, pelos dias atuais do cartão.
  - Valores: `installmentsTotal` (Σ parcelas), `chargesTotal` (Σ encargos), `paymentsTotal` (Σ pagamentos **lançados** nesta fatura), `coveredAmount` (Σ coberto dos itens do mês), `remaining` (Σ não coberto dos itens do mês), `previousBalance` (Σ `remaining` dos meses anteriores, **só depois que a fatura anterior venceu** — D10), `amountDue = previousBalance + remaining`.
  - Status da fatura (precedência): `paid` (tem itens e todos cobertos) → `open` (antes do fechamento) → `closed` (do fechamento até o vencimento) → `partially_paid` (vencida com algum item do mês coberto) → `unpaid` (vencida sem nada coberto). Mês sem itens: `open`/`closed` pelas datas; depois do vencimento, `unpaid` se houver `previousBalance`, senão `closed` (D17).
  - `items[]` na ordem FIFO (lançamento): descrição, categoria, data da compra, número/total de parcelas, valor, `dueDate`, `closingDate`, status derivado, `coveredAmount`, `remainingAmount`. `charges[]`: valor, descrição, `createdAt`, status/coberto/restante (o encargo vence com a fatura). `payments[]`: `amount`, `paidOn` (`null` = legado), `paidLate` (`paidOn` depois do vencimento **desta** fatura; `null` no legado — informativo, D22).
  - Faturas passadas refletem a **cobertura atual** (D22), não um extrato imutável.
- **Razão do cartão** (spec 2026-11-24-modelo-de-pagamento §2): pagamento é **da fatura**, não da parcela (D4). O total pago `P` (todos os pagamentos do cartão) quita a dívida em ordem FIFO (D5): por mês de fatura; no mês, parcelas pela ordem de lançamento (`transactions.created_at`, id, número) e depois encargos (`created_at`, id). Item coberto ⇔ soma acumulada ≤ `P`. `outstanding = max(Σ dívida − P, 0)`; `credit = max(P − Σ dívida, 0)`. Parcelas órfãs (sem cartão) ficam fora do razão.
- **Pagamento de fatura** (`POST /cards/:cardId/invoices/:month/payments`, `{ amount, paidOn? }`):
  - `amount` > 0 (2 casas, ≤ teto de dinheiro). Pode ser **parcial** (o saldo rola para as faturas seguintes — rotativo), **total** ou **a maior** (vira `credit`) (D2).
  - `paidOn` é data de calendário `YYYY-MM-DD`, padrão **hoje** (fuso `APP_TIMEZONE`), nunca depois de hoje → 400 `PAYMENT_DATE_IN_FUTURE` (D7); sem limite inferior (D22). Pagamento com data após o vencimento da fatura em que foi lançado é exibido como `paidLate` na visão da fatura.
  - **D9**: só em fatura **já fechada** ou na **fatura aberta atual** (a primeira com fechamento > hoje, pelas datas da fatura — D25). Mês além disso → 422 `INVOICE_NOT_ACCEPTING_ENTRIES`.
  - **Desfazer** (`DELETE .../payments/:id`, 204): sempre permitido (sem D9); só remove o lançamento daquele usuário, cartão **e** mês — outro cartão/mês ou inexistente → 404 `NOT_FOUND.INVOICE_PAYMENT` (D8).
  - Cartão de outro usuário → 403; inexistente → 404. Cartão arquivado aceita. Tudo sob a trava do cartão.
  - Legado (D18): parcelas `paid` de cartão existente viraram **um pagamento por (cartão, mês da fatura)** com `paidOn = null` (`overdue` gravado contou como não pago). O FIFO só reproduz exatamente o status legado quando as pagas formavam um prefixo (perda aceita, dados de desenvolvimento).
- **Encargos** (`POST /cards/:cardId/invoices/:month/charges`, `{ amount, description? }`, D3): juros/IOF/multa/mora **informados pelo usuário** — o app não calcula. Entram na dívida da fatura `month` depois das parcelas do mês. Mesmas regras de D9, plano, posse e desfazer (`DELETE .../charges/:id`, 404 `NOT_FOUND.INVOICE_CHARGE`). `description` ≤ 255, dado do usuário (nunca em log).
- **Limite disponível** (D11, em `GET /cards` e `GET /cards/:id`, junto de `outstanding` e `credit`): `availableLimit = creditLimit − outstanding` — o crédito **não** eleva o limite acima de `creditLimit` e aparece separado em `credit`. `creditLimit = 0` → `availableLimit = null`. Calculado em lote para todos os cartões listados.
- **Arquivar cartão** (D12): `DELETE /cards/:id` (intermediate, 204) **arquiva** (`archivedAt` = agora; idempotente) — sem exclusão física. Arquivado sai de `GET /cards` (aparece com `?includeArchived=true`), continua em `GET /cards/:id`, mantém histórico, faturas, saldo e pagamentos, aceita pagamento/encargo. `POST /cards/:id/restore` (intermediate) reativa. Compra nova em cartão arquivado → 422 (§4).
- Legado: cartões removidos **antes** do arquivamento deixaram as transações com `cardId = null`; essas parcelas (órfãs) permanecem, não podem ser recalculadas e mantêm o status gravado (D18).

## 6. Divisão de custos (splits) e contatos

- Split = parte de uma transação que **outra pessoa** deve ao usuário. Compra inteira para outra pessoa = split com o valor total.
- Σ splits da transação **≤ totalAmount** (422 `SPLITS_EXCEED_TOTAL`).
- Split ligado a item: o item precisa ser **da mesma transação** (400) e Σ splits do item ≤ quantidade × preço (422).
- Status: `pending` | `paid`; `paidAt` preenchido na transição `pending → paid` (remarcar como pago **preserva** a data original) e limpo ao voltar para `pending`.
- Criar, mudar o status e remover split acontecem **sob a trava da transação**: não correm com a exclusão da transação (barrada por split pendente) — ou o split muda antes e a exclusão vê (409), ou a exclusão vence e o split responde 404.
- Listagem `GET /splits?transactionId=` (obrigatório): transação inexistente ou de outro usuário → **lista vazia** (D28).
- **Contato** (entidade própria, premium, `/contacts`): pessoa com quem o usuário divide gastos — `name` (obrigatório, ≤ 255), `email` (≤ 254) e `phone` (≤ 32) opcionais, pertence ao usuário.
  - E-mail único **por usuário** (case-insensitive), quando informado: gravado normalizado (trim + minúsculas); duplicado → 409 `CONTACT_EMAIL_IN_USE` (é o próprio usuário, não é oráculo). Outro usuário pode ter contato com o mesmo e-mail.
  - Listagem ordenada por nome, paginada, com `?search=` em nome/e-mail (sem caixa, curingas tratados como texto).
  - Todo split referencia um contato (`contactId` do próprio usuário, validado). Contato inexistente ou de outro usuário → **400 genérico** `Invalid contact` (não revela IDs alheios). A resposta do split traz `contact: { id, name, email }` (sem telefone).
  - Contato com splits **não pode ser removido** (409 `CONTACT_HAS_SPLITS`, garantido pela FK do banco); editar nome/e-mail reflete em todos os splits. Excluir o usuário apaga contatos e splits em cascata.
  - Splits anteriores aos contatos foram migrados agrupando, por usuário, pelo e-mail normalizado ou, sem e-mail, pelo nome normalizado (trim, espaços colapsados, sem caixa). A mesma pessoa com e-mail num split e sem e-mail em outro virou dois contatos. Splits sem e-mail e com nome vazio viraram um único contato `(sem nome)` por usuário; e-mail com mais de 254 caracteres foi descartado (contato sem e-mail) para não colidir no índice único. O `down()` restaura nomes/e-mails normalizados (não os originais).
- **"Quem me deve"** (`GET /reports/receivables`, premium — **rebaixado recebe 403**, decisão de produto; ele ainda vê os splits por transação):
  - Agrupa por contato (nome/e-mail lidos sempre de `contacts`; telefone **não** é retornado — minimização LGPD, fica em `GET /contacts/:id`).
  - Filtro `status` = `pending` (padrão) | `paid` | `all`. Com `pending` só aparecem contatos com algo pendente; com `paid`/`all`, contatos com splits no filtro. Contato sem nenhum split não aparece.
  - Por contato: `pending` = Σ splits `pending`, `paid` = Σ splits `paid` (histórico total), `pendingCount`, `oldestPendingDate` (data da transação mais antiga com split pendente) e `splits` conforme o filtro, cada um com `status` e `paidAt`.
  - Split **não vence**: só `pending`/`paid` (a regra de vencida calculada é das parcelas).
  - Data de referência do split = **data da transação**. Valor = **valor cheio** desde a compra (sem pro-rata).
  - Split de compra no cartão traz também a situação das parcelas da compra pelo **status derivado** (parcela de cartão: razão; órfã: gravado — D18): `installments = { total, paid (totalmente cobertas), remaining (as demais, inclusive parcialmente cobertas), nextDueDate (menor `dueDate` gravado na parcela entre as não pagas, ou null) }`; compra sem parcelas (pix/dinheiro) → `installments = null`.
  - Filtro `contactId` opcional (filtro de listagem, D28): contato inexistente ou de outro usuário → **resultado vazio** (`totals` zerados, `contacts: []`), nunca 404/403 — não revela se o ID existe.
  - Totais gerais `{ pending, paid }` = soma dos contatos retornados.
  - Ordenação: contatos por `pending` desc, depois nome asc, depois id; splits por data da transação asc, depois id.
  - Sem paginação por enquanto (risco registrado: usuário com muitos splits).

## 7. Resumo mensal

Regime de **caixa** — o que sai do bolso no mês:
- **Gastos do mês** = Σ parcelas com vencimento no mês + Σ transações **sem parcelas** (à vista: pix, dinheiro, débito, transferência, boleto ou legado sem forma) com `date` no mês. (Critério "sem parcelas" e não "sem cartão": transação de cartão removido fica com `cardId` nulo mas mantém as parcelas — contaria duas vezes.)
- **Encargos do mês** (`cardCharges`, D16/D23): Σ encargos lançados nas faturas que vencem no mês (todos os cartões, inclusive arquivados). Entram em `spent` e em `byCard`, **não** em `byCategory` (Σ `byCategory` = `spent − cardCharges`).
- Parcelas do mês **por valor** (D21): `installments.paid` = Σ parte coberta, `pending` = Σ parte não coberta (inclui a vencida), `overdue` = Σ parte não coberta vencida. Parcela de cartão pelo razão; órfã legada pelo status gravado (D18). Parcialmente coberta conta nas duas partes.
- `paidInMonth` (informativo, não é gasto): Σ pagamentos de fatura com `paidOn` no mês (pagamento legado com `paidOn = null` fica fora — D22) + Σ à vista do mês.
- Também: gastos por categoria (no mesmo regime; parcela herda a categoria da transação), a receber de splits (Σ `pending` das transações do mês, premium).
- Mês informado como `YYYY-MM`.
- Resposta: `totals` (`spent` = `cardInstallments + cardCharges + upfront`, `cardInstallments`, `cardCharges`, `upfront` = total à vista, isto é, Σ transações sem parcelas do mês), `installments` (paid/pending/overdue por valor), `paidInMonth`, `byCategory`, `byCard` (parcelas + encargos) e `byPaymentMethod` ordenados do maior valor (`null` = sem categoria / cartão removido / forma não informada — legado), `receivablesPending` (`null` abaixo de premium).
  - `byPaymentMethod` quebra **só o total à vista** (Σ `byPaymentMethod` = `upfront`); parcelas de cartão ficam em `cardInstallments`/`byCard`.

## 8. Investimentos (assets)

- `type`: stocks, fii, crypto, fixed_income, others; `status`: active | sold. Quantidade e preço médio com até 6 casas.

## 9. LGPD

- Dados pessoais (nome de terceiros, e-mail, telefone, documento, descrição de compra) **nunca** em log — só IDs.
- Exclusão em cascata por usuário (`ON DELETE CASCADE`). 🔜 `DELETE /users/me` (art. 18).
