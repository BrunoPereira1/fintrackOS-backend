export const ErrorMessages = {
  NOT_FOUND: {
    USER: 'User not found',
    CARD: 'Card not found',
    ASSET: 'Asset not found',
    TRANSACTION: 'Transaction not found',
    INSTALLMENT: 'Installment not found',
    SPLIT: 'Split not found',
    CONTACT: 'Contact not found',
    INVOICE_PAYMENT: 'Invoice payment not found',
    INVOICE_CHARGE: 'Invoice charge not found',
  },
  ACCESS_DENIED: 'Access denied',
  // Genéricas de propósito: não revelam se o token expirou, foi revogado ou a conta desativada
  MISSING_TOKEN: 'Missing or malformed authorization header',
  INVALID_TOKEN: 'Invalid or expired token',
  LOGOUT_FAILED: 'Could not complete logout, please try again',
  PLAN_REQUIRED: (plan: string) => `This feature requires the ${plan} plan`,
  // Genérica de propósito: não revela se o documento já pertence a outra conta
  DOCUMENT_UNAVAILABLE: 'Document cannot be used',
  SPLIT_ITEM_NOT_IN_TRANSACTION: 'Item does not belong to the given transaction',
  // Consistência de valores
  ITEMS_TOTAL_MISMATCH: 'The sum of the items must equal the transaction total',
  SPLITS_EXCEED_TOTAL: 'The sum of the splits cannot exceed the transaction total',
  SPLITS_EXCEED_ITEM: 'The sum of the splits cannot exceed the item total',
  CARD_REQUIRED_FOR_RECALC:
    'Amount and date cannot be changed because the card of this transaction was removed',
  INSTALLMENTS_REQUIRE_CARD: 'installmentsCount requires a cardId',
  // D29: geraria parcelas de R$ 0,00
  TOTAL_LESS_THAN_INSTALLMENTS:
    'The total amount must be at least 0.01 per installment (total in cents >= installmentsCount)',
  // Não ecoa o valor recebido na mensagem
  INVALID_PURCHASE_DATE: 'Invalid purchase date',
  TRANSACTION_HAS_PENDING_SPLITS:
    'The transaction cannot be deleted while someone still owes part of it (pending splits)',
  // Contatos
  CONTACT_EMAIL_IN_USE: 'You already have a contact with this e-mail',
  CONTACT_HAS_SPLITS: 'Contact cannot be removed because it has splits',
  // Genérica de propósito: mesma resposta para contato inexistente ou de outro usuário
  SPLIT_INVALID_CONTACT: 'Invalid contact',
  // D30: genéricas de propósito — mesma resposta para referência do body inexistente ou alheia
  TRANSACTION_INVALID_CARD: 'Invalid card',
  SPLIT_INVALID_TRANSACTION: 'Invalid transaction',
  // Integrações
  // Provedor de identidade (Firebase) fora/lento: 503 para o cliente tentar de novo
  AUTH_PROVIDER_UNAVAILABLE: 'Authentication service is temporarily unavailable, please try again',
  // Rate limit sem storage (Redis) em rotas fail-closed
  RATE_LIMIT_UNAVAILABLE: 'Service temporarily unavailable, please try again',
  // Genéricas de propósito: mesma resposta para e-mail inexistente, senha errada ou conta desativada
  INVALID_CREDENTIALS: 'Invalid email or password',
  AUTH_FAILED: 'Authentication failed',
  EMAIL_ALREADY_REGISTERED: 'Email already registered',
  INVALID_PASSWORD_POLICY: 'Invalid password: at least 6 characters required',
  RESET_LINK_EXPIRED: 'The reset link has expired, please request a new one',
  RESET_LINK_INVALID: 'Invalid or already used reset link',
  WEAK_PASSWORD: 'The new password does not meet the minimum requirements',
  PASSWORD_RESET_FAILED: 'Could not reset the password',
  // Forma de pagamento
  CARD_REQUIRES_CREDIT_CARD_METHOD:
    'A transaction with cardId must use the credit_card payment method',
  CREDIT_CARD_METHOD_REQUIRES_CARD: 'The credit_card payment method requires a cardId',
  PAYMENT_METHOD_CHANGE_NOT_ALLOWED:
    'The payment method can only be changed between upfront methods (never to or from credit_card)',
  // Faturas (pagamentos e encargos — spec 2026-11-24-modelo-de-pagamento)
  INVOICE_NOT_ACCEPTING_ENTRIES:
    'Payments and charges are only allowed on a closed invoice or on the current open invoice',
  PAYMENT_DATE_IN_FUTURE: 'The payment date cannot be in the future',
  // Concorrência: deadlock/serialização com outra requisição (o cliente pode tentar de novo)
  CONCURRENT_UPDATE: 'The resource was changed by another request, please try again',
  // Transações no cartão (4c)
  CARD_ARCHIVED: 'This card is archived and does not accept new purchases',
  PURCHASE_COVERED_IN_CLOSED_INVOICE:
    'Amount and date cannot be changed because part of this purchase was already paid in a closed invoice',
  PURCHASE_DATE_IN_CLOSED_INVOICE:
    'The new date would place installments in an invoice that is already closed',
  // Parcelas (4b)
  CARD_INSTALLMENT_PAID_VIA_INVOICE:
    'Card installments cannot be updated individually; register a payment on the card invoice instead',
} as const;
