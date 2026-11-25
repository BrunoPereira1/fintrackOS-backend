import {
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { Installment, InstallmentStatus } from './entities/installment.entity';
import { UpdateInstallmentDto } from './dto/update-installment.dto';
import { QueryInstallmentsDto } from './dto/query-installments.dto';
import { InstallmentResponseDto } from './dto/installment-response.dto';
import {
  listingCoverage,
  mergeInstallmentStates,
  orphanInstallmentState,
  resolveInstallmentState,
} from './installment-state';
import { ErrorMessages } from '../common/constants/error-messages';
import { invoiceDates } from '../common/invoice-dates';
import { Clock } from '../common/clock';
import { toCents } from '../common/money';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { installmentStates, LedgerItemState } from '../invoices/invoice-ledger.calculator';

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/** Linha da listagem/consulta, como vem do SQL (decimais e datas em string). */
interface InstallmentRow {
  id: string;
  number: number;
  totalInstallments: number;
  amount: string;
  dueDate: string;
  closingDate: string;
  transactionId: string;
  cardId: string | null;
  status: InstallmentStatus;
}

const SELECT_ROW = `
  i.id, i.number, i.total_installments AS "totalInstallments", i.amount,
  to_char(i.due_date, 'YYYY-MM-DD') AS "dueDate",
  to_char(i.closing_date, 'YYYY-MM-DD') AS "closingDate",
  i.transaction_id AS "transactionId", t.card_id AS "cardId", i.status`;

/**
 * Status derivado no SQL (spec 2026-11-24 §2, D6, D18, D25), com os parâmetros de
 * `listingCoverage` ($2–$5: limiar coberto por cartão; $6–$7: meses de fatura vencidos; $8: hoje):
 * - órfã (sem cartão): status gravado, `pending` vencida → `overdue`;
 * - cartão: `paid` se o valor é zero (nada a cobrir) ou se a chave FIFO `(mês da fatura, transactions.created_at, transação, número)`
 *   ≤ limiar do cartão (as totalmente cobertas são um prefixo da ordem); senão `overdue` se o mês
 *   da fatura está vencido; senão `pending`.
 * Tipos nativos (date/timestamptz/uuid/int) na comparação: mesma ordem da calculadora (uuid
 * compara bytes = texto hexadecimal minúsculo), sem depender de collation.
 */
const DERIVED_SQL = `
  WITH cov AS (
    SELECT x.card_id, x.month, t2.created_at, x.tx_id, x.number
    FROM unnest($2::uuid[], $3::date[], $4::uuid[], $5::int[]) AS x(card_id, month, tx_id, number)
    JOIN transactions t2 ON t2.id = x.tx_id AND t2.user_id = $1
  ),
  past_due AS (
    SELECT * FROM unnest($6::uuid[], $7::date[]) AS p(card_id, month)
  )
  SELECT ${SELECT_ROW},
    CASE
      WHEN t.card_id IS NULL THEN
        CASE WHEN i.status = 'pending' AND i.due_date < $8::date THEN 'overdue'
             ELSE i.status::text END
      -- valor zero é sempre totalmente coberta (calculadora), mesmo fora do prefixo coberto
      WHEN i.amount = 0 THEN 'paid'
      WHEN EXISTS (
        SELECT 1 FROM cov
        WHERE cov.card_id = t.card_id
          AND (date_trunc('month', i.due_date)::date, t.created_at, t.id, i.number)
              <= (cov.month, cov.created_at, cov.tx_id, cov.number)
      ) THEN 'paid'
      WHEN EXISTS (
        SELECT 1 FROM past_due p
        WHERE p.card_id = t.card_id AND p.month = date_trunc('month', i.due_date)::date
      ) THEN 'overdue'
      ELSE 'pending'
    END AS "derivedStatus"
  FROM installments i
  JOIN transactions t ON t.id = i.transaction_id
  WHERE t.user_id = $1`;

@Injectable()
export class InstallmentsService {
  private readonly logger = new Logger(InstallmentsService.name);

  constructor(
    @InjectRepository(Installment)
    private readonly installmentsRepo: Repository<Installment>,
    private readonly ledgers: InvoiceLedgerQuery,
    private readonly clock: Clock,
  ) {}

  /**
   * Lista as parcelas do usuário com status **derivado** (cartão: razão; órfã: gravado — D18),
   * filtrando e paginando no SQL. O razão (carregado em lote por usuário) vira só um limiar por
   * cartão + meses vencidos (`listingCoverage`), então o filtro `?status=` e a paginação ficam
   * no banco. Razão e página são lidos no mesmo snapshot (`REPEATABLE READ`).
   */
  async findAll(
    userId: string,
    query: QueryInstallmentsDto,
  ): Promise<PaginatedResult<InstallmentResponseDto>> {
    const { page, limit, status, dateFrom, dateTo, cardId } = query;
    const today = this.clock.today();

    return this.installmentsRepo.manager.transaction('REPEATABLE READ', async (em) => {
      const ledgers = await this.ledgers.loadLedgers(userId, {
        cardIds: cardId ? [cardId] : undefined,
        em,
        today,
      });
      const { covered, pastDue } = listingCoverage(ledgers);
      const params: unknown[] = [
        userId,
        covered.map((c) => c.cardId),
        covered.map((c) => `${c.month}-01`),
        covered.map((c) => c.transactionId),
        covered.map((c) => c.number),
        pastDue.map((p) => p.cardId),
        pastDue.map((p) => `${p.month}-01`),
        today,
      ];
      const param = (value: unknown) => {
        params.push(value);
        return `$${params.length}`;
      };

      let sql = DERIVED_SQL;
      if (dateFrom) sql += ` AND i.due_date >= ${param(dateFrom)}::date`;
      if (dateTo) sql += ` AND i.due_date <= ${param(dateTo)}::date`;
      if (cardId) sql += ` AND t.card_id = ${param(cardId)}::uuid`;
      let filtered = `FROM (${sql}) d`;
      if (status) filtered += ` WHERE d."derivedStatus" = ${param(status)}`;

      const [{ total }] = await em.query<{ total: number }[]>(
        `SELECT count(*)::int AS total ${filtered}`,
        params,
      );
      const pageParams = [...params, limit, (page - 1) * limit];
      const rows = await em.query<InstallmentRow[]>(
        `SELECT d.* ${filtered} ORDER BY d."dueDate", d.id
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams,
      );

      const states = mergeInstallmentStates(ledgers.values());
      return {
        data: rows.map((r) => toResponse(r, resolveInstallmentState(r, states, today))),
        total,
        page,
        limit,
      };
    });
  }

  /** Parcela do usuário com status derivado (404 se não existir ou for de outro usuário). */
  async findOne(id: string, userId: string): Promise<InstallmentResponseDto> {
    // Parcela e razão no mesmo snapshot (como a listagem e os relatórios)
    return this.installmentsRepo.manager.transaction('REPEATABLE READ', async (em) => {
      const row = await this.findRow(em, id, userId);
      return toResponse(row, await this.stateOf(em, row, userId));
    });
  }

  /**
   * Marca paga/pendente **só parcela órfã legada** (transação sem cartão — D18/C6). Parcela de
   * cartão → 422: o pagamento é da fatura (D4).
   */
  async update(
    id: string,
    userId: string,
    dto: UpdateInstallmentDto,
  ): Promise<InstallmentResponseDto> {
    const row = await this.findRow(this.installmentsRepo.manager, id, userId);
    if (row.cardId !== null) {
      throw new UnprocessableEntityException(ErrorMessages.CARD_INSTALLMENT_PAID_VIA_INVOICE);
    }
    // Escrita condicional (defesa em profundidade): só órfã do próprio usuário
    const [, affected] = await this.installmentsRepo.query<[unknown, number]>(
      `UPDATE installments i SET status = $3
       FROM transactions t
       WHERE t.id = i.transaction_id AND i.id = $1 AND t.user_id = $2 AND t.card_id IS NULL`,
      [id, userId, dto.status],
    );
    if (affected === 0) throw new NotFoundException(ErrorMessages.NOT_FOUND.INSTALLMENT);
    this.logger.log(`Orphan installment ${id} updated to status "${dto.status}"`);
    const updated = { ...row, status: dto.status };
    return toResponse(updated, orphanInstallmentState(updated, this.clock.today()));
  }

  private async findRow(em: EntityManager, id: string, userId: string): Promise<InstallmentRow> {
    const [row] = await em.query<InstallmentRow[]>(
      `SELECT ${SELECT_ROW}
       FROM installments i
       JOIN transactions t ON t.id = i.transaction_id
       WHERE i.id = $1 AND t.user_id = $2`,
      [id, userId],
    );
    if (!row) throw new NotFoundException(ErrorMessages.NOT_FOUND.INSTALLMENT);
    return row;
  }

  private async stateOf(
    em: EntityManager,
    row: InstallmentRow,
    userId: string,
  ): Promise<LedgerItemState> {
    const today = this.clock.today();
    if (row.cardId === null) return orphanInstallmentState(row, today);
    const ledger = await this.ledgers.loadLedger(userId, row.cardId, em, today);
    return resolveInstallmentState(row, ledger ? installmentStates(ledger) : new Map(), today);
  }

  /**
   * D14: depois de mudar `closingDay`/`dueDay` de um cartão, as parcelas de faturas **ainda não
   * fechadas** (data de fechamento da fatura — a maior do mês, D25 — depois de `today`) mantêm o
   * mês da fatura (mês do vencimento) e recebem as datas desse mês pelos novos dias. Faturas
   * fechadas mantêm as datas (C4). Deve rodar na transação do chamador, **sob a trava do
   * cartão** (`CardsService.update`). Devolve quantas parcelas foram ajustadas.
   */
  async rescheduleOpenInvoices(
    em: EntityManager,
    cardId: string,
    userId: string,
    days: { closingDay: number; dueDay: number },
    today: string,
  ): Promise<number> {
    const months: { month: string; ids: string[] }[] = await em.query(
      `SELECT to_char(i.due_date, 'YYYY-MM') AS month, array_agg(i.id::text) AS ids
       FROM installments i
       JOIN transactions t ON t.id = i.transaction_id
       WHERE t.card_id = $1 AND t.user_id = $2
       GROUP BY 1
       HAVING max(i.closing_date) > $3::date`,
      [cardId, userId, today],
    );

    let updated = 0;
    for (const { month, ids } of months) {
      const { closingDate, dueDate } = invoiceDates(month, days);
      await em.query(
        `UPDATE installments SET closing_date = $1::date, due_date = $2::date
         WHERE id = ANY($3::uuid[])`,
        [closingDate, dueDate, ids],
      );
      updated += ids.length;
    }
    if (updated > 0) {
      this.logger.log(`Rescheduled ${updated} open-invoice installments of card ${cardId}`);
    }
    return updated;
  }
}

function toResponse(row: InstallmentRow, state: LedgerItemState): InstallmentResponseDto {
  return {
    id: row.id,
    number: row.number,
    totalInstallments: row.totalInstallments,
    amount: toCents(row.amount) / 100,
    dueDate: row.dueDate,
    closingDate: row.closingDate,
    transactionId: row.transactionId,
    cardId: row.cardId,
    ...state,
  };
}
