/** Fuso usado quando `APP_TIMEZONE` não está definida. */
export const DEFAULT_APP_TIMEZONE = 'America/Sao_Paulo';

/**
 * Fonte injetável de "hoje" para regras dependentes de data (sobrescreva o provider nos testes
 * ou use fake timers). A data de calendário é calculada no fuso `APP_TIMEZONE` da aplicação,
 * independente do `TZ` do processo. Registrada globalmente por `ClockModule`.
 */
export class Clock {
  private readonly formatter: Intl.DateTimeFormat;

  constructor(readonly timeZone: string = DEFAULT_APP_TIMEZONE) {
    try {
      this.formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch (err) {
      if (err instanceof RangeError) {
        throw new Error(`APP_TIMEZONE inválido: "${timeZone}" não é um fuso IANA reconhecido`);
      }
      throw err;
    }
  }

  /** Data de calendário no fuso da aplicação, no formato `YYYY-MM-DD`. */
  today(): string {
    const parts = this.formatter.formatToParts(new Date());
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }
}
