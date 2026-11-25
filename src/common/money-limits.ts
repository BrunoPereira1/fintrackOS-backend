/**
 * Tetos de validação para números de entrada, derivados das colunas do banco: um valor acima
 * estouraria a coluna e viraria 500 no INSERT em vez de 400 no DTO.
 */

/** Maior valor em `decimal(12,2)` (dinheiro: totais, preços, parcelas, splits, limite). */
export const MAX_MONEY = 9_999_999_999.99;

/** Maior valor em `decimal(14,6)` (preço médio e quantidade de ativo). */
export const MAX_ASSET_DECIMAL = 99_999_999.999999;

/** Quantidade máxima de um item de transação. */
export const MAX_ITEM_QUANTITY = 10_000;
