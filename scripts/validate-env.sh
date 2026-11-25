#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# FinTrack OS Backend — Validação de variáveis de ambiente
# Uso: bash scripts/validate-env.sh
# ─────────────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✔${NC}  $1"; }
warn() { echo -e "  ${YELLOW}⚠${NC}   $1"; }
fail() { echo -e "  ${RED}✗${NC}  $1"; }

# Carrega o .env se existir (não sobrescreve vars já definidas no ambiente)
if [ -f .env ]; then
  set -o allexport
  # shellcheck source=/dev/null
  source .env
  set +o allexport
fi

NODE_ENV="${NODE_ENV:-development}"

echo -e "\nValidando variáveis de ambiente (NODE_ENV=${NODE_ENV})...\n"

ERRORS=0

check_required() {
  local var="$1"
  local value="${!var:-}"
  if [ -z "$value" ]; then
    fail "${var} não está definida ou está vazia"
    ERRORS=$((ERRORS + 1))
  else
    ok "${var}"
  fi
}

check_optional() {
  local var="$1"
  local value="${!var:-}"
  if [ -z "$value" ]; then
    warn "${var} não definida (opcional)"
  else
    ok "${var}"
  fi
}

# ── Aplicação ─────────────────────────────────────────────────────────────────
echo "  [Aplicação]"
check_required "NODE_ENV"
check_required "PORT"
if [ -z "${APP_TIMEZONE:-}" ]; then
  warn "APP_TIMEZONE não definida (opcional) — usará o padrão America/Sao_Paulo"
elif ! command -v node >/dev/null 2>&1; then
  warn "APP_TIMEZONE (${APP_TIMEZONE}) — node indisponível, fuso validado só no boot"
elif node -e "new Intl.DateTimeFormat('en-CA', { timeZone: process.argv[1] })" "$APP_TIMEZONE" 2>/dev/null; then
  ok "APP_TIMEZONE (${APP_TIMEZONE})"
else
  fail "APP_TIMEZONE=\"${APP_TIMEZONE}\" não é um fuso IANA válido (ex.: America/Sao_Paulo)"
  ERRORS=$((ERRORS + 1))
fi

# ── Banco de dados ────────────────────────────────────────────────────────────
echo ""
echo "  [Banco de dados]"
check_required "DB_HOST"
check_required "DB_PORT"
check_required "DB_USERNAME"
check_required "DB_PASSWORD"
check_required "DB_NAME"

# ── Redis ─────────────────────────────────────────────────────────────────────
echo ""
echo "  [Redis]"
check_required "REDIS_HOST"
check_required "REDIS_PORT"
if [ "$NODE_ENV" = "production" ]; then
  check_required "REDIS_PASSWORD"
else
  check_optional "REDIS_PASSWORD"
fi
check_optional "REDIS_TLS"

# ── Endurecimento de produção ─────────────────────────────────────────────────
if [ "$NODE_ENV" = "production" ]; then
  echo ""
  echo "  [Produção]"
  if [ "${DB_SSL:-true}" = "false" ]; then
    warn "DB_SSL=false — conexão com o Postgres sem TLS"
  fi
  if [ "${DB_SSL_REJECT_UNAUTHORIZED:-true}" = "false" ]; then
    warn "DB_SSL_REJECT_UNAUTHORIZED=false — certificado do Postgres não é validado"
  fi
  check_optional "DB_SSL_CA"
  check_optional "TRUST_PROXY"
  if [ "${SWAGGER_ENABLED:-false}" = "true" ]; then
    warn "SWAGGER_ENABLED=true — documentação da API exposta em produção"
  fi
fi

# ── Firebase ──────────────────────────────────────────────────────────────────
echo ""
echo "  [Firebase Admin SDK]"
check_required "FIREBASE_PROJECT_ID"
check_required "FIREBASE_PRIVATE_KEY"
check_required "FIREBASE_CLIENT_EMAIL"

# ── WhatsApp (opcionais) ──────────────────────────────────────────────────────
echo ""
echo "  [WhatsApp — opcionais]"
check_optional "WHATSAPP_API_TOKEN"
check_optional "WHATSAPP_PHONE_NUMBER_ID"

# ── CORS (opcional) ───────────────────────────────────────────────────────────
echo ""
echo "  [CORS — opcional]"
check_optional "CORS_ORIGIN"

# ── Resultado ─────────────────────────────────────────────────────────────────
echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}  ✗  $ERRORS variável(is) obrigatória(s) ausente(s). Corrija o .env antes de continuar.${NC}\n"
  exit 1
fi

echo -e "${GREEN}  ✔  Todas as variáveis obrigatórias estão definidas.${NC}\n"
