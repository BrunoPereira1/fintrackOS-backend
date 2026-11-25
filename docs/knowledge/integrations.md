# Integrações externas — FinTrack OS

Regras para qualquer código que fala com algo fora do processo: Firebase, Postgres, Redis, BullMQ, Meta WhatsApp e, 🔜, SEFAZ/NF-e e armazenamento de arquivos. Guardião: subagente `integration-guard`.

## Regras gerais (valem para toda integração)

1. **Timeout explícito** em toda chamada de rede. Sem timeout, um provedor lento segura conexões e derruba a API. HTTP com `fetch`: use `AbortSignal.timeout(ms)`; padrão de 5 s para chamadas síncronas na requisição, e mais nos workers.
2. **Classificar falhas**: erro do cliente (4xx, dado inválido) não tem retry; erro transitório (timeout, 5xx, 429, `ECONNRESET`) tem retry **com backoff exponencial e limite**. Na requisição HTTP, no máximo 1 retry; o resto vai para fila.
3. **Fail-open ou fail-closed é decisão explícita e documentada** para cada dependência (tabela abaixo).
4. **Erros do provedor nunca vazam para o cliente**: mapeie para exceção do Nest com mensagem de `ErrorMessages`. Logue o código do provedor, nunca o payload com dados pessoais.
5. **Segredos só por env**, lidos em `src/config/*`, presentes em `.env.example` como placeholder e validados em `scripts/validate-env.sh` quando obrigatórios em produção. Nunca no código, em log ou em resposta.
6. **Idempotência**: toda operação que pode ser repetida (retry, job reprocessado, webhook duplicado) precisa produzir o mesmo resultado. Use chave natural ou de idempotência (ex.: chave de acesso da NF-e, `jobId` determinístico).
7. **Isolar o SDK atrás de um service** do nosso domínio (ex.: `FirebaseAuthService`, `NotificationsService`). O resto do código não importa o SDK direto, o que facilita testar e trocar de provedor.
8. **Testes**: unitários mockam o service de integração; nenhum teste unitário chama rede. Os e2e usam somente Postgres/Redis reais (os do docker-compose ou os serviços do CI).
9. **Dependência nova** (pacote, provedor) precisa de justificativa, de versão compatível com Node 20 e de entrada nesta página.

## Matriz de dependências

