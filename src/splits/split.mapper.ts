import { CostSplit } from './entities/cost-split.entity';
import { SplitResponseDto } from './dto/split-response.dto';
import { ContactMapper } from '../contacts/contact.mapper';
import { toCents } from '../common/money';

export class SplitMapper {
  /**
   * Requer a relação `contact` carregada. Do contato, expõe só id/nome/e-mail. `assignedAmount`
   * (decimal, chega como string do Postgres) sai como number com 2 casas.
   */
  static toDto(split: CostSplit): SplitResponseDto {
    return {
      id: split.id,
      contactId: split.contactId,
      contact: ContactMapper.toSummary(split.contact),
      assignedAmount: toCents(split.assignedAmount) / 100,
      status: split.status,
      paidAt: split.paidAt,
      transactionId: split.transactionId,
      itemId: split.itemId,
    };
  }
}
