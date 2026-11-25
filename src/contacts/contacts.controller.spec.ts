import { ContactsController } from './contacts.controller';
import { ContactsService } from './contacts.service';
import { Contact } from './entities/contact.entity';
import { User } from '../users/entities/user.entity';

const USER = { id: 'user-1' } as User;
const contact = (): Contact =>
  ({
    id: 'c-1',
    name: 'Ana',
    email: 'ana@x.com',
    phone: '+5581999999999',
    userId: USER.id,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
  }) as Contact;

describe('ContactsController (resposta sem userId)', () => {
  const service = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
  };
  const controller = new ContactsController(service as unknown as ContactsService);

  beforeEach(() => jest.clearAllMocks());

  it('create/findOne/update devolvem o DTO com telefone e sem userId', async () => {
    service.create.mockResolvedValue(contact());
    service.findOne.mockResolvedValue(contact());
    service.update.mockResolvedValue(contact());

    for (const dto of [
      await controller.create(USER, { name: 'Ana' }),
      await controller.findOne(USER, 'c-1'),
      await controller.update(USER, 'c-1', {}),
    ]) {
      expect(dto).toMatchObject({ id: 'c-1', phone: '+5581999999999' });
      expect(dto).not.toHaveProperty('userId');
    }
    expect(service.findOne).toHaveBeenCalledWith('c-1', USER.id);
  });

  it('findAll mapeia cada item e mantém a paginação', async () => {
    service.findAll.mockResolvedValue({ data: [contact()], total: 1, page: 1, limit: 20 });
    const res = await controller.findAll(USER, { page: 1, limit: 20 });
    expect(res).toMatchObject({ total: 1, page: 1, limit: 20 });
    expect(res.data[0]).not.toHaveProperty('userId');
    expect(res.data[0]).toMatchObject({ id: 'c-1', name: 'Ana' });
  });
});
