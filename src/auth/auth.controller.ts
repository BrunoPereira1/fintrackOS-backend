import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { UserResponseDto } from '../users/dto/user-response.dto';
import { UserMapper } from '../users/user.mapper';
import { User } from '../users/entities/user.entity';
import { AuthGuard } from './guards/auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Throttle({ short: { limit: 3, ttl: 60_000 }, medium: { limit: 10, ttl: 600_000 } })
  @ApiOperation({ summary: 'Registrar novo usuário com email e senha' })
  @ApiResponse({ status: HttpStatus.CREATED, type: UserResponseDto })
  @ApiResponse({ status: HttpStatus.CONFLICT, description: 'Email já cadastrado' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Provedor de identidade ou rate limit (Redis) indisponível; tente novamente',
  })
  async register(@Body() dto: RegisterDto): Promise<UserResponseDto> {
    const user = await this.authService.register(dto);
    return UserMapper.toDto(user);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ short: { limit: 5, ttl: 60_000 }, medium: { limit: 20, ttl: 600_000 } })
  @ApiOperation({ summary: 'Login com email e senha' })
  @ApiResponse({ status: HttpStatus.OK, type: LoginResponseDto })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Email ou senha inválidos' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Provedor de identidade ou rate limit (Redis) indisponível; tente novamente',
  })
  login(@Body() dto: LoginDto): Promise<LoginResponseDto> {
    return this.authService.login(dto);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  @ApiBearerAuth('firebase-jwt')
  @ApiOperation({
    summary: 'Encerrar todas as sessões do usuário',
    description:
      'Revoga os refresh tokens no Firebase e invalida todas as sessões em cache do usuário. ' +
      'ID tokens emitidos antes do logout passam a ser rejeitados em todos os dispositivos.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Sessões encerradas' })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Token ausente ou inválido' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Falha ao revogar no Firebase; tente novamente',
  })
  async logout(@CurrentUser() user: User): Promise<void> {
    await this.authService.logout(user.firebaseUid);
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ short: { limit: 3, ttl: 60_000 }, medium: { limit: 5, ttl: 600_000 } })
  @ApiOperation({ summary: 'Enviar email de redefinição de senha' })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Email enviado (resposta idêntica mesmo se o endereço não existir)',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Provedor de identidade ou rate limit (Redis) indisponível; tente novamente',
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto): Promise<void> {
    await this.authService.forgotPassword(dto.email);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ short: { limit: 5, ttl: 60_000 }, medium: { limit: 10, ttl: 600_000 } })
  @ApiOperation({ summary: 'Redefinir senha com o código recebido por email' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT, description: 'Senha redefinida com sucesso' })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Código expirado ou inválido' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'Provedor de identidade ou rate limit (Redis) indisponível; tente novamente',
  })
  async resetPassword(@Body() dto: ResetPasswordDto): Promise<void> {
    await this.authService.resetPassword(dto.oobCode, dto.newPassword);
  }
}
