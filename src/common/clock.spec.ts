import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Clock, DEFAULT_APP_TIMEZONE } from './clock';
import { ClockModule } from './clock.module';

describe('Clock', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    jest.useRealTimers();
    process.env.TZ = originalTz;
  });

  // 23h30 de 24/11 em São Paulo (UTC-3) = 02h30 de 25/11 em UTC = 11h30 de 25/11 em Tóquio
  const INSTANT = new Date('2026-11-25T02:30:00Z');

  it('usa America/Sao_Paulo por padrão', () => {
    expect(DEFAULT_APP_TIMEZONE).toBe('America/Sao_Paulo');
    jest.useFakeTimers().setSystemTime(INSTANT);
    expect(new Clock().today()).toBe('2026-11-24');
  });

  it.each(['UTC', 'Asia/Tokyo'])('ignora o TZ do processo (TZ=%s)', (tz) => {
    process.env.TZ = tz;
    jest.useFakeTimers().setSystemTime(INSTANT);
    expect(new Clock('America/Sao_Paulo').today()).toBe('2026-11-24');
  });

  it('respeita um fuso customizado', () => {
    jest.useFakeTimers().setSystemTime(INSTANT);
    expect(new Clock('Asia/Tokyo').today()).toBe('2026-11-25');
  });

  it('formata com zero à esquerda (YYYY-MM-DD)', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-05T15:00:00Z'));
    expect(new Clock('America/Sao_Paulo').today()).toBe('2026-03-05');
  });

  it('acompanha a passagem do tempo (formatter reaproveitado)', () => {
    const clock = new Clock('America/Sao_Paulo');
    jest.useFakeTimers().setSystemTime(new Date('2026-12-31T23:00:00-03:00'));
    expect(clock.today()).toBe('2026-12-31');
    jest.setSystemTime(new Date('2027-01-01T00:00:00-03:00'));
    expect(clock.today()).toBe('2027-01-01');
  });

  it('fuso inválido lança erro citando APP_TIMEZONE', () => {
    expect(() => new Clock('Marte/Olympus')).toThrow(/APP_TIMEZONE.*Marte\/Olympus/);
  });
});

describe('ClockModule', () => {
  const originalEnv = process.env.APP_TIMEZONE;
  afterEach(() => {
    jest.useRealTimers();
    if (originalEnv === undefined) delete process.env.APP_TIMEZONE;
    else process.env.APP_TIMEZONE = originalEnv;
  });

  const build = () =>
    Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), ClockModule],
    }).compile();

  it('lê APP_TIMEZONE via ConfigService', async () => {
    process.env.APP_TIMEZONE = 'Asia/Tokyo';
    const moduleRef = await build();
    jest.useFakeTimers().setSystemTime(new Date('2026-11-25T02:30:00Z'));
    expect(moduleRef.get(Clock).today()).toBe('2026-11-25');
  });

  it('sem APP_TIMEZONE usa o padrão', async () => {
    delete process.env.APP_TIMEZONE;
    const moduleRef = await build();
    jest.useFakeTimers().setSystemTime(new Date('2026-11-25T02:30:00Z'));
    expect(moduleRef.get(Clock).today()).toBe('2026-11-24');
  });

  it('APP_TIMEZONE inválido derruba a inicialização', async () => {
    process.env.APP_TIMEZONE = 'Nao/Existe';
    await expect(build()).rejects.toThrow(/APP_TIMEZONE/);
  });
});
