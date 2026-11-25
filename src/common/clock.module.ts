import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock, DEFAULT_APP_TIMEZONE } from './clock';

/**
 * Provider global de `Clock`, no fuso `APP_TIMEZONE` (padrão `America/Sao_Paulo`).
 * Fuso inválido derruba o boot. Depende do `ConfigModule` global.
 */
@Global()
@Module({
  providers: [
    {
      provide: Clock,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Clock(config.get<string>('APP_TIMEZONE')?.trim() || DEFAULT_APP_TIMEZONE),
    },
  ],
  exports: [Clock],
})
export class ClockModule {}
