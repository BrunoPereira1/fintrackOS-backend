import { Contact } from './entities/contact.entity';
import { ContactResponseDto } from './dto/contact-response.dto';

export interface ContactSummary {
  id: string;
  name: string;
  email: string | null;
}

export class ContactMapper {
  /** Projeção usada onde o contato aparece embutido (splits): sem telefone (LGPD) nem userId. */
  static toSummary(contact: Contact): ContactSummary {
    return { id: contact.id, name: contact.name, email: contact.email };
  }

  /** Resposta de `/contacts` (o próprio dono): inclui telefone, nunca `userId`. */
  static toDto(contact: Contact): ContactResponseDto {
    return {
      id: contact.id,
      name: contact.name,
      email: contact.email,
      phone: contact.phone,
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    };
  }
}
