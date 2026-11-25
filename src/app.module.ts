import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { HeaderResolver, AcceptLanguageResolver } from 'nestjs-i18n';
import { I18nModule } from 'nestjs-i18n';
import { APP_GUARD } from '@nestjs/core';
import { CacheModule } from '@nestjs/cache-manager';
import { ThrottlerModule } from '@nestjs/throttler';
import * as path from 'path';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { CardsModule } from './cards/cards.module';
import { TransactionsModule } from './transactions/transactions.module';
import { InstallmentsModule } from './installments/installments.module';
import { SplitsModule } from './splits/splits.module';
import { ContactsModule } from './contacts/contacts.module';
import { AssetsModule } from './assets/assets.module';
import { OcrModule } from './ocr/ocr.module';
import { NotificationsModule } from './notifications/notifications.module';
import { HealthModule } from './health/health.module';
import { ReportsModule } from './reports/reports.module';
import { BullModule } from '@nestjs/bullmq';
import { ClockModule } from './common/clock.module';
import {
  CacheConfig,
  ThrottlerStorageRedis,
  AppThrottlerGuard,
  createRedisClientForThrottler,
  envReaderFrom,
  RedisConfig,
} from './config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      useClass: CacheConfig,
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = createRedisClientForThrottler(envReaderFrom(config));
        return {
          throttlers: [
            {
              name: 'short',
              ttl: 1000, // 1s
              limit: config.get<number>('THROTTLE_SHORT_LIMIT', 10),
            },
            {
              name: 'medium',
              ttl: 60_000, // 60s
              limit: config.get<number>('THROTTLE_MEDIUM_LIMIT', 120),
            },
          ],
          storage: new ThrottlerStorageRedis(redis),
        };
      },
    }),
    I18nModule.forRoot({
      fallbackLanguage: 'pt-BR',
      loaderOptions: {
        path: path.join(__dirname, 'i18n/translations'),
        watch: true,
      },
      resolvers: [{ use: HeaderResolver, options: ['x-lang'] }, AcceptLanguageResolver],
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      useClass: RedisConfig,
    }),
    ClockModule,
    DatabaseModule,
    AuthModule,
    UsersModule,
    CardsModule,
    TransactionsModule,
    InstallmentsModule,
    SplitsModule,
    ContactsModule,
    AssetsModule,
    OcrModule,
    NotificationsModule,
    ReportsModule,
    HealthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: AppThrottlerGuard }],
})
export class AppModule {}
