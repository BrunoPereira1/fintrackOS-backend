import { createHash } from 'crypto';

export const CacheKeys = {
  tokenSession: (token: string) =>
    `auth:session:${createHash('sha256').update(token).digest('hex')}`,

  /** Versão das sessões de um uid: trocar o valor invalida todas as `auth:session:*` dele. */
  sessionVersion: (firebaseUid: string) => `auth:sessver:${firebaseUid}`,

  userProfile: (firebaseUid: string) => `user:profile:${firebaseUid}`,
};

export const CacheTTL = {
  TOKEN_SESSION: 5 * 60 * 1000, // 5 min — teto; limitado também pelo `exp` do ID token
  // Precisa ser > TOKEN_SESSION: sessões gravadas antes da invalidação expiram antes da versão
  SESSION_VERSION: 60 * 60 * 1000, // 60 min
  USER_PROFILE: 10 * 60 * 1000, // 10 min — invalidado manualmente no updateProfile
};