| Dependência | Uso | Se cair | Timeout / retry |
|---|---|---|---|
| **PostgreSQL** | Dados de domínio | Requisição falha (500/503); `/health` = 503 | Pool do TypeORM com `extra.connectionTimeoutMillis` (`DB_CONNECT_TIMEOUT_MS`, padrão 5 s) e `extra.statement_timeout` (`DB_STATEMENT_TIMEOUT_MS`, padrão 15 s); health `pingCheck` 2 s. TLS: `DB_SSL` (padrão `true` em produção, `false` fora); log: `DB_LOGGING` (padrão só erro/aviso, sem queries) |
| **Redis: cache** (sessão/perfil) | Otimização de auth | **Fail-open, inclusive no boot**: a API sobe sem Redis; sem cache, sessão → Firebase e perfil → banco | Cliente criado com `createClient` + listener de `error` **antes** do `connect()`, que não é aguardado (`src/config/cache.config.ts`); `disableOfflineQueue` (falha imediata sem conexão); node-redis v4 não tem `commandTimeout`, então o `TokenCacheService` limita cada operação a 500 ms (`Promise.race`) e cai no fail-open |
| **Redis: health** | `GET /health` | `/health` = 503 (`redis: down`, sem detalhe na resposta); `/health/live` segue 200 | ioredis com `lazyConnect`, `connectTimeout: 2000`, `commandTimeout: 1000`, `maxRetriesPerRequest: 1`; listener de `error` loga só a primeira falha por queda |
| **Redis: throttler** | Rate limit | Controllers com prefixo `auth` (`FAIL_CLOSED_CONTROLLER_PATHS`, inclui login, registro, reset e **logout**): **fail-closed** (503 `RATE_LIMIT_UNAVAILABLE`); demais rotas: **fail-open** | `maxRetriesPerRequest: 1`, `connectTimeout: 2000`, `commandTimeout: 1000`; listener de `error` |
| **Redis: BullMQ** | Filas (OCR) | Enfileirar falha → 503 para o cliente; workers param e retomam sozinhos | Retries do job: 3, backoff exponencial de 5 s |
| **Firebase Admin** (`verifyIdToken`, `createUser`, `revokeRefreshTokens`, `deleteUser`) | Identidade | Token inválido/revogado/conta desativada → 401 genérico; **transitórios** (`app/network-error`, `app/network-timeout`, `auth/internal-error`, erro sem `code` ou código de sistema `E...`) → 503 `AUTH_PROVIDER_UNAVAILABLE`; `createUser` com erro não mapeado → 503. **Logout**: `revokeRefreshTokens` → invalida as sessões locais → se o Firebase falhar, invalida local mesmo assim e responde 503 `LOGOUT_FAILED`. Requisições com sessão em cache continuam por até 5 min | SDK; `checkRevoked=true` fora do cache. Versão de sessão `auth:sessver:{uid}` (TTL 60 min) derruba todas as sessões do uid em O(1); leitura dela é fail-open (Redis fora → versão inicial) |
| **Firebase REST** (`identitytoolkit`: login, reset de senha) | Login por e-mail/senha | Timeout, erro de rede, 5xx, 429 ou corpo não-JSON → 503 `AUTH_PROVIDER_UNAVAILABLE`; credencial inválida → 401 genérico; códigos de reset → 400 | `AbortSignal.timeout(5000)` (`FIREBASE_REST_TIMEOUT_MS`, `src/auth/firebase-auth.service.ts`); sem retry na requisição |
| **Meta WhatsApp Cloud API** 🔜 | Notificações | **Fail-open**: notificação é melhor esforço e nunca bloqueia a operação de negócio; enviar via fila | 5 s; retry só para 5xx/429, respeitando `Retry-After` |
| **SEFAZ / NF-e** 🔜 | Leitura de nota (OCR) | Job falha e reentra na fila; após esgotar → `ocr-failed` e o usuário é avisado | Definir no item OCR |
| **helmet** (dependência, não rede) | Cabeçalhos de segurança HTTP (`src/main.ts`) | — (in-process) | — . Justificativa: padrão de mercado para headers (CSP, HSTS...), compatível com Node 20 e com o Swagger UI |
| **Intl / ICU do Node** (in-process, sem dependência nova) | Fuso `APP_TIMEZONE` do `Clock` (`src/common/clock.ts`) | — (in-process). Fuso inválido (ou fora da base ICU) → `RangeError` convertido em erro citando `APP_TIMEZONE`, **boot falha** (fail-closed). Variável não definida → padrão `America/Sao_Paulo` | — . Node 20 traz full-icu com a base IANA; não use imagem `small-icu`. Independe do `TZ` do processo |
| **redis** 4.7.1 (dependência direta, versão exata) | Cliente node-redis do cache (`src/config/cache.config.ts`, `createClient` + `redisInsStore`) | ver "Redis: cache" | — . Justificativa: já vinha transitivamente via `cache-manager-redis-yet`; declarado para o import direto não depender de hoisting |

## Firebase

