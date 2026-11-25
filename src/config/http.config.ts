/**
 * Valor para `app.set('trust proxy', ...)` a partir de `TRUST_PROXY`.
 *  - vazio/`false` → desligado (default; req.ip = IP do socket);
 *  - número (`1`, `2`…) → quantidade de proxies confiáveis à frente da API (recomendado);
 *  - `true` → confia em qualquer X-Forwarded-For (não recomendado: permite forjar IP);
 *  - outro texto → repassado ao Express (ex.: `loopback`, `10.0.0.0/8`).
 */
export function parseTrustProxy(value: string | undefined): boolean | number | string {
  const raw = value?.trim();
  if (!raw || raw.toLowerCase() === 'false') return false;
  if (raw.toLowerCase() === 'true') return true;
  if (/^\d+$/.test(raw)) return Number(raw);
  return raw;
}

/** Swagger fica fora em produção, salvo `SWAGGER_ENABLED=true` explícito. */
export function isSwaggerEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.SWAGGER_ENABLED?.trim().toLowerCase() === 'true') return true;
  return env.NODE_ENV !== 'production';
}
