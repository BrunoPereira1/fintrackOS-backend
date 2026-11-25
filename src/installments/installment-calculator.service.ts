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
   *
   * A data da compra é tratada como data de calendário, sem fuso: `new Date('2026-01-11')`
   * seria meia-noite UTC, que em UTC-3 ainda é dia 10 e mudaria a fatura.
   */
  calculate(input: CalculateInput): CalculatedInstallment[] {
    const { totalAmount, installmentsCount, card } = input;
    const purchase = this.parseCalendarDate(input.purchaseDate);

    const firstDue = this.resolveFirstDueDate(purchase, card);
    const amounts = splitCents(toCents(totalAmount), installmentsCount);

    return Array.from({ length: installmentsCount }, (_, i) => {
      const dueMonth = firstDue.year * 12 + firstDue.month + i;
      const { closingDate } = invoiceDates(
        `${Math.floor(dueMonth / 12)}-${String((dueMonth % 12) + 1).padStart(2, '0')}`,
        card,
      );
      return {
        number: i + 1,
        totalInstallments: installmentsCount,
        amount: amounts[i] / 100,
        // Datas locais à meia-noite: é o que o TypeORM converte para a coluna `date`
        dueDate: new Date(firstDue.year, firstDue.month + i, firstDue.day),
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

  private resolveFirstDueDate(purchase: CalendarDate, card: CalculateInput['card']): CalendarDate {
    // Mês (absoluto) em que a fatura da compra fecha
    let closingMonth = purchase.year * 12 + purchase.month;
    // No dia do fechamento a fatura já fechou: é o "melhor dia de compra"
    if (purchase.day >= card.closingDay) closingMonth += 1;

    // O vencimento vem sempre depois do fechamento
    const dueMonth = card.dueDay > card.closingDay ? closingMonth : closingMonth + 1;

    return { year: Math.floor(dueMonth / 12), month: dueMonth % 12, day: card.dueDay };
  }

  private parseCalendarDate(value: string): CalendarDate {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!match) throw new BadRequestException(ErrorMessages.INVALID_PURCHASE_DATE);
    const [year, month, day] = match.slice(1).map(Number);
    return { year, month: month - 1, day };
  }
}
