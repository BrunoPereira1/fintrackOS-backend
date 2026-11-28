import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import {
  closedInvoiceDatesToRecord,
  InvoiceDates,
  LedgerRecordedDatesInput,
} from './invoice-ledger.calculator';
import { InvoiceLedgerQuery, RECORDED_DATES_SQL } from './invoice-ledger.query';

/**
 * Datas gravadas por fatura (D31, `card_invoice_dates`). Não verifica posse nem trava: roda na
 * transação do chamador (`em`), **sob a trava do cartão** (`CardsService.lockOwned`), como
 * `InvoiceEntriesService`.
 */
@Injectable()
export class CardInvoiceDatesService {
  private readonly logger = new Logger(CardInvoiceDatesService.name);

  constructor(private readonly ledgers: InvoiceLedgerQuery) {}

  /**
   * D31: antes de mudar `closingDay`/`dueDay` (D14), grava as datas vigentes (D25) de cada fatura
   * já fechada (fechamento ≤ `today`) com parcela, encargo ou pagamento, da fatura fechada mais
   * recente mesmo vazia e de todo mês fechado que reabriria pelos `newDays` (mesmo vazio).
   * Precisa rodar **antes** de gravar os dias novos do cartão: o razão é lido com os dias que
   * estão no banco. Mês já gravado nunca é sobrescrito. Devolve quantos meses foram enviados
   * para gravação.
   */
  async recordClosedInvoices(
    em: EntityManager,
    cardId: string,
    userId: string,
    newDays: { closingDay: number; dueDay: number },
    today: string,
  ): Promise<number> {
    const ledger = await this.ledgers.loadLedger(userId, cardId, em, today);
    if (!ledger) return 0;
    const rows = closedInvoiceDatesToRecord(ledger, newDays);
    if (rows.length === 0) return 0;

    await em.query(
      `INSERT INTO card_invoice_dates (user_id, card_id, invoice_month, closing_date, due_date)
       SELECT $1, $2, x.month, x.closing_date, x.due_date
       FROM unnest($3::text[], $4::date[], $5::date[]) AS x(month, closing_date, due_date)
       ON CONFLICT (card_id, invoice_month) DO NOTHING`,
      [
        userId,
        cardId,
        rows.map((r) => r.month),
        rows.map((r) => r.closingDate),
        rows.map((r) => r.dueDate),
      ],
    );
    this.logger.log(`Recorded dates of ${rows.length} closed invoices of card ${cardId}`);
    return rows.length;
  }

  /** D32: datas gravadas por fatura do cartão (mês → datas), lidas no `em` do chamador. */
  async findRecorded(
    em: EntityManager,
    cardId: string,
    userId: string,
  ): Promise<Map<string, InvoiceDates>> {
    // Mesma consulta do razão (por user_id e cartões), para não divergir do que ele enxerga
    const rows: LedgerRecordedDatesInput[] = await em.query(RECORDED_DATES_SQL, [userId, [cardId]]);
    return new Map(
      rows.map((r) => [r.invoiceMonth, { closingDate: r.closingDate, dueDate: r.dueDate }]),
    );
  }
}
