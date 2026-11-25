import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { Clock } from '../common/clock';
import {
  buildCardLedger,
  CardLedger,
  LedgerCardInput,
  LedgerChargeInput,
  LedgerInstallmentInput,
  LedgerPaymentInput,
} from './invoice-ledger.calculator';

export interface LoadLedgersOptions {
  /** Restringe aos cartões informados (do próprio usuário); omitido = todos, inclusive arquivados. */
  cardIds?: readonly string[];
  /** Lê dentro da transação de banco do chamador (ex.: sob a trava do cartão). */
  em?: EntityManager;
  /**
   * "Hoje" (`YYYY-MM-DD`) já lido pelo chamador — um único "hoje" por requisição, para o razão e
   * as demais regras não divergirem na virada do dia. Omitido = `Clock.today()`.
   */
  today?: string;
}

type Row<T> = T & { cardId: string };

// D25: timestamps de ordenação em UTC com microssegundos; datas de calendário via to_char
// (em consultas raw o driver pg devolveria `Date`, sujeito ao fuso do processo).
const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DATE = (col: string) => `to_char(${col}, 'YYYY-MM-DD')`;

// $1 = userId; $2 = uuid[] dos cartões ou NULL (todos). Todas filtram por user_id.
const CARDS_SQL = `
  SELECT c.id, c.closing_day AS "closingDay", c.due_day AS "dueDay", c.credit_limit AS "creditLimit"
  FROM credit_cards c
  WHERE c.user_id = $1 AND ($2::uuid[] IS NULL OR c.id = ANY($2::uuid[]))`;

const INSTALLMENTS_SQL = `
  SELECT i.id, i.transaction_id AS "transactionId", t.card_id AS "cardId",
         ${TS('t.created_at')} AS "transactionCreatedAt", i.number, i.amount,
         ${DATE('i.due_date')} AS "dueDate", ${DATE('i.closing_date')} AS "closingDate"
  FROM installments i
  JOIN transactions t ON t.id = i.transaction_id
  JOIN credit_cards c ON c.id = t.card_id AND c.user_id = t.user_id
  WHERE t.user_id = $1 AND ($2::uuid[] IS NULL OR t.card_id = ANY($2::uuid[]))`;

const CHARGES_SQL = `
  SELECT ch.id, ch.card_id AS "cardId", ch.invoice_month AS "invoiceMonth", ch.amount,
         ${TS('ch.created_at')} AS "createdAt"
  FROM invoice_charges ch
  WHERE ch.user_id = $1 AND ($2::uuid[] IS NULL OR ch.card_id = ANY($2::uuid[]))`;

const PAYMENTS_SQL = `
  SELECT p.id, p.card_id AS "cardId", p.invoice_month AS "invoiceMonth", p.amount,
         ${DATE('p.paid_on')} AS "paidOn"
  FROM invoice_payments p
  WHERE p.user_id = $1 AND ($2::uuid[] IS NULL OR p.card_id = ANY($2::uuid[]))`;

/**
 * Leitura do razão dos cartões (spec 2026-11-24-modelo-de-pagamento §2/§5): carga **em lote por
 * usuário** — cartões + 3 consultas (parcelas de transações com cartão, encargos, pagamentos) —,
 * agrupada por cartão e montada com `buildCardLedger` e o "hoje" do `Clock`. Exceção de leitura
 * agregada (architecture.md): lê tabelas de outros domínios via SQL, sempre por `user_id`.
 * Parcelas órfãs (transação sem cartão) ficam fora do razão (D18).
 */
@Injectable()
export class InvoiceLedgerQuery {
  constructor(
    private readonly dataSource: DataSource,
    private readonly clock: Clock,
  ) {}

  async loadLedgers(
    userId: string,
    opts: LoadLedgersOptions = {},
  ): Promise<Map<string, CardLedger>> {
    const ledgers = new Map<string, CardLedger>();
    if (opts.cardIds && opts.cardIds.length === 0) return ledgers;

    const runner = opts.em ?? this.dataSource;
    const params = [userId, opts.cardIds ? [...opts.cardIds] : null];
    // Sequenciais: com `em` todas usam a mesma conexão da transação
    const cards: (LedgerCardInput & { id: string })[] = await runner.query(CARDS_SQL, params);
    if (cards.length === 0) return ledgers;
    const installments: Row<LedgerInstallmentInput>[] = await runner.query(
      INSTALLMENTS_SQL,
      params,
    );
    const charges: Row<LedgerChargeInput>[] = await runner.query(CHARGES_SQL, params);
    const payments: Row<LedgerPaymentInput>[] = await runner.query(PAYMENTS_SQL, params);

    const today = opts.today ?? this.clock.today();
    for (const { id, closingDay, dueDay, creditLimit } of cards) {
      ledgers.set(
        id,
        buildCardLedger({
          card: { closingDay, dueDay, creditLimit },
          installments: installments.filter((r) => r.cardId === id),
          charges: charges.filter((r) => r.cardId === id),
          payments: payments.filter((r) => r.cardId === id),
          today,
        }),
      );
    }
    return ledgers;
  }

  /** Razão de um cartão do usuário (`undefined` se o cartão não for dele ou não existir). */
  async loadLedger(
    userId: string,
    cardId: string,
    em?: EntityManager,
    today?: string,
  ): Promise<CardLedger | undefined> {
    return (await this.loadLedgers(userId, { cardIds: [cardId], em, today })).get(cardId);
  }
}
