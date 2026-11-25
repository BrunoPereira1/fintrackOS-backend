import { ContactMapper } from './contact.mapper';
import { Contact } from './entities/contact.entity';

describe('ContactMapper.toSummary', () => {
  it('expõe só id, nome e e-mail (sem telefone nem userId)', () => {
    const contact = {
      id: 'c-1',
      name: 'Ana',
      email: 'ana@x.com',
      phone: '+5581999999999',
      userId: 'u-1',
    } as Contact;
    expect(ContactMapper.toSummary(contact)).toEqual({
      id: 'c-1',
      name: 'Ana',
      email: 'ana@x.com',
    });
  });
});

describe('ContactMapper.toDto', () => {
  it('expõe telefone e timestamps, mas não userId', () => {
    const createdAt = new Date('2026-01-01T00:00:00Z');
    const updatedAt = new Date('2026-01-02T00:00:00Z');
    const contact = {
      id: 'c-1',
      name: 'Ana',
      email: null,
      phone: '+5581999999999',
      userId: 'u-1',
      createdAt,
      updatedAt,
    } as Contact;
    const dto = ContactMapper.toDto(contact);
    expect(dto).toEqual({
      id: 'c-1',
      name: 'Ana',
      email: null,
      phone: '+5581999999999',
      createdAt,
      updatedAt,
    });
    expect(dto).not.toHaveProperty('userId');
  });
});
