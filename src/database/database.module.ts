import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { buildTypeOrmConfig } from '../config';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        buildTypeOrmConfig({
          NODE_ENV: config.get('NODE_ENV'),
          DATABASE_URL: config.get('DATABASE_URL'),
          DB_HOST: config.get('DB_HOST'),
          DB_PORT: config.get('DB_PORT'),
          DB_USERNAME: config.get('DB_USERNAME'),
          DB_PASSWORD: config.get('DB_PASSWORD'),
          DB_NAME: config.get('DB_NAME'),
          DB_SSL: config.get('DB_SSL'),
          DB_SSL_CA: config.get('DB_SSL_CA'),
          DB_SSL_REJECT_UNAUTHORIZED: config.get('DB_SSL_REJECT_UNAUTHORIZED'),
          DB_LOGGING: config.get('DB_LOGGING'),
        }),
    }),
  ],
})
export class DatabaseModule {}
