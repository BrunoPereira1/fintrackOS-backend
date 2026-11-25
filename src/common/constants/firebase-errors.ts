/** Firebase Admin SDK error codes (admin.auth()) */
export const FirebaseAdminError = {
  EMAIL_ALREADY_EXISTS: 'auth/email-already-exists',
  INVALID_PASSWORD: 'auth/invalid-password',
  ID_TOKEN_REVOKED: 'auth/id-token-revoked',
  USER_DISABLED: 'auth/user-disabled',
  // Transitórios: o SDK não conseguiu falar com o Google (rede, timeout, erro interno)
  NETWORK_ERROR: 'app/network-error',
  NETWORK_TIMEOUT: 'app/network-timeout',
  INTERNAL_ERROR: 'auth/internal-error',
} as const;

/**
 * Códigos do Admin SDK que indicam indisponibilidade do provedor (→ 503), não credencial
 * inválida (→ 401). Erros sem `code` ou com código de sistema (ECONNRESET...) também contam.
 */
export const FIREBASE_ADMIN_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  FirebaseAdminError.NETWORK_ERROR,
  FirebaseAdminError.NETWORK_TIMEOUT,
  FirebaseAdminError.INTERNAL_ERROR,
]);

/**
 * `true` quando a falha do Admin SDK é transitória: códigos de rede/internos do Firebase,
 * erros sem `code` (bug/rede fora do SDK) ou códigos de sistema do Node (`ECONNRESET`,
 * `ETIMEDOUT`...). Códigos `auth/...` de token/conta continuam sendo erro do cliente.
 */
export function isFirebaseAdminTransientError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || code === '') return true;
  if (FIREBASE_ADMIN_TRANSIENT_CODES.has(code)) return true;
  return /^E[A-Z0-9_]+$/.test(code);
}

/** Firebase REST API error message fragments (Identity Toolkit) */
export const FirebaseRestError = {
  EMAIL_NOT_FOUND: 'EMAIL_NOT_FOUND',
  INVALID_PASSWORD: 'INVALID_PASSWORD',
  INVALID_LOGIN_CREDENTIALS: 'INVALID_LOGIN_CREDENTIALS',
  USER_DISABLED: 'USER_DISABLED',
  EXPIRED_OOB_CODE: 'EXPIRED_OOB_CODE',
  INVALID_OOB_CODE: 'INVALID_OOB_CODE',
  WEAK_PASSWORD: 'WEAK_PASSWORD',
} as const;
