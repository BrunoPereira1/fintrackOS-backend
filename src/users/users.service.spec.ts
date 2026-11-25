import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { UsersService } from './users.service';
import { TokenCacheService } from '../auth/token-cache.service';
import { User } from './entities/user.entity';
import { Plan } from './enums/plan.enum';
import { PreferredLanguage } from './entities/user.entity';
import { DocumentType } from './enums/document-type.enum';

const VALID_CPF = '529.982.247-25';
const VALID_CPF_DIGITS = '52998224725';

const uniqueViolation = (constraint: string) =>
  new QueryFailedError(
    'INSERT ...',
    [],
    Object.assign(new Error('duplicate key'), { code: '23505', constraint }),
  );

const mockUser = (): User =>
  ({
    id: 'uuid-1',
    firebaseUid: 'firebase-uid-1',
    email: 'test@example.com',
    displayName: 'Test User',
    plan: Plan.BASIC,
    preferredLanguage: PreferredLanguage.PT_BR,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as User;

describe('UsersService', () => {
  let service: UsersService;
  let repo: jest.Mocked<Repository<User>>;
  let tokenCache: { invalidateAllSessions: jest.Mock };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        {
          provide: getRepositoryToken(User),
          useValue: {
            findOne: jest.fn(),
            create: jest.fn(),
            save: jest.fn(),
            exists: jest.fn().mockResolvedValue(false),
          },
        },
        {
          provide: TokenCacheService,
          useValue: { invalidateAllSessions: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    service = module.get(UsersService);
    repo = module.get(getRepositoryToken(User));
    tokenCache = module.get(TokenCacheService);
  });

  describe('findOrCreate', () => {
    it('returns existing user when found by firebaseUid', async () => {
      const user = mockUser();
      repo.findOne.mockResolvedValue(user);

      const result = await service.findOrCreate({
        firebaseUid: user.firebaseUid,
        email: user.email,
      });

      expect(result).toBe(user);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates and returns a new user when not found', async () => {
      const user = mockUser();
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(user);
      repo.save.mockResolvedValue(user);

      const result = await service.findOrCreate({
        firebaseUid: user.firebaseUid,
        email: user.email,
        displayName: 'Test User',
      });

      expect(repo.create).toHaveBeenCalledWith({
        firebaseUid: user.firebaseUid,
        email: user.email,
        displayName: 'Test User',
        authProvider: 'password',
        documentType: null,
        document: null,
      });
      expect(repo.save).toHaveBeenCalledWith(user);
      expect(result).toBe(user);
    });

    it('corrida em UQ_users_firebase_uid (requisições paralelas) → relê e devolve o usuário', async () => {
      const user = mockUser();
      repo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(user);
      repo.create.mockReturnValue({ ...user } as User);
      repo.save.mockRejectedValue(uniqueViolation('UQ_users_firebase_uid'));

      const result = await service.findOrCreate({
        firebaseUid: user.firebaseUid,
        email: user.email,
      });

      expect(result).toBe(user);
      expect(repo.findOne).toHaveBeenCalledTimes(2);
      expect(repo.findOne).toHaveBeenLastCalledWith({
        where: { firebaseUid: user.firebaseUid },
      });
    });

    it('violação de outra constraint (UQ_users_document) é propagada sem reler', async () => {
      const err = uniqueViolation('UQ_users_document');
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockUser());
      repo.save.mockRejectedValue(err);

      await expect(
        service.findOrCreate({ firebaseUid: 'firebase-uid-1', email: 'test@example.com' }),
      ).rejects.toBe(err);
      expect(repo.findOne).toHaveBeenCalledTimes(1);
    });

    it('corrida mas a releitura não encontra o usuário → propaga o erro original', async () => {
      const err = uniqueViolation('UQ_users_firebase_uid');
      repo.findOne.mockResolvedValue(null);
      repo.create.mockReturnValue(mockUser());
      repo.save.mockRejectedValue(err);

      await expect(
        service.findOrCreate({ firebaseUid: 'firebase-uid-1', email: 'test@example.com' }),
      ).rejects.toBe(err);
    });
  });

  describe('findById', () => {
    it('returns user when found', async () => {
      const user = mockUser();
      repo.findOne.mockResolvedValue(user);

      const result = await service.findById('uuid-1');
      expect(result).toBe(user);
    });

    it('throws NotFoundException when user does not exist', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findById('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateProfile', () => {
    it('updates and returns the user', async () => {
      const user = mockUser();
      const updated = { ...user, displayName: 'Updated Name' } as User;
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue(updated);

      const result = await service.updateProfile('uuid-1', { displayName: 'Updated Name' });

      expect(repo.save).toHaveBeenCalled();
      expect(result.displayName).toBe('Updated Name');
    });

    it('normaliza e grava documento livre, checando outros usuários (Not(id))', async () => {
      const user = mockUser();
      repo.findOne.mockResolvedValue(user);
      repo.save.mockImplementation(async (u) => u as User);

      const result = await service.updateProfile('uuid-1', {
        documentType: DocumentType.CPF,
        document: VALID_CPF,
      });

      expect(repo.exists).toHaveBeenCalledWith({
        where: { document: VALID_CPF_DIGITS, id: expect.anything() },
      });
      expect(result.document).toBe(VALID_CPF_DIGITS);
      expect(tokenCache.invalidateAllSessions).toHaveBeenCalledWith('firebase-uid-1');
    });

    it('derruba todas as sessões e o perfil em cache após salvar (ex.: troca de plano)', async () => {
      const user = mockUser();
      repo.findOne.mockResolvedValue(user);
      repo.save.mockImplementation(async (u) => u as User);

      await service.updateProfile('uuid-1', { displayName: 'X' });

      expect(tokenCache.invalidateAllSessions).toHaveBeenCalledWith('firebase-uid-1');
      expect(repo.save.mock.invocationCallOrder[0]).toBeLessThan(
        tokenCache.invalidateAllSessions.mock.invocationCallOrder[0],
      );
    });

    it('não invalida sessões quando o save falha', async () => {
      repo.findOne.mockResolvedValue(mockUser());
      repo.save.mockRejectedValue(new Error('db down'));

      await expect(service.updateProfile('uuid-1', { displayName: 'X' })).rejects.toThrow();
      expect(tokenCache.invalidateAllSessions).not.toHaveBeenCalled();
    });

    it('lança BadRequest (não 500) quando o documento já pertence a outro usuário', async () => {
      repo.findOne.mockResolvedValue(mockUser());
      repo.exists.mockResolvedValue(true);

      await expect(
        service.updateProfile('uuid-1', { documentType: DocumentType.CPF, document: VALID_CPF }),
      ).rejects.toThrow(new BadRequestException('Document cannot be used'));
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('converte violação de UQ_users_document no save (corrida) em BadRequest', async () => {
      repo.findOne.mockResolvedValue(mockUser());
      repo.save.mockRejectedValue(uniqueViolation('UQ_users_document'));

      await expect(
        service.updateProfile('uuid-1', { documentType: DocumentType.CPF, document: VALID_CPF }),
      ).rejects.toThrow(BadRequestException);
    });

    it('não mascara outros erros de banco', async () => {
      repo.findOne.mockResolvedValue(mockUser());
      repo.save.mockRejectedValue(uniqueViolation('UQ_users_email'));

      await expect(
        service.updateProfile('uuid-1', { documentType: DocumentType.CPF, document: VALID_CPF }),
      ).rejects.toThrow(QueryFailedError);
    });

    it('não consulta documento quando ele não é alterado', async () => {
      repo.findOne.mockResolvedValue(mockUser());
      repo.save.mockImplementation(async (u) => u as User);

      await service.updateProfile('uuid-1', { displayName: 'X' });
      expect(repo.exists).not.toHaveBeenCalled();
    });
  });

  describe('assertDocumentAvailable', () => {
    it('resolve quando ninguém usa o documento', async () => {
      await expect(service.assertDocumentAvailable(VALID_CPF_DIGITS)).resolves.toBeUndefined();
      expect(repo.exists).toHaveBeenCalledWith({ where: { document: VALID_CPF_DIGITS } });
    });

    it('lança BadRequest genérica quando o documento está em uso', async () => {
      repo.exists.mockResolvedValue(true);
      await expect(service.assertDocumentAvailable(VALID_CPF_DIGITS)).rejects.toThrow(
        new BadRequestException('Document cannot be used'),
      );
    });
  });
});
