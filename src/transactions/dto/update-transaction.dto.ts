import { PartialType, OmitType } from '@nestjs/swagger';
import { CreateTransactionDto } from './create-transaction.dto';

// Não permite alterar cardId, installmentsCount nem itens após criação. `paymentMethod` só troca
// entre formas à vista (regra no service).
export class UpdateTransactionDto extends PartialType(
  OmitType(CreateTransactionDto, ['cardId', 'installmentsCount', 'items'] as const),
) {}
