import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Asset, AssetStatus } from './entities/asset.entity';
import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { ErrorMessages } from '../common/constants/error-messages';

@Injectable()
export class AssetsService {
  private readonly logger = new Logger(AssetsService.name);

  constructor(
    @InjectRepository(Asset)
    private readonly assetsRepo: Repository<Asset>,
  ) {}

  create(userId: string, dto: CreateAssetDto): Promise<Asset> {
    const asset = this.assetsRepo.create({ ...dto, userId });
    this.logger.log(`Creating asset for user ${userId}`);
    return this.assetsRepo.save(asset);
  }

  findAllByUser(userId: string): Promise<Asset[]> {
    return this.assetsRepo.find({
      where: { userId },
      order: { acquisitionDate: 'DESC' },
    });
  }

  async findOne(id: string, userId: string): Promise<Asset> {
    const asset = await this.assetsRepo.findOne({ where: { id } });
    if (!asset) throw new NotFoundException(ErrorMessages.NOT_FOUND.ASSET);
    if (asset.userId !== userId) throw new ForbiddenException(ErrorMessages.ACCESS_DENIED);
    return asset;
  }

  async update(id: string, userId: string, dto: UpdateAssetDto): Promise<Asset> {
    const asset = await this.findOne(id, userId);
    Object.assign(asset, dto);
    return this.assetsRepo.save(asset);
  }

  async remove(id: string, userId: string): Promise<void> {
    const asset = await this.findOne(id, userId);
    asset.status = AssetStatus.SOLD;
    this.logger.log(`Asset ${id} marked as sold`);
    await this.assetsRepo.save(asset);
  }
}
