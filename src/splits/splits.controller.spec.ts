import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { QuerySplitsDto } from './dto/query-splits.dto';

describe('QuerySplitsDto', () => {
  it('exige transactionId (antes, ausente virava 500 na query)', async () => {
    const errors = await validate(plainToInstance(QuerySplitsDto, {}));
    expect(errors.map((e) => e.property)).toEqual(['transactionId']);
  });

  it('aceita UUID', async () => {
    const errors = await validate(
      plainToInstance(QuerySplitsDto, { transactionId: '2b0d1c1e-8f1a-4c39-9d6e-0e0f7c2a9b11' }),
    );
    expect(errors).toEqual([]);
  });
});
