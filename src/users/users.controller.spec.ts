import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { User, PreferredLanguage } from './entities/user.entity';
import { Plan } from './enums/plan.enum';

const mockUser = (): User =>
  ({
    id: 'uuid-1',
    firebaseUid: 'firebase-uid-1',
    email: 'test@example.com',
    displayName: 'Test User',
    plan: Plan.BASIC,
    preferredLanguage: PreferredLanguage.PT_BR,
    authProvider: 'password',
    documentType: null,
    document: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as User;

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: { updateProfile: jest.Mock };

  beforeEach(async () => {
    usersService = { updateProfile: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [{ provide: UsersService, useValue: usersService }],
    }).compile();

    controller = module.get(UsersController);
  });

  it('GET /users/me devolve UserResponseDto sem firebaseUid', () => {
    const result = controller.getProfile(mockUser());

    expect(result).not.toHaveProperty('firebaseUid');
    expect(result).toMatchObject({ id: 'uuid-1', email: 'test@example.com', plan: Plan.BASIC });
  });

  it('PATCH /users/me devolve UserResponseDto sem firebaseUid', async () => {
    usersService.updateProfile.mockResolvedValue({ ...mockUser(), displayName: 'Novo' });

    const result = await controller.updateProfile(mockUser(), { displayName: 'Novo' });

    expect(usersService.updateProfile).toHaveBeenCalledWith('uuid-1', { displayName: 'Novo' });
    expect(result).not.toHaveProperty('firebaseUid');
    expect(result.displayName).toBe('Novo');
  });
});
