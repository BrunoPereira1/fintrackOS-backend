import { Logger } from '@nestjs/common';
import { NotificationsService, maskPhone } from './notifications.service';

describe('maskPhone', () => {
  it('mantém só os 4 últimos dígitos', () => {
    expect(maskPhone('+55 (11) 98765-4321')).toBe('***4321');
  });

  it('mascara totalmente números curtos', () => {
    expect(maskPhone('123')).toBe('***');
  });
});

describe('NotificationsService', () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('não loga o telefone completo', async () => {
    process.env.WHATSAPP_API_TOKEN = 'token';
    process.env.WHATSAPP_PHONE_NUMBER_ID = 'id';
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await new NotificationsService().sendWhatsApp({ to: '+5511987654321', body: 'oi' });

    const logged = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('***4321');
    expect(logged).not.toContain('987654321');
  });
});
