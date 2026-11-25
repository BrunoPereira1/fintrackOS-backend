import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssetsService } from './assets.service';
import { Asset, AssetType, AssetStatus } from './entities/asset.entity';

const USER_ID = 'user-uuid-1';

const mockAsset = (): Asset =>
  ({
    id: 'asset-uuid-1',
    name: 'PETR4',
    type: AssetType.STOCKS,
    status: AssetStatus.ACTIVE,
    averagePrice: 37.42,
    currentQuantity: 100,
    acquisitionDate: new Date('2026-01-15'),
    userId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as Asset;

describe('AssetsService', () => {
  let service: AssetsService;
  let repo: { create: jest.Mock; save: jest.Mock; find: jest.Mock; findOne: jest.Mock };

  beforeEach(async () => {
    repo = { create: jest.fn(), save: jest.fn(), find: jest.fn(), findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [AssetsService, { provide: getRepositoryToken(Asset), useValue: repo }],
    }).compile();

    service = module.get(AssetsService);
  });

  describe('create', () => {
    it('cria e salva um asset', async () => {
      const asset = mockAsset();
      repo.create.mockReturnValue(asset);
      repo.save.mockResolvedValue(asset);

      const result = await service.create(USER_ID, {
        name: 'PETR4',
        type: AssetType.STOCKS,
        averagePrice: 37.42,
        currentQuantity: 100,
        acquisitionDate: '2026-01-15',
      });

      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ userId: USER_ID }));
      expect(result).toBe(asset);
    });
  });

  describe('findOne', () => {
    it('retorna o asset quando o dono bate', async () => {
      repo.findOne.mockResolvedValue(mockAsset());
      const result = await service.findOne('asset-uuid-1', USER_ID);
      expect(result.id).toBe('asset-uuid-1');
    });

    it('lança NotFoundException se não encontrado', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.findOne('bad-id', USER_ID)).rejects.toThrow(NotFoundException);
    });

    it('lança ForbiddenException para outro usuário', async () => {
      repo.findOne.mockResolvedValue(mockAsset());
      await expect(service.findOne('asset-uuid-1', 'other-user')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('remove', () => {
    it('faz soft delete marcando o asset como SOLD', async () => {
      const asset = mockAsset();
      repo.findOne.mockResolvedValue(asset);
      repo.save.mockResolvedValue({ ...asset, status: AssetStatus.SOLD });

      await service.remove('asset-uuid-1', USER_ID);

      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ status: AssetStatus.SOLD }));
    });
  });
});
