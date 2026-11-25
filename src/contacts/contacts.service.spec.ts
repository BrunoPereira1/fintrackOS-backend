import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { ContactsService } from './contacts.service';
import { Contact } from './entities/contact.entity';
import { ErrorMessages } from '../common/constants/error-messages';

const USER_ID = 'user-uuid-1';
const OTHER_USER_ID = 'user-uuid-2';
const CONTACT_ID = 'contact-uuid-1';

const mockContact = (overrides: Partial<Contact> = {}): Contact =>
  ({
    id: CONTACT_ID,
    name: 'João Silva',
    email: 'joao@email.com',
    phone: null,
    userId: USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as Contact;

const pgError = (code: string, constraint: string) =>
  new QueryFailedError('SQL', [], Object.assign(new Error('pg'), { code, constraint }));

describe('ContactsService', () => {
  let service: ContactsService;
  let qb: {
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    addOrderBy: jest.Mock;
    skip: jest.Mock;
    take: jest.Mock;
    getManyAndCount: jest.Mock;
  };
  let repo: {
    create: jest.Mock;
    save: jest.Mock;
    findOne: jest.Mock;
    remove: jest.Mock;
    createQueryBuilder: jest.Mock;
  };

  beforeEach(async () => {
    qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: CONTACT_ID, ...x })),
      findOne: jest.fn().mockResolvedValue(null),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => qb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ContactsService, { provide: getRepositoryToken(Contact), useValue: repo }],
    }).compile();

    service = module.get(ContactsService);
  });

  describe('create', () => {
    it('salva com userId e e-mail normalizado (trim + minúsculas)', async () => {
      await service.create(USER_ID, {
        name: '  João Silva ',
        email: '  Joao@Email.COM ',
        phone: ' 11 99999-0000 ',
      });

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { userId: USER_ID, email: 'joao@email.com' },
      });
      expect(repo.create).toHaveBeenCalledWith({
        name: 'João Silva',
        email: 'joao@email.com',
        phone: '11 99999-0000',
        userId: USER_ID,
      });
      expect(repo.save).toHaveBeenCalled();
    });

    it('sem e-mail/telefone grava null e não checa duplicidade', async () => {
      await service.create(USER_ID, { name: 'Mãe' });

      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalledWith({
        name: 'Mãe',
        email: null,
        phone: null,
        userId: USER_ID,
      });
    });

    it('telefone só com espaços vira null', async () => {
      await service.create(USER_ID, { name: 'Ana', phone: '   ' });
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ phone: null }));
    });

    it('409 quando o usuário já tem contato com o mesmo e-mail (outra caixa), sem salvar', async () => {
      repo.findOne.mockResolvedValue(mockContact());

      await expect(
        service.create(USER_ID, { name: 'Outro', email: 'JOAO@email.com' }),
      ).rejects.toThrow(new ConflictException(ErrorMessages.CONTACT_EMAIL_IN_USE));
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('409 na corrida: violação de UQ_contacts_user_email no save', async () => {
      repo.save.mockRejectedValue(pgError('23505', 'UQ_contacts_user_email'));

      await expect(service.create(USER_ID, { name: 'Ana', email: 'a@b.com' })).rejects.toThrow(
        new ConflictException(ErrorMessages.CONTACT_EMAIL_IN_USE),
      );
    });

    it('não mascara outra violação de unicidade', async () => {
      const err = pgError('23505', 'UQ_outra');
      repo.save.mockRejectedValue(err);

      await expect(service.create(USER_ID, { name: 'Ana', email: 'a@b.com' })).rejects.toBe(err);
    });
  });

  describe('findAll', () => {
    it('filtra por usuário, ordena por nome e pagina', async () => {
      const contacts = [mockContact()];
      qb.getManyAndCount.mockResolvedValue([contacts, 21]);

      const result = await service.findAll(USER_ID, { page: 2, limit: 10 });

      expect(qb.where).toHaveBeenCalledWith('c.user_id = :userId', { userId: USER_ID });
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.orderBy).toHaveBeenCalledWith('c.name', 'ASC');
      expect(qb.skip).toHaveBeenCalledWith(10);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(result).toEqual({ data: contacts, total: 21, page: 2, limit: 10 });
    });

    it('busca por nome ou e-mail com ILIKE, escapando curingas', async () => {
      await service.findAll(USER_ID, { page: 1, limit: 20, search: ' 50%_jo\\ ' });

      expect(qb.andWhere).toHaveBeenCalledWith('(c.name ILIKE :search OR c.email ILIKE :search)', {
        search: '%50\\%\\_jo\\\\%',
      });
    });

    it('busca vazia (só espaços) não filtra', async () => {
      await service.findAll(USER_ID, { page: 1, limit: 20, search: '   ' });
      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('retorna o contato do usuário', async () => {
      repo.findOne.mockResolvedValue(mockContact());
      await expect(service.findOne(CONTACT_ID, USER_ID)).resolves.toMatchObject({ id: CONTACT_ID });
      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: CONTACT_ID } });
    });

    it('404 quando não existe', async () => {
      await expect(service.findOne('x', USER_ID)).rejects.toThrow(
        new NotFoundException(ErrorMessages.NOT_FOUND.CONTACT),
      );
    });

    it('403 quando é de outro usuário', async () => {
      repo.findOne.mockResolvedValue(mockContact());
      await expect(service.findOne(CONTACT_ID, OTHER_USER_ID)).rejects.toThrow(
        new ForbiddenException(ErrorMessages.ACCESS_DENIED),
      );
    });
  });

  describe('update', () => {
    it('aplica campos normalizados e checa e-mail novo excluindo o próprio contato', async () => {
      repo.findOne
        .mockResolvedValueOnce(mockContact()) // findOne(id)
        .mockResolvedValueOnce(null); // checagem de e-mail

      await service.update(CONTACT_ID, USER_ID, { name: ' João S. ', email: ' NOVO@x.com ' });

      expect(repo.findOne).toHaveBeenLastCalledWith({
        where: { userId: USER_ID, email: 'novo@x.com' },
      });
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: CONTACT_ID, name: 'João S.', email: 'novo@x.com' }),
      );
    });

    it('mesmo e-mail em outra caixa no próprio contato não é conflito', async () => {
      repo.findOne.mockResolvedValue(mockContact());

      await service.update(CONTACT_ID, USER_ID, { email: 'JOAO@EMAIL.COM' });

      expect(repo.findOne).toHaveBeenCalledTimes(1);
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ email: 'joao@email.com' }));
    });

    it('409 quando o e-mail novo já é de outro contato do usuário', async () => {
      repo.findOne
        .mockResolvedValueOnce(mockContact())
        .mockResolvedValueOnce(mockContact({ id: 'contact-uuid-2', email: 'ana@x.com' }));

      await expect(service.update(CONTACT_ID, USER_ID, { email: 'Ana@x.com' })).rejects.toThrow(
        new ConflictException(ErrorMessages.CONTACT_EMAIL_IN_USE),
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('e-mail null limpa o campo', async () => {
      repo.findOne.mockResolvedValue(mockContact());
      await service.update(CONTACT_ID, USER_ID, { email: null as unknown as string });
      expect(repo.save).toHaveBeenCalledWith(expect.objectContaining({ email: null }));
    });

    it('409 na corrida (23505) ao salvar', async () => {
      repo.findOne.mockResolvedValueOnce(mockContact()).mockResolvedValueOnce(null);
      repo.save.mockRejectedValue(pgError('23505', 'UQ_contacts_user_email'));

      await expect(service.update(CONTACT_ID, USER_ID, { email: 'b@x.com' })).rejects.toThrow(
        ConflictException,
      );
    });

    it('403 para contato de outro usuário, sem salvar', async () => {
      repo.findOne.mockResolvedValue(mockContact());
      await expect(service.update(CONTACT_ID, OTHER_USER_ID, { name: 'X' })).rejects.toThrow(
        ForbiddenException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });
  });

  describe('remove', () => {
    it('remove o contato do usuário', async () => {
      const contact = mockContact();
      repo.findOne.mockResolvedValue(contact);

      await service.remove(CONTACT_ID, USER_ID);
      expect(repo.remove).toHaveBeenCalledWith(contact);
    });

    it('409 quando a FK diferida dos splits barra a remoção no COMMIT (23503)', async () => {
      repo.findOne.mockResolvedValue(mockContact());
      repo.remove.mockRejectedValue(pgError('23503', 'FK_cost_splits_contact'));

      await expect(service.remove(CONTACT_ID, USER_ID)).rejects.toThrow(
        new ConflictException(ErrorMessages.CONTACT_HAS_SPLITS),
      );
    });

    it('não mascara violação de outra FK', async () => {
      const err = pgError('23503', 'FK_outra');
      repo.findOne.mockResolvedValue(mockContact());
      repo.remove.mockRejectedValue(err);

      await expect(service.remove(CONTACT_ID, USER_ID)).rejects.toBe(err);
    });

    it('403 para contato de outro usuário, sem remover', async () => {
      repo.findOne.mockResolvedValue(mockContact());
      await expect(service.remove(CONTACT_ID, OTHER_USER_ID)).rejects.toThrow(ForbiddenException);
      expect(repo.remove).not.toHaveBeenCalled();
    });
  });
});
