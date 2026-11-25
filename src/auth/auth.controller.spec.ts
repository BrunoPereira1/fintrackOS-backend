import { Test, TestingModule } from '@nestjs/testing';
import { HttpStatus } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthGuard } from './guards/auth.guard';
import { User } from '../users/entities/user.entity';
import { Plan } from '../users/enums/plan.enum';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { logout: jest.Mock };

  beforeEach(async () => {
    authService = { logout: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: authService }],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AuthController);
  });

  describe('POST /auth/logout', () => {
    const user = { id: 'uuid-1', firebaseUid: 'uid-1', plan: Plan.BASIC } as User;

    it('chama AuthService.logout com o firebaseUid do usuário autenticado', async () => {
      await expect(controller.logout(user)).resolves.toBeUndefined();
      expect(authService.logout).toHaveBeenCalledWith('uid-1');
    });

    it('responde 204 No Content e exige AuthGuard', () => {
      expect(Reflect.getMetadata(HTTP_CODE_METADATA, AuthController.prototype.logout)).toBe(
        HttpStatus.NO_CONTENT,
      );
      expect(Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.logout)).toContain(
        AuthGuard,
      );
    });
  });
});
