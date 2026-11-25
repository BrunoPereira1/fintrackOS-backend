import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { CardsService } from '../cards/cards.service';
import { Clock } from '../common/clock';
import { hasRequiredPlan } from '../auth/plan-access';
import { Plan } from '../users/enums/plan.enum';
import { SplitStatus } from '../splits/entities/cost-split.entity';
import { ErrorMessages } from '../common/constants/error-messages';
import { InvoiceLedgerQuery } from '../invoices/invoice-ledger.query';
import { buildInvoiceView } from '../invoices/invoice-ledger.calculator';
import { mergeInstallmentStates } from '../installments/installment-state';
import {
  buildInvoice,
  buildMonthlySummary,
  InvoiceItemDetail,
  monthRange,
  SummaryChargeRow,
  SummaryInstallmentRow,
  SummaryPaymentRow,
  SummaryTransactionRow,
} from './reports.calculator';
import { InvoiceResponseDto } from './dto/invoice-response.dto';
import { MonthlySummaryResponseDto } from './dto/monthly-summary-response.dto';
import { ReceivablesResponseDto } from './dto/receivables.dto';
import {
  buildReceivables,
  ReceivableInstallmentRow,
  ReceivableSplitRow,
  ReceivablesStatusFilter,
} from './receivables.calculator';

/**
 * Visões de leitura agregada (exceção de arquitetura: joins entre domínios, somente leitura,
 * sempre filtrando por user_id). Regras de cálculo em `reports.calculator.ts`; status de parcela
 * de cartão, encargos e pagamentos vêm do razão (`InvoiceLedgerQuery`, spec 2026-11-24 §2).
 *
 * Datas são formatadas no SQL (`to_char`): em consultas raw o driver pg devolve `date` como
 * objeto `Date`, o que reintroduziria problema de fuso.
 */
