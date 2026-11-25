import { User } from './entities/user.entity';
import { UserResponseDto } from './dto/user-response.dto';

export class UserMapper {
  static toDto(user: User): UserResponseDto {
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      plan: user.plan,
      preferredLanguage: user.preferredLanguage,
      authProvider: user.authProvider,
      documentType: user.documentType,
      document: user.document,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
