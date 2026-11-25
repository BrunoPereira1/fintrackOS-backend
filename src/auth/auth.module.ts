import { Module, Global } from '@nestjs/common';
import { PassportModule } from '@nestjs/passport';
import { UsersModule } from '../users/users.module';
import { FirebaseStrategy } from './firebase.strategy';
import { TokenCacheModule } from './token-cache.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { FirebaseAuthService } from './firebase-auth.service';

@Global()
@Module({
  imports: [PassportModule, UsersModule, TokenCacheModule],
  controllers: [AuthController],
  providers: [FirebaseStrategy, AuthService, FirebaseAuthService],
  exports: [PassportModule, TokenCacheModule],
})
export class AuthModule {}
