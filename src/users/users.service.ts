import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import { User } from './entities/user.entity';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { TokenCacheService } from '../auth/token-cache.service';
import { DocumentType } from './enums/document-type.enum';
import { normalizeDocument } from '../common/validators/document.validator';
import { ErrorMessages } from '../common/constants/error-messages';
import { isUniqueViolation } from '../common/db-errors';

export const USER_DOCUMENT_UNIQUE_INDEX = 'UQ_users_document';
export const USER_FIREBASE_UID_UNIQUE_INDEX = 'UQ_users_firebase_uid';

interface FindOrCreateInput {
  firebaseUid: string;
  email: string;
  displayName?: string;
  authProvider?: string;
  documentType?: DocumentType;
  document?: string;
}

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    private readonly tokenCache: TokenCacheService,
  ) {}

  async findOrCreate(input: FindOrCreateInput): Promise<User> {
    const existing = await this.usersRepo.findOne({
      where: { firebaseUid: input.firebaseUid },
    });

    if (existing) return existing;

    this.logger.log(`Creating new user for firebaseUid ${input.firebaseUid}`);
    const user = this.usersRepo.create({
      firebaseUid: input.firebaseUid,
      email: input.email,
      displayName: input.displayName ?? '',
      authProvider: input.authProvider ?? 'password',
      documentType: input.documentType ?? null,
      document:
        input.documentType && input.document
          ? normalizeDocument(input.documentType, input.document)
          : null,
    });

    try {
      return await this.usersRepo.save(user);
    } catch (err) {
      // Duas primeiras requisições do mesmo uid em paralelo: a outra já criou o usuário.
      if (!isUniqueViolation(err, USER_FIREBASE_UID_UNIQUE_INDEX)) throw err;
      const created = await this.usersRepo.findOne({ where: { firebaseUid: input.firebaseUid } });
      if (!created) throw err;
      return created;
    }
  }

  async findById(id: string): Promise<User> {
    const user = await this.usersRepo.findOne({ where: { id } });
    if (!user) throw new NotFoundException(ErrorMessages.NOT_FOUND.USER);
    return user;
  }

  async findByFirebaseUid(firebaseUid: string): Promise<User | null> {
    return this.usersRepo.findOne({ where: { firebaseUid } });
  }

  /**
   * Garante que nenhum outro usuário usa o documento (já normalizado). Lança sempre a mesma
   * BadRequest genérica, para que o endpoint não sirva de oráculo de CPF/CNPJ cadastrados
   * (antes: duplicado → 500 do índice único, livre → 200).
   */
  async assertDocumentAvailable(document: string, excludeUserId?: string): Promise<void> {
    const taken = await this.usersRepo.exists({
      where: excludeUserId ? { document, id: Not(excludeUserId) } : { document },
    });
    if (taken) throw new BadRequestException(ErrorMessages.DOCUMENT_UNAVAILABLE);
  }

  async updateProfile(id: string, dto: UpdateProfileDto): Promise<User> {
    const user = await this.findById(id);
    const { document, documentType, ...rest } = dto;
    Object.assign(user, rest);

    if (documentType) user.documentType = documentType;
    if (document && (documentType ?? user.documentType)) {
      user.document = normalizeDocument(
        (documentType ?? user.documentType) as DocumentType,
        document,
      );
    }
    if (user.document && document) {
      await this.assertDocumentAvailable(user.document, user.id);
    }

    let updated: User;
    try {
      updated = await this.usersRepo.save(user);
    } catch (err) {
      // Corrida entre a checagem acima e o save: mesma resposta genérica, nunca 500
      if (isUniqueViolation(err, USER_DOCUMENT_UNIQUE_INDEX)) {
        throw new BadRequestException(ErrorMessages.DOCUMENT_UNAVAILABLE);
      }
      throw err;
    }

    // Derruba perfil e TODAS as sessões em cache do usuário: nenhuma requisição continua
    // vendo o perfil/plano antigo. Não lança — falhas de cache são logadas no serviço.
    await this.tokenCache.invalidateAllSessions(user.firebaseUid);

    return updated;
  }
}
