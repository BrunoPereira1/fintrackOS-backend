import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateAssetDto } from '../../assets/dto/create-asset.dto';
import { UpdateAssetDto } from '../../assets/dto/update-asset.dto';
import { RegisterDto } from '../../auth/dto/register.dto';
import { CreateCardDto } from '../../cards/dto/create-card.dto';
import { UpdateCardDto } from '../../cards/dto/update-card.dto';
import { CreateSplitDto } from '../../splits/dto/create-split.dto';
import { CreateContactDto } from '../../contacts/dto/create-contact.dto';
import { UpdateContactDto } from '../../contacts/dto/update-contact.dto';
import { CreateTransactionDto } from '../../transactions/dto/create-transaction.dto';
import { UpdateTransactionDto } from '../../transactions/dto/update-transaction.dto';
import { UpdateProfileDto } from '../../users/dto/update-profile.dto';
import { DocumentType } from '../../users/enums/document-type.enum';
import { MAX_ASSET_DECIMAL, MAX_MONEY } from '../money-limits';

const long = (n: number) => 'a'.repeat(n);

async function failedProps<T extends object>(cls: new () => T, plain: object): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, plain) as object);
  const props: string[] = [];
  const walk = (errs: typeof errors, prefix = '') =>
    errs.forEach((e) => {
      const path = `${prefix}${e.property}`;
      Object.keys(e.constraints ?? {}).forEach((c) => props.push(`${path}:${c}`));
      if (e.children?.length) walk(e.children, `${path}.`);
    });
  walk(errors);
  return props;
}

const tx = {
  description: 'Mercado',
  totalAmount: 10,
  date: '2026-04-01',
  type: 'fixed',
};

