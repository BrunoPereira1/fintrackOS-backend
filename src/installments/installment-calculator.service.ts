import { BadRequestException, Injectable } from '@nestjs/common';
import { InstallmentStatus } from './installment-status.enum';
import { ErrorMessages } from '../common/constants/error-messages';
import { invoiceDates } from '../common/invoice-dates';
import { splitCents, toCents } from '../common/money';

interface CalculateInput {
  totalAmount: number;
  installmentsCount: number;
  /** Data da compra como veio da API: `YYYY-MM-DD` (ou ISO com hora — só a data é usada). */
  purchaseDate: string;
  card: { closingDay: number; dueDay: number };
  /**
   * D32: datas gravadas por fatura do cartão (D31), mês `YYYY-MM` → datas `YYYY-MM-DD`.
   * Omitido = só os dias atuais do cartão.
   */
  recordedDates?: ReadonlyMap<string, { closingDate: string; dueDate: string }>;
}

/** Parcela calculada, no formato das colunas de `Installment` (sem importar a entity). */
export interface CalculatedInstallment {
  number: number;
  totalInstallments: number;
  amount: number;
  /** Data local à meia-noite (critério do TypeORM para coluna `date`). */
  dueDate: Date;
  closingDate: Date;
  status: InstallmentStatus;
}

/** Mês absoluto (ano*12 + mês 0–11) → `YYYY-MM`. */
const monthKey = (abs: number) =>
  `${Math.floor(abs / 12)}-${String((abs % 12) + 1).padStart(2, '0')}`;

interface CalendarDate {
  year: number;
  /** 0–11, como em `Date`. */
  month: number;
  day: number;
}

@Injectable()
export class InstallmentCalculatorService {
  /**
   * Calcula as parcelas de uma compra no cartão:
   * 1. Fatura: compra até a véspera do fechamento entra na fatura que fecha no mesmo mês; a
   *    partir do dia de fechamento ("melhor dia de compra", como os bancos fazem), na fatura que
   *    fecha no mês seguinte.
   * 2. Vencimento: o primeiro `dueDay` posterior ao fechamento — no mesmo mês do fechamento se
   *    `dueDay > closingDay`, senão no mês seguinte (ex.: fecha 25, vence 5).
   * 3. Parcelas N+1: +1 mês cada (dias limitados a 1–28, então não há estouro de mês).
   * 4. Valor base = floor(total / n, 2 casas); diferença absorvida na última parcela.
   * 5. Fechamento (D14): cada parcela grava a data de fechamento da sua fatura (mês do
   *    vencimento), pela mesma regra de `invoiceDates` — sempre anterior ao vencimento.
   * 6. D32 (regra geral, que contém o item 1): a 1ª parcela vai para o primeiro mês M, varrendo
   *    a partir do mês da compra em ordem crescente, cujo **fechamento efetivo** — o gravado por
   *    fatura (D31) se M estiver em `recordedDates`, senão `invoiceDates(M, card)` — é **depois**
   *    da compra (estritamente: no próprio dia do fechamento vai para o seguinte). Começar no mês
   *    da compra é seguro: o fechamento de qualquer fatura M é anterior ao seu vencimento, que cai
   *    em M, então toda fatura de mês anterior ao da compra fechou antes dela. Sem gravação, a
   *    varredura dá exatamente o item 1 (o fechamento pelos dias cai no mês da compra, antes ou a
   *    partir do `closingDay`, ou no seguinte). Parcela em mês gravado recebe as datas gravadas;
   *    nos demais meses, as dos dias atuais.
   *
   * A data da compra é tratada como data de calendário, sem fuso: `new Date('2026-01-11')`
   * seria meia-noite UTC, que em UTC-3 ainda é dia 10 e mudaria a fatura.
   */
  calculate(input: CalculateInput): CalculatedInstallment[] {
    const { totalAmount, installmentsCount, card, recordedDates } = input;
    const purchase = this.parseCalendarDate(input.purchaseDate);
    const firstMonth = this.firstInvoiceMonth(
      purchase,
      input.purchaseDate.slice(0, 10),
      card,
      recordedDates,
    );
    const amounts = splitCents(toCents(totalAmount), installmentsCount);

    return Array.from({ length: installmentsCount }, (_, i) => {
      const month = monthKey(firstMonth + i);
      const { closingDate, dueDate } = recordedDates?.get(month) ?? invoiceDates(month, card);
      return {
        number: i + 1,
        totalInstallments: installmentsCount,
        amount: amounts[i] / 100,
        // Datas locais à meia-noite: é o que o TypeORM converte para a coluna `date`
        dueDate: this.toLocalDate(dueDate),
        closingDate: this.toLocalDate(closingDate),
        status: InstallmentStatus.PENDING,
      };
    });
  }

  /** `YYYY-MM-DD` → `Date` local à meia-noite (critério do TypeORM para coluna `date`). */
  private toLocalDate(value: string): Date {
    const { year, month, day } = this.parseCalendarDate(value);
    return new Date(year, month, day);
  }

  /**
   * D32: mês absoluto da 1ª fatura — o primeiro M ≥ mês da compra com fechamento efetivo (gravado,
   * senão pelos dias atuais) > data da compra (datas `YYYY-MM-DD` comparadas como string).
   * Termina: um mês sem gravação fecha em M−1 ou M, então a partir de mês da compra + 2 todo mês
   * não gravado fecha depois da compra — e os meses gravados são finitos.
   */
  private firstInvoiceMonth(
    purchase: CalendarDate,
    purchaseDate: string,
    card: CalculateInput['card'],
    recordedDates: CalculateInput['recordedDates'],
  ): number {
    let month = purchase.year * 12 + purchase.month;
    for (;;) {
      const key = monthKey(month);
      const closingDate = (recordedDates?.get(key) ?? invoiceDates(key, card)).closingDate;
      if (closingDate > purchaseDate) return month;
      month += 1;
    }
  }

  private parseCalendarDate(value: string): CalendarDate {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) throw new BadRequestException(ErrorMessages.INVALID_PURCHASE_DATE);
    const [year, month, day] = match.slice(1).map(Number);
    return { year, month: month - 1, day };
  }
}
