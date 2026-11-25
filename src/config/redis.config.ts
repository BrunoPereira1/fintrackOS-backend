import { SharedBullConfigurationFactory } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullRootModuleOptions } from '@nestjs/bullmq';
import { envReaderFrom, readRedisConnection, toIoRedisOptions } from './redis-connection';

@Injectable()
export class RedisConfig implements SharedBullConfigurationFactory {
  constructor(private readonly config: ConfigService) {}

  createSharedConfiguration(): BullRootModuleOptions {
    return {
      connection: toIoRedisOptions(readRedisConnection(envReaderFrom(this.config))),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    };
  }
}