describe('limites de tamanho nos DTOs', () => {
  it('cards/assets: name ≤ 255 (também no Update via PartialType)', async () => {
    const card = { name: long(256), brand: 'visa', closingDay: 1, dueDay: 5, creditLimit: 1 };
    expect(await failedProps(CreateCardDto, card)).toContain('name:maxLength');
    expect(await failedProps(UpdateCardDto, { name: long(256) })).toContain('name:maxLength');

    expect(await failedProps(UpdateAssetDto, { name: long(256) })).toContain('name:maxLength');
    expect(await failedProps(CreateAssetDto, { name: long(256) })).toContain('name:maxLength');
  });

  it('transactions: description/category ≤ 255, items ≤ 200, item.name ≤ 255', async () => {
    const props = await failedProps(CreateTransactionDto, {
      ...tx,
      description: long(256),
      category: long(256),
      items: [{ name: long(256), quantity: 1, unitPrice: 1 }],
    });
    expect(props).toEqual(
      expect.arrayContaining([
        'description:maxLength',
        'category:maxLength',
        'items.0.name:maxLength',
      ]),
    );

    const items = Array.from({ length: 201 }, () => ({ name: 'x', quantity: 1, unitPrice: 1 }));
    expect(await failedProps(CreateTransactionDto, { ...tx, items })).toContain(
      'items:arrayMaxSize',
    );
    expect(await failedProps(CreateTransactionDto, { ...tx, items: items.slice(0, 200) })).toEqual(
      [],
    );

    expect(await failedProps(UpdateTransactionDto, { description: long(256) })).toContain(
      'description:maxLength',
    );
  });

  it('splits: contactId obrigatório e UUID; personName/personEmail não existem mais', async () => {
    const base = { assignedAmount: 1, transactionId: '6f1c1d2e-8b8a-4c1e-9b1a-1a2b3c4d5e6f' };
    expect(await failedProps(CreateSplitDto, base)).toContain('contactId:isUuid');
    expect(await failedProps(CreateSplitDto, { ...base, contactId: 'nao-uuid' })).toContain(
      'contactId:isUuid',
    );
    expect(
      await failedProps(CreateSplitDto, {
        ...base,
        contactId: '0b6c1a52-3a9e-4c55-8f0e-2f1f5a3e9c11',
      }),
    ).toEqual([]);
  });

  it('contacts: name ≤ 255 e não vazio, email ≤ 254, phone ≤ 32', async () => {
    const props = await failedProps(CreateContactDto, {
      name: long(256),
      email: `${long(250)}@x.com`,
      phone: '1'.repeat(33),
    });
    expect(props).toEqual(
      expect.arrayContaining(['name:maxLength', 'email:maxLength', 'phone:maxLength']),
    );
    expect(await failedProps(CreateContactDto, { name: '   ' })).toContain('name:matches');
    expect(await failedProps(CreateContactDto, { name: 'Ana' })).toEqual([]);
  });

  it('contacts update: name opcional, mas null/vazio falham; email null limpa', async () => {
    expect(await failedProps(UpdateContactDto, {})).toEqual([]);
    expect(await failedProps(UpdateContactDto, { email: null, phone: null })).toEqual([]);
    expect(await failedProps(UpdateContactDto, { name: null })).toContain('name:isString');
    expect(await failedProps(UpdateContactDto, { name: '' })).toContain('name:matches');
    expect(await failedProps(UpdateContactDto, { name: long(256) })).toContain('name:maxLength');
  });

  it('auth/register e users/update-profile: e-mail ≤ 254 e documento ≤ 32', async () => {
    const register = await failedProps(RegisterDto, {
      email: `${long(250)}@x.com`,
      password: 'senha-forte',
      documentType: DocumentType.CPF,
      document: `${'1'.repeat(11)}${' '.repeat(40)}`,
    });
    expect(register).toEqual(expect.arrayContaining(['email:maxLength', 'document:maxLength']));

    const profile = await failedProps(UpdateProfileDto, {
      documentType: DocumentType.CPF,
      document: `529.982.247-25${' '.repeat(40)}`,
    });
    expect(profile).toContain('document:maxLength');
  });

  describe('limites numéricos (cabem nas colunas decimal)', () => {
    const TX_ID = '6f1c1d2e-8b8a-4c1e-9b1a-1a2b3c4d5e6f';
    const CONTACT_ID = '0b6c1a52-3a9e-4c55-8f0e-2f1f5a3e9c11';
    const card = { name: 'Nu', brand: 'visa', closingDay: 1, dueDay: 5 };
    const asset = { name: 'PETR4', type: 'stocks', acquisitionDate: '2026-01-15' };

    it('MAX_MONEY cabe em decimal(12,2) e MAX_ASSET_DECIMAL em decimal(14,6)', () => {
      expect(MAX_MONEY).toBe(9_999_999_999.99);
      expect(MAX_ASSET_DECIMAL).toBe(99_999_999.999999);
    });

    it('dinheiro: MAX_MONEY passa, MAX_MONEY + 0.01 falha', async () => {
      const over = MAX_MONEY + 0.01;
      expect(await failedProps(CreateTransactionDto, { ...tx, totalAmount: MAX_MONEY })).toEqual(
        [],
      );
      expect(await failedProps(CreateTransactionDto, { ...tx, totalAmount: over })).toContain(
        'totalAmount:max',
      );
      expect(await failedProps(UpdateTransactionDto, { totalAmount: over })).toContain(
        'totalAmount:max',
      );
      expect(
        await failedProps(CreateTransactionDto, {
          ...tx,
          items: [{ name: 'x', quantity: 1, unitPrice: over }],
        }),
      ).toContain('items.0.unitPrice:max');
      expect(await failedProps(CreateCardDto, { ...card, creditLimit: MAX_MONEY })).toEqual([]);
      expect(await failedProps(CreateCardDto, { ...card, creditLimit: over })).toContain(
        'creditLimit:max',
      );
      expect(await failedProps(UpdateCardDto, { creditLimit: over })).toContain('creditLimit:max');
      const split = { contactId: CONTACT_ID, transactionId: TX_ID };
      expect(await failedProps(CreateSplitDto, { ...split, assignedAmount: MAX_MONEY })).toEqual(
        [],
      );
      expect(await failedProps(CreateSplitDto, { ...split, assignedAmount: over })).toContain(
        'assignedAmount:max',
      );
    });

    it('assets: averagePrice e currentQuantity ≤ MAX_ASSET_DECIMAL', async () => {
      const ok = { ...asset, averagePrice: MAX_ASSET_DECIMAL, currentQuantity: MAX_ASSET_DECIMAL };
      expect(await failedProps(CreateAssetDto, ok)).toEqual([]);
      const props = await failedProps(CreateAssetDto, {
        ...asset,
        averagePrice: 100_000_000,
        currentQuantity: 100_000_000,
      });
      expect(props).toEqual(expect.arrayContaining(['averagePrice:max', 'currentQuantity:max']));
      expect(await failedProps(UpdateAssetDto, { averagePrice: 100_000_000 })).toContain(
        'averagePrice:max',
      );
    });

    it('item: quantity ≤ 10.000', async () => {
      const item = (quantity: number) => ({
        ...tx,
        items: [{ name: 'x', quantity, unitPrice: 0 }],
      });
      expect(await failedProps(CreateTransactionDto, item(10_000))).toEqual([]);
      expect(await failedProps(CreateTransactionDto, item(10_001))).toContain(
        'items.0.quantity:max',
      );
    });
  });

  describe('transactions: date só YYYY-MM-DD', () => {
    it.each(['2026-04-01T10:00:00Z', '2026-04-01T00:00:00-03:00', '20260401', '2026-W14'])(
      'rejeita %p',
      async (date) => {
        expect(await failedProps(CreateTransactionDto, { ...tx, date })).toContain('date:matches');
        expect(await failedProps(UpdateTransactionDto, { date })).toContain('date:matches');
      },
    );

    it('aceita 2026-04-01 e rejeita data impossível', async () => {
      expect(await failedProps(CreateTransactionDto, { ...tx, date: '2026-04-01' })).toEqual([]);
      expect(await failedProps(CreateTransactionDto, { ...tx, date: '2026-02-30' })).toContain(
        'date:isDateString',
      );
    });

    it('mensagem clara no formato', async () => {
      const errors = await validate(
        plainToInstance(CreateTransactionDto, { ...tx, date: '2026-04-01T10:00:00Z' }),
      );
      expect(errors[0].constraints?.matches).toBe(
        'date must be a calendar date in YYYY-MM-DD format',
      );
    });
  });

  describe('transactions: installmentsCount validado sempre (com ou sem cartão)', () => {
    const CARD_ID = '6f1c1d2e-8b8a-4c1e-9b1a-1a2b3c4d5e6f';

    it.each([
      [0, 'min'],
      [-5, 'min'],
      [49, 'max'],
      [1.5, 'isInt'],
      ['abc', 'isInt'],
    ])('%p sem cartão → %s', async (installmentsCount, constraint) => {
      expect(await failedProps(CreateTransactionDto, { ...tx, installmentsCount })).toContain(
        `installmentsCount:${constraint}`,
      );
    });

    it('com cartão também valida', async () => {
      expect(
        await failedProps(CreateTransactionDto, { ...tx, cardId: CARD_ID, installmentsCount: 0 }),
      ).toContain('installmentsCount:min');
    });

    it('ausente, 1 e 48 passam; >1 sem cartão passa no DTO (422 é do service)', async () => {
      expect(await failedProps(CreateTransactionDto, tx)).toEqual([]);
      expect(await failedProps(CreateTransactionDto, { ...tx, installmentsCount: 1 })).toEqual([]);
      expect(
        await failedProps(CreateTransactionDto, { ...tx, cardId: CARD_ID, installmentsCount: 48 }),
      ).toEqual([]);
      expect(await failedProps(CreateTransactionDto, { ...tx, installmentsCount: 3 })).toEqual([]);
    });
  });
});
