import { ValidateBy, ValidationOptions, ValidationArguments } from 'class-validator';
import { DocumentType } from '../../users/enums/document-type.enum';

// ─── CPF ─────────────────────────────────────────────────────────────────────

export function isValidCpf(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false; // todos iguais: 111.111.111-11

  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(digits[i]) * (len + 1 - i);
    const rem = (sum * 10) % 11;
    return rem === 10 ? 0 : rem;
  };

  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

// ─── CNPJ ────────────────────────────────────────────────────────────────────

export function isValidCnpj(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const calc = (weights: number[]) => {
    let sum = 0;
    for (let i = 0; i < weights.length; i++) sum += Number(digits[i]) * weights[i];
    const rem = sum % 11;
    return rem < 2 ? 0 : 11 - rem;
  };

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  return calc(w1) === Number(digits[12]) && calc(w2) === Number(digits[13]);
}

// ─── Normalização ─────────────────────────────────────────────────────────────

/**
 * Remove formatação e normaliza para armazenamento:
 * - CPF/CNPJ → somente dígitos
 * - Passport → maiúsculas, sem espaços
 */
export function normalizeDocument(type: DocumentType, value: string): string {
  if (type === DocumentType.PASSPORT) return value.trim().toUpperCase();
  return value.replace(/\D/g, '');
}

// ─── Decorator ───────────────────────────────────────────────────────────────

export function IsValidDocument(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: 'isValidDocument',
      validator: {
        validate(document: string, args: ValidationArguments): boolean {
          const { documentType } = args.object as { documentType?: DocumentType };
          if (!document || !documentType) return false;

          switch (documentType) {
            case DocumentType.CPF:
              return isValidCpf(document);
            case DocumentType.CNPJ:
              return isValidCnpj(document);
            case DocumentType.PASSPORT:
              return /^[A-Z0-9]{6,20}$/i.test(document.trim());
            default:
              return false;
          }
        },
        defaultMessage(): string {
          return 'Documento inválido para o tipo informado';
        },
      },
    },
    options,
  );
}