- Códigos de erro tratados em `src/common/constants/firebase-errors.ts` (Admin: `auth/...`; REST: `EMAIL_NOT_FOUND`...). Código novo entra lá, nunca como string solta.
- Respostas de login são **genéricas** (mesma mensagem para e-mail inexistente, senha errada e conta desativada); `forgot-password` responde 204 para qualquer resposta do provedor sobre a conta, e 503 só quando o provedor está fora (não revela nada sobre a conta).
- Classifique **antes** de mapear: indisponibilidade do provedor vira 503 (o cliente tenta de novo, sem deslogar o usuário); só erro de credencial vira 401/400. Códigos transitórios do Admin SDK ficam em `FIREBASE_ADMIN_TRANSIENT_CODES` / `isFirebaseAdminTransientError` (`firebase-errors.ts`).
- Criou usuário no Firebase e a persistência falhou → desfaça (`deleteUser`) em best-effort e logue se falhar.
- Credenciais: `FIREBASE_PROJECT_ID`, `FIREBASE_PRIVATE_KEY` (com `\n` escapado), `FIREBASE_CLIENT_EMAIL`, `FIREBASE_API_KEY`.

## PostgreSQL

- Erros de constraint viram respostas de domínio com `isUniqueViolation(err, '<constraint>')` (23505) e `isForeignKeyViolation(err, '<constraint>')` (23503) (`src/common/db-errors.ts`). Sempre informe o nome da constraint, para não mascarar outra violação. Com FK diferida, o 23503 surge no COMMIT (o `repo.remove()` já commita).
- Deadlock (`40P01`) e falha de serialização (`40001`) abortam a transação de banco: `isTransactionConflict(err)` / `mapTransactionConflict(work)` (`src/common/db-errors.ts`) convertem em **409 `CONCURRENT_UPDATE`** (sem retry no servidor; o cliente tenta de novo). Use em volta de todo `manager.transaction` que trava linhas (hoje: `CardsService` e `CardInvoicesService`).
- Consultas raw de leitura (`DataSource.query`/`EntityManager.query`) sempre com parâmetros (`$1`…) e `user_id`; datas via `to_char(col, 'YYYY-MM-DD')` e timestamps via `to_char(col AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` — o driver pg devolveria `Date` sujeito ao fuso do processo.
- Primeiro acesso concorrente do mesmo uid: `UsersService.findOrCreate` captura `isUniqueViolation(err, 'UQ_users_firebase_uid')` e relê o usuário.
- Produção: `DB_SSL=true` validando o certificado (`DB_SSL_CA`); `DB_SSL_REJECT_UNAUTHORIZED=false` só como escape temporário e documentado.

## Redis

- Todo cliente criado via `readRedisConnection` / `toIoRedisOptions` / `toNodeRedisOptions` (`src/config/redis-connection.ts`): senha (`REDIS_PASSWORD`) e TLS (`REDIS_TLS`).
- Todo cliente **registra listener de `error`** antes de conectar, logando só a primeira falha de cada queda. Sem ele, o processo pode cair (bug real encontrado no cache) ou o log fica poluído.
- Nenhum cliente bloqueia o boot esperando o Redis: com ele fora, a API sobe, `/health` responde 503 e cada uso aplica sua política (tabela acima).
- Todo comando tem prazo: ioredis com `commandTimeout`; node-redis (cache) via `Promise.race` no `TokenCacheService`.
- Não guarde no Redis nada que não possa ser perdido: ele é cache e fila, não fonte de verdade.

## Filas (BullMQ)

- Producer no service do domínio (ex.: `OcrService.enqueue`); consumer em `*.processor.ts` (`WorkerHost`).
- Payload mínimo e sem dados pessoais desnecessários: IDs e referências (ex.: `userId`, `fileUrl`), nunca o conteúdo do arquivo.
- Processor **idempotente**: verifica se o trabalho já foi feito antes de gravar.
- Falha definitiva → fila `*-failed` (ex.: `OCR_FAILED_QUEUE`) com o motivo; o usuário é notificado.
- `concurrency` explícita por processor.

## Webhooks recebidos 🔜

- Validar assinatura (HMAC do provedor) **antes** de qualquer processamento; rejeitar com 401 sem detalhes.
- Responder 2xx rápido e processar via fila; deduplicar pelo ID do evento.
