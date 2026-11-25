import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InvoiceParamsDto, MonthParamDto } from './report-params.dto';
import { ReceivablesQueryDto } from './receivables.dto';

const errorsOf = async (cls: new () => object, plain: object) =>
  (await validate(plainToInstance(cls, plain))).map((e) => e.property);

describe('parâmetros dos relatórios', () => {
  it.each(['2026-01', '2026-12', '1999-07'])('aceita mês %s', async (month) => {
    expect(await errorsOf(MonthParamDto, { month })).toEqual([]);
  });

  it.each(['2026-13', '2026-00', '2026-1', '26-01', '2026-01-01', 'marco'])(
    'rejeita mês %s',
    async (month) => {
      expect(await errorsOf(MonthParamDto, { month })).toEqual(['month']);
    },
  );

  it('fatura exige cardId UUID', async () => {
    expect(await errorsOf(InvoiceParamsDto, { month: '2026-03', cardId: 'abc' })).toEqual([
      'cardId',
    ]);
  });
});

describe('query de "quem me deve"', () => {
  it('status padrão é pending', () => {
    expect(plainToInstance(ReceivablesQueryDto, {}).status).toBe('pending');
  });

  it.each(['pending', 'paid', 'all'])('aceita status=%s', async (status) => {
    expect(await errorsOf(ReceivablesQueryDto, { status })).toEqual([]);
  });

  it('rejeita status inválido e contactId que não é UUID', async () => {
    expect(await errorsOf(ReceivablesQueryDto, { status: 'overdue', contactId: '1' })).toEqual([
      'status',
      'contactId',
    ]);
  });
});
