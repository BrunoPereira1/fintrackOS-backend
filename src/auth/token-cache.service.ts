import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { randomUUID } from 'crypto';
import { User } from '../users/entities/user.entity';
import { CacheKeys, CacheTTL } from '../common/cache-keys';

/** Versão usada quando o uid nunca teve as sessões invalidadas (ou a chave expirou). */
const INITIAL_SESSION_VERSION = '0';

/**
 * Prazo de cada operação de cache. O node-redis v4 não tem `commandTimeout`: com o Redis
 * conectado mas travado, um comando esperaria para sempre. Estourado o prazo, a operação
 * falha e cai no fail-open de cada método (miss → Firebase/banco; escrita → ignorada).
 */
export const CACHE_OP_TIMEOUT_MS = 500;

class CacheTimeoutError extends Error {
  constructor() {
    super(`cache operation timed out after ${CACHE_OP_TIMEOUT_MS} ms`);
    this.name = 'CacheTimeoutError';
  }
}

/** Dados necessários para gravar uma sessão de token no cache. */
export interface SessionWriteOptions {
  /** Expiração do ID token em epoch ms (ex.: `decoded.exp * 1000`). */
  expiresAt: number;
  /** Versão das sessões do uid lida com `getSessionVersion` ANTES de ler o perfil. */
  version: string;
}

interface SessionEntry {
  user: User;
  ver: string;
}

/**
 * Camada de cache para autenticação.
 *
 *  - auth:session:{sha256(token)} → { user, ver }  (TTL = min(5 min, exp do token))
 *    Evita chamadas HTTP ao Firebase a cada requisição.
 *
 *  - auth:sessver:{firebaseUid}   → string          (TTL 60 min)
 *    Versão das sessões do uid. Uma sessão só vale se `ver` for igual à versão atual;
 *    `invalidateAllSessions()` troca a versão e derruba todas as sessões do uid em O(1).
 *
 *  - user:profile:{firebaseUid}   → User            (TTL 10 min)
 *    Evita query ao banco após validação do token.
 */
@Injectable()
export class TokenCacheService {
  private readonly logger = new Logger(TokenCacheService.name);

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async getByToken(token: string): Promise<User | undefined> {
    try {
      const entry = await this.withTimeout(
        this.cache.get<SessionEntry>(CacheKeys.tokenSession(token)),
      );
      // Formato antigo (User puro) ou corrompido → trata como miss e revalida no Firebase
      if (!entry?.user?.firebaseUid || typeof entry.ver !== 'string') return undefined;

      const current = await this.readVersion(entry.user.firebaseUid);
      return entry.ver === current ? entry.user : undefined;
    } catch (err) {
      this.logger.warn(`Cache get (token) failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Versão atual das sessões do uid; capture-a antes de ler o perfil (cache ou banco). */
  async getSessionVersion(firebaseUid: string): Promise<string> {
    try {
      return await this.readVersion(firebaseUid);
    } catch (err) {
      this.logger.warn(`Cache get (session version) failed: ${(err as Error).message}`);
      return INITIAL_SESSION_VERSION;
    }
  }

  /** Grava a sessão do token e o perfil do usuário (perfil veio do banco). */
  async setByToken(token: string, user: User, opts: SessionWriteOptions): Promise<void> {
    try {
      if (!(await this.writeSession(token, user, opts))) return;
      await this.withTimeout(
        this.cache.set(CacheKeys.userProfile(user.firebaseUid), user, CacheTTL.USER_PROFILE),
      );
    } catch (err) {
      this.logger.warn(`Cache set (token) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Grava apenas a sessão do token, sem tocar em `user:profile`. Usado quando o perfil veio
   * do próprio cache de perfil: regravá-lo renovaria o TTL indefinidamente e o perfil
   * (incluindo `plan`) nunca seria relido do banco para usuários ativos.
   */
  async setSessionOnly(token: string, user: User, opts: SessionWriteOptions): Promise<void> {
    try {
      await this.writeSession(token, user, opts);
    } catch (err) {
      this.logger.warn(`Cache set (session) failed: ${(err as Error).message}`);
    }
  }

  async getByFirebaseUid(firebaseUid: string): Promise<User | undefined> {
    try {
      return await this.withTimeout(this.cache.get<User>(CacheKeys.userProfile(firebaseUid)));
    } catch (err) {
      this.logger.warn(`Cache get (profile) failed: ${(err as Error).message}`);
      return undefined;
    }
  }

  /** Apaga só o perfil em cache; as sessões continuam válidas. */
  async invalidateUser(firebaseUid: string): Promise<void> {
    try {
      await this.withTimeout(this.cache.del(CacheKeys.userProfile(firebaseUid)));
    } catch (err) {
      this.logger.warn(`Cache del (profile) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Derruba todas as sessões em cache do uid (logout, mudança de plano/perfil, revogação)
   * e o perfil. A nova versão é aleatória (sem read-modify-write), então invalidações
   * concorrentes não colidem. Não propaga falhas: no pior caso as sessões expiram pelo TTL.
   */
  async invalidateAllSessions(firebaseUid: string): Promise<void> {
    try {
      await this.withTimeout(
        this.cache.set(
          CacheKeys.sessionVersion(firebaseUid),
          randomUUID(),
          CacheTTL.SESSION_VERSION,
        ),
      );
    } catch (err) {
      this.logger.error(`Cache set (session version) failed: ${(err as Error).message}`);
    }
    await this.invalidateUser(firebaseUid);
  }

  private async readVersion(firebaseUid: string): Promise<string> {
    const ver = await this.withTimeout(
      this.cache.get<string>(CacheKeys.sessionVersion(firebaseUid)),
    );
    return ver ?? INITIAL_SESSION_VERSION;
  }

  /**
   * Grava a sessão com TTL = min(TOKEN_SESSION, tempo até o `exp` do token). Retorna false
   * (sem gravar nada) se o token já expirou ou se as sessões do uid foram invalidadas desde
   * que `opts.version` foi lida — nesse caso o perfil em mãos pode estar desatualizado.
   */
  private async writeSession(
    token: string,
    user: User,
    { expiresAt, version }: SessionWriteOptions,
  ): Promise<boolean> {
    const ttl = Math.min(CacheTTL.TOKEN_SESSION, Math.floor(expiresAt - Date.now()));
    if (!Number.isFinite(ttl) || ttl <= 0) return false;

    if ((await this.readVersion(user.firebaseUid)) !== version) return false;

    const entry: SessionEntry = { user, ver: version };
    await this.withTimeout(this.cache.set(CacheKeys.tokenSession(token), entry, ttl));
    return true;
  }

  /** Rejeita com `CacheTimeoutError` se a operação não terminar em `CACHE_OP_TIMEOUT_MS`. */
  private async withTimeout<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CacheTimeoutError()), CACHE_OP_TIMEOUT_MS);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
