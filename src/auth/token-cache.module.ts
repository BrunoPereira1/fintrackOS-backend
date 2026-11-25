import { Module } from '@nestjs/common';
import { TokenCacheService } from './token-cache.service';

/**
 * Módulo folha do cache de sessões. Depende só do CACHE_MANAGER (global), então pode ser
 * importado tanto pelo AuthModule quanto pelo UsersModule sem ciclo AuthModule ↔ UsersModule.
 */
@Module({
  providers: [TokenCacheService],
  exports: [TokenCacheService],
})
export class TokenCacheModule {}
