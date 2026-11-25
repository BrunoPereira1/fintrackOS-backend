import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../auth/guards/auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { User } from './entities/user.entity';
import { UsersService } from './users.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { UserMapper } from './user.mapper';

@ApiTags('users')
@ApiBearerAuth('firebase-jwt')
@UseGuards(AuthGuard)
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOkResponse({ type: UserResponseDto })
  getProfile(@CurrentUser() user: User): UserResponseDto {
    return UserMapper.toDto(user);
  }

  @Patch('me')
  @ApiOkResponse({ type: UserResponseDto })
  async updateProfile(
    @CurrentUser() user: User,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    return UserMapper.toDto(await this.usersService.updateProfile(user.id, dto));
  }
}
