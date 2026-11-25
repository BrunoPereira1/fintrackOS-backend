import { TransactionsController } from './transactions.controller';
import { TransactionsService } from './transactions.service';
import { Transaction } from './entities/transaction.entity';
import { User } from '../users/entities/user.entity';
import { Plan } from '../users/enums/plan.enum';

describe('TransactionsController.findOne', () => {
  const user = { id: 'u-1', plan: Plan.PREMIUM } as User;

  it('splits embutidos trazem o contato resumido, sem telefone', async () => {
    const service = {
      findOne: jest.fn().mockResolvedValue({
        id: 't-1',
        splits: [
          {
            id: 's-1',
            contactId: 'c-1',
            contact: { id: 'c-1', name: 'Ana', email: null, phone: '+55', userId: 'u-1' },
            assignedAmount: '10.00',
          },
        ],
      } as unknown as Transaction),
    } as unknown as TransactionsService;

    const result = await new TransactionsController(service).findOne(user, 't-1');

    expect(service.findOne).toHaveBeenCalledWith('t-1', 'u-1');
    expect(result.splits?.[0].contact).toEqual({ id: 'c-1', name: 'Ana', email: null });
  });

  it('transação sem splits carregados não inventa a lista', async () => {
    const service = {
      findOne: jest.fn().mockResolvedValue({ id: 't-1' } as Transaction),
    } as unknown as TransactionsService;
    const result = await new TransactionsController(service).findOne(
      { id: 'u-1', plan: Plan.BASIC } as User,
      't-1',
    );
    expect(result.splits).toBeUndefined();
  });
});