@Injectable()
export class ReportsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly cardsService: CardsService,
    private readonly ledgers: InvoiceLedgerQuery,
    private readonly clock: Clock,
  ) {}

  /**
   * Fatura do mês pelo razão do cartão (§2). Posse via `CardsService.findOne` (404/403, inclusive
   * cartão arquivado). Razão e dados descritivos lidos no mesmo snapshot.
   */
  async getInvoice(userId: string, cardId: string, month: string): Promise<InvoiceResponseDto> {
    const card = await this.cardsService.findOne(cardId, userId); // 404/403

    return this.snapshot(async (em) => {
      const ledger = await this.ledgers.loadLedger(userId, cardId, em);
      if (!ledger) throw new NotFoundException(ErrorMessages.NOT_FOUND.CARD); // removido no meio
      const view = buildInvoiceView(ledger, month);

      const installmentIds = view.installments.map((i) => i.id);
      const details = installmentIds.length
        ? await em
            .createQueryBuilder()
            .select('i.id', 'installmentId')
            .addSelect('t.description', 'description')
            .addSelect('t.category', 'category')
            .addSelect(`to_char(t.date, 'YYYY-MM-DD')`, 'purchaseDate')
            .addSelect('i.total_installments', 'totalInstallments')
            .from('installments', 'i')
            .innerJoin('transactions', 't', 't.id = i.transaction_id')
            .where('t.user_id = :userId', { userId })
            .andWhere('i.id IN (:...installmentIds)', { installmentIds })
            .getRawMany<InvoiceItemDetail>()
        : [];

      const charges = view.charges.length
        ? await em
            .createQueryBuilder()
            .select('ch.id', 'id')
            .addSelect('ch.description', 'description')
            .from('invoice_charges', 'ch')
            .where('ch.user_id = :userId', { userId })
            .andWhere('ch.card_id = :cardId', { cardId })
            .andWhere('ch.invoice_month = :month', { month })
            .getRawMany<{ id: string; description: string | null }>()
        : [];

      return buildInvoice({
        card,
        view,
        details: new Map(details.map((d) => [d.installmentId, d])),
        chargeDescriptions: new Map(charges.map((c) => [c.id, c.description])),
      });
    });
  }

  /**
   * Resumo do mês (§7, D16, D21–D23). Status das parcelas de cartão, encargos e pagamentos vêm
   * do razão de todos os cartões do usuário (inclusive arquivados), no mesmo snapshot.
   */
  async getMonthlySummary(
    userId: string,
    userPlan: Plan,
    month: string,
  ): Promise<MonthlySummaryResponseDto> {
    const { start, endExclusive } = monthRange(month);
    const range = { userId, start, endExclusive };
    const today = this.clock.today(); // um único "hoje" para o razão e o resumo

    return this.snapshot(async (em) => {
      const installments = await em
        .createQueryBuilder()
        .select('i.id', 'id')
        .addSelect('i.amount', 'amount')
        .addSelect('i.status', 'status')
        .addSelect(`to_char(i.due_date, 'YYYY-MM-DD')`, 'dueDate')
        .addSelect('t.category', 'category')
        .addSelect('t.card_id', 'cardId')
        .addSelect('c.name', 'cardName')
        .from('installments', 'i')
        .innerJoin('transactions', 't', 't.id = i.transaction_id')
        // posse também no cartão (defesa em profundidade; a FK já garante o mesmo dono)
        .leftJoin('credit_cards', 'c', 'c.id = t.card_id AND c.user_id = :userId')
        .where('t.user_id = :userId')
        .andWhere('i.due_date >= :start AND i.due_date < :endExclusive')
        .setParameters(range)
        .getRawMany<SummaryInstallmentRow>();

      // "Sem parcelas" e não "sem cartão": cartão removido deixa card_id nulo mas mantém parcelas
      const transactions = await em
        .createQueryBuilder()
        .select('t.total_amount', 'totalAmount')
        .addSelect('t.category', 'category')
        .addSelect('t.payment_method', 'paymentMethod')
        .from('transactions', 't')
        .where('t.user_id = :userId')
        .andWhere('t.date >= :start AND t.date < :endExclusive')
        .andWhere('NOT EXISTS (SELECT 1 FROM installments i WHERE i.transaction_id = t.id)')
        .setParameters(range)
        .getRawMany<SummaryTransactionRow>();

      let receivablesPending: string[] | null = null;
      if (hasRequiredPlan(userPlan, Plan.PREMIUM)) {
        const rows = await em
          .createQueryBuilder()
          .select('s.assigned_amount', 'amount')
          .from('cost_splits', 's')
          .innerJoin('transactions', 't', 't.id = s.transaction_id')
          .where('t.user_id = :userId')
          .andWhere('s.status = :pending')
          .andWhere('t.date >= :start AND t.date < :endExclusive')
          .setParameters({ ...range, pending: SplitStatus.PENDING })
          .getRawMany<{ amount: string }>();
        receivablesPending = rows.map((r) => r.amount);
      }

      const ledgers = await this.ledgers.loadLedgers(userId, { em, today });
      const charges: SummaryChargeRow[] = [];
      const invoicePayments: SummaryPaymentRow[] = [];
      for (const [cardId, ledger] of ledgers) {
        for (const item of ledger.items) {
          if (item.kind === 'charge' && item.invoiceMonth === month) {
            charges.push({
              cardId,
              cardName: null,
              invoiceMonth: month,
              amount: item.amountCents / 100,
            });
          }
        }
        invoicePayments.push(...ledger.payments);
      }
      if (charges.length) {
        const names = await this.cardNames(em, userId, [...new Set(charges.map((c) => c.cardId))]);
        for (const c of charges) c.cardName = names.get(c.cardId) ?? null;
      }

      return buildMonthlySummary({
        month,
        today,
        installments,
        installmentStates: mergeInstallmentStates(ledgers.values()),
        charges,
        invoicePayments,
        transactions,
        receivablesPending,
      });
    });
  }

  /**
   * "Quem me deve": splits agrupados por contato (regras em receivables.calculator.ts). O
   * `contactId` é filtro de listagem: contato inexistente ou de outro usuário → resultado vazio
   * (o SQL já filtra `c.user_id`), nunca 404/403 — não revela existência (business-rules §6).
   */
  async getReceivables(
    userId: string,
    filter: { status: ReceivablesStatusFilter; contactId?: string },
  ): Promise<ReceivablesResponseDto> {
    const today = this.clock.today(); // um único "hoje" para o razão e o progresso
    return this.snapshot(async (em) => {
      // Somas por contato são históricas: o filtro de status é aplicado só na lista (calculator)
      const splitsQuery = em
        .createQueryBuilder()
        .select('s.id', 'splitId')
        .addSelect('s.contact_id', 'contactId')
        .addSelect('c.name', 'contactName')
        .addSelect('c.email', 'contactEmail')
        .addSelect('t.id', 'transactionId')
        .addSelect('t.description', 'description')
        .addSelect(`to_char(t.date, 'YYYY-MM-DD')`, 'transactionDate')
        .addSelect('s.assigned_amount', 'assignedAmount')
        .addSelect('s.status', 'status')
        .addSelect(
          `to_char(s.paid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          'paidAt',
        )
        .from('cost_splits', 's')
        .innerJoin('transactions', 't', 't.id = s.transaction_id')
        .innerJoin('contacts', 'c', 'c.id = s.contact_id')
        // posse pelos dois lados: transação e contato do usuário
        .where('t.user_id = :userId', { userId })
        .andWhere('c.user_id = :userId', { userId });
      if (filter.contactId) {
        splitsQuery.andWhere('s.contact_id = :contactId', { contactId: filter.contactId });
      }
      const splits = await splitsQuery.getRawMany<ReceivableSplitRow>();

      const transactionIds = [...new Set(splits.map((s) => s.transactionId))];
      const installments = transactionIds.length
        ? await em
            .createQueryBuilder()
            .select('i.id', 'id')
            .addSelect('i.transaction_id', 'transactionId')
            .addSelect('t.card_id', 'cardId')
            .addSelect('i.status', 'status')
            .addSelect('i.amount', 'amount')
            .addSelect(`to_char(i.due_date, 'YYYY-MM-DD')`, 'dueDate')
            .from('installments', 'i')
            .innerJoin('transactions', 't', 't.id = i.transaction_id')
            .where('t.user_id = :userId', { userId })
            .andWhere('i.transaction_id IN (:...transactionIds)', { transactionIds })
            .getRawMany<ReceivableInstallmentRow>()
        : [];

      // Progresso derivado do razão (paga = totalmente coberta); órfãs pelo status gravado (D18)
      const cardIds = [...new Set(installments.flatMap((i) => (i.cardId ? [i.cardId] : [])))];
      const ledgers = await this.ledgers.loadLedgers(userId, { cardIds, em, today });

      return buildReceivables({
        status: filter.status,
        splits,
        installments,
        installmentStates: mergeInstallmentStates(ledgers.values()),
        today,
      });
    });
  }

  /** Nomes dos cartões do usuário (inclusive arquivados) — para `byCard` de cartão só com encargo. */
  private async cardNames(
    em: EntityManager,
    userId: string,
    cardIds: string[],
  ): Promise<Map<string, string>> {
    const rows = await em
      .createQueryBuilder()
      .select('c.id', 'id')
      .addSelect('c.name', 'name')
      .from('credit_cards', 'c')
      .where('c.user_id = :userId', { userId })
      .andWhere('c.id IN (:...cardIds)', { cardIds })
      .getRawMany<{ id: string; name: string }>();
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * Leituras de uma visão num único snapshot (`REPEATABLE READ`, só leitura): o razão e as
   * linhas descritivas/agregadas enxergam o mesmo estado mesmo com escritas concorrentes.
   */
  private snapshot<T>(work: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction('REPEATABLE READ', work);
  }
}
