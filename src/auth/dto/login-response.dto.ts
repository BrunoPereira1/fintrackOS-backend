import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '../../users/dto/user-response.dto';

export class LoginResponseDto {
  @ApiProperty({ description: 'Firebase ID token — usar como Bearer em todas as requisições' })
  idToken!: string;

  @ApiProperty({ description: 'Token para renovar o idToken quando expirar' })
  refreshToken!: string;

  @ApiProperty({ description: 'Segundos até o idToken expirar (padrão: 3600)' })
  expiresIn!: number;

  @ApiProperty({ type: () => UserResponseDto })
  user!: UserResponseDto;
}
