import { SplitMapper } from './split.mapper';
import { CostSplit, SplitStatus } from './entities/cost-split.entity';

describe('SplitMapper', () => {
  it('expõe só id/nome/e-mail do contato (sem telefone, userId ou timestamps)', () => {
    const paidAt = new Date('2026-04-01T12:00:00Z');
    const split = {
      id: 'split-1',
      contactId: 'contact-1',
      contact: {
        id: 'contact-1',
        name: 'João',
        email: 'joao@email.com',
        phone: '11 99999-0000',
        userId: 'user-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      assignedAmount: '50.00',
      status: SplitStatus.PAID,
      paidAt,
      transactionId: 'tx-1',
      itemId: null,
    } as unknown as CostSplit;

    expect(SplitMapper.toDto(split)).toEqual({
      id: 'split-1',
      contactId: 'contact-1',
      contact: { id: 'contact-1', name: 'João', email: 'joao@email.com' },
      assignedAmount: 50,
      status: SplitStatus.PAID,
      paidAt,
      transactionId: 'tx-1',
      itemId: null,
    });
  });

  it('normaliza assignedAmount (decimal string do Postgres) para number sem erro de float', () => {
    const base = { contact: { id: 'c', name: 'A', email: null } } as unknown as CostSplit;
    expect(
      SplitMapper.toDto({ ...base, assignedAmount: '0.10' } as unknown as CostSplit),
    ).toMatchObject({
      assignedAmount: 0.1,
    });
    expect(
      SplitMapper.toDto({ ...base, assignedAmount: '1234.57' } as unknown as CostSplit),
    ).toMatchObject({
      assignedAmount: 1234.57,
    });
    expect(SplitMapper.toDto({ ...base, assignedAmount: 75.5 } as CostSplit)).toMatchObject({
      assignedAmount: 75.5,
    });
  });
});
