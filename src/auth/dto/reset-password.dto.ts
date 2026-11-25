import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ description: 'Código oobCode recebido no link do email de redefinição' })
  @IsString()
  @MaxLength(2048)
  oobCode!: string;

  @ApiProperty({ example: 'NovaSenha@456', minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword!: string;
}
