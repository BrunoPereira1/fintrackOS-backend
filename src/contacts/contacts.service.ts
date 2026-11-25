import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Contact } from './entities/contact.entity';
import { CreateContactDto } from './dto/create-contact.dto';
import { UpdateContactDto } from './dto/update-contact.dto';
import { QueryContactsDto } from './dto/query-contacts.dto';
import { ErrorMessages } from '../common/constants/error-messages';
import { isForeignKeyViolation, isUniqueViolation } from '../common/db-errors';

export interface PaginatedContacts {
  data: Contact[];
  total: number;
  page: number;
  limit: number;
}

const UQ_EMAIL = 'UQ_contacts_user_email';
const FK_SPLITS = 'FK_cost_splits_contact';

/** Trim; texto vazio vira `null`. `undefined` continua `undefined` (campo não enviado). */
function clean(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** E-mail é guardado normalizado (trim + minúsculas): a unicidade por usuário ignora caixa. */
function normalizeEmail(value: string | null | undefined): string | null | undefined {
  const cleaned = clean(value);
  return typeof cleaned === 'string' ? cleaned.toLowerCase() : cleaned;
}

/** Escapa os curingas do LIKE para a busca ser literal. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    @InjectRepository(Contact)
    private readonly contactsRepo: Repository<Contact>,
  ) {}

  async create(userId: string, dto: CreateContactDto): Promise<Contact> {
    const email = normalizeEmail(dto.email) ?? null;
    if (email) await this.assertEmailAvailable(userId, email);

    const contact = this.contactsRepo.create({
      name: dto.name.trim(),
      email,
      phone: clean(dto.phone) ?? null,
      userId,
    });
    const saved = await this.saveHandlingConflict(contact);
    this.logger.log(`Contact ${saved.id} created for user ${userId}`);
    return saved;
  }

  async findAll(userId: string, query: QueryContactsDto): Promise<PaginatedContacts> {
    const { page, limit } = query;
    const search = query.search?.trim();

    const qb = this.contactsRepo
      .createQueryBuilder('c')
      .where('c.user_id = :userId', { userId })
      .orderBy('c.name', 'ASC')
      .addOrderBy('c.id', 'ASC');

    if (search) {
      qb.andWhere('(c.name ILIKE :search OR c.email ILIKE :search)', {
        search: `%${escapeLike(search)}%`,
      });
    }

    const [data, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return { data, total, page, limit };
  }

  async findOne(id: string, userId: string): Promise<Contact> {
    const contact = await this.contactsRepo.findOne({ where: { id } });
    if (!contact) throw new NotFoundException(ErrorMessages.NOT_FOUND.CONTACT);
    if (contact.userId !== userId) throw new ForbiddenException(ErrorMessages.ACCESS_DENIED);
    return contact;
  }

  async update(id: string, userId: string, dto: UpdateContactDto): Promise<Contact> {
    const contact = await this.findOne(id, userId);

    const email = normalizeEmail(dto.email);
    if (email && email !== contact.email) await this.assertEmailAvailable(userId, email);

    if (dto.name !== undefined) contact.name = dto.name.trim();
    if (email !== undefined) contact.email = email;
    const phone = clean(dto.phone);
    if (phone !== undefined) contact.phone = phone;

    return this.saveHandlingConflict(contact);
  }

  async remove(id: string, userId: string): Promise<void> {
    const contact = await this.findOne(id, userId);
    try {
      await this.contactsRepo.remove(contact);
    } catch (err) {
      // A FK dos splits (NO ACTION diferida) barra a remoção no COMMIT, que o remove() já faz
      if (isForeignKeyViolation(err, FK_SPLITS)) {
        throw new ConflictException(ErrorMessages.CONTACT_HAS_SPLITS);
      }
      throw err;
    }
    this.logger.log(`Contact ${id} removed by user ${userId}`);
  }

  private async assertEmailAvailable(userId: string, email: string): Promise<void> {
    const existing = await this.contactsRepo.findOne({ where: { userId, email } });
    if (existing) throw new ConflictException(ErrorMessages.CONTACT_EMAIL_IN_USE);
  }

  /** Converte a corrida entre a checagem e o INSERT/UPDATE (índice único) em 409. */
  private async saveHandlingConflict(contact: Contact): Promise<Contact> {
    try {
      return await this.contactsRepo.save(contact);
    } catch (err) {
      if (isUniqueViolation(err, UQ_EMAIL)) {
        throw new ConflictException(ErrorMessages.CONTACT_EMAIL_IN_USE);
      }
      throw err;
    }
  }
}
