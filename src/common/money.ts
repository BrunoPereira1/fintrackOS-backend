/**
 * Valores monetários em centavos inteiros, para somar/comparar sem erro de ponto flutuante.
 * Aceita string porque colunas `decimal` do Postgres chegam do driver como string ("200.00").
 */
export function toCents(value: number | string): number {
  return Math.round(Number(value) * 100);
}

export function sumCents<T>(list: readonly T[] | undefined, pick: (item: T) => number): number {
  return (list ?? []).reduce((acc, item) => acc + pick(item), 0);
}

/**
 * Divide um total em centavos em `parts` partes inteiras: `floor(total / parts)` em cada uma e
 * a diferença na **última** (Σ partes == total). Regra das parcelas (business-rules §5).
 */
export function splitCents(totalCents: number, parts: number): number[] {
  if (!Number.isInteger(parts) || parts < 1)
    throw new RangeError('parts must be a positive integer');
  if (!Number.isInteger(totalCents)) throw new RangeError('totalCents must be an integer');
  const base = Math.floor(totalCents / parts);
  return Array.from({ length: parts }, (_, i) =>
    i === parts - 1 ? totalCents - base * (parts - 1) : base,
  );
}
