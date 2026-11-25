#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# FinTrack OS Backend — Verificação pós-setup
# Valida que todos os serviços estão acessíveis e o ambiente está funcional.
# Uso: bash scripts/validate-setup.sh
# ─────────────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

ok()   { echo -e "  ${GREEN}✔${NC}  $1"; }
fail() { echo -e "  ${RED}✗${NC}  $1"; }

# Carrega o .env se existir
if [ -f .env ]; then
  set -o allexport
  # shellcheck source=/dev/null
  source .env
  set +o allexport
fi

DB_USERNAME="${DB_USERNAME:-fintrack}"

echo -e "\nVerificando ambiente...\n"

ERRORS=0

# ── Containers ────────────────────────────────────────────────────────────────

echo "  [Containers Docker]"

if docker ps --format '{{.Names}}' | grep -q "^fintrack_postgres$"; then
  ok "fintrack_postgres está rodando"
else
  fail "fintrack_postgres não está rodando"
  ERRORS=$((ERRORS + 1))
fi

if docker ps --format '{{.Names}}' | grep -q "^fintrack_redis$"; then
  ok "fintrack_redis está rodando"
else
  fail "fintrack_redis não está rodando"
  ERRORS=$((ERRORS + 1))
fi

# ── PostgreSQL ────────────────────────────────────────────────────────────────

echo ""
echo "  [PostgreSQL]"

if docker exec fintrack_postgres pg_isready -U "$DB_USERNAME" >/dev/null 2>&1; then
  ok "Conexão com PostgreSQL OK"
else
  fail "PostgreSQL não está aceitando conexões"
  ERRORS=$((ERRORS + 1))
fi

# ── Redis ─────────────────────────────────────────────────────────────────────

echo ""
echo "  [Redis]"

if docker exec fintrack_redis redis-cli ping 2>/dev/null | grep -q PONG; then
  ok "Conexão com Redis OK"
else
  fail "Redis não está respondendo"
  ERRORS=$((ERRORS + 1))
fi

# ── Migrations ────────────────────────────────────────────────────────────────

echo ""
echo "  [Migrations]"

MIGRATION_OUTPUT=$(npm run migration:show --silent 2>&1 || true)

if echo "$MIGRATION_OUTPUT" | grep -q "\[X\]"; then
  ok "Ao menos uma migration aplicada"
else
  fail "Nenhuma migration foi aplicada"
  ERRORS=$((ERRORS + 1))
fi

if echo "$MIGRATION_OUTPUT" | grep -q "\[ \]"; then
  fail "Existem migrations pendentes — execute: make db-setup"
  ERRORS=$((ERRORS + 1))
else
  ok "Sem migrations pendentes"
fi

# ── Resultado ─────────────────────────────────────────────────────────────────

echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo -e "${RED}  ✗  $ERRORS problema(s) encontrado(s). Verifique os itens acima.${NC}\n"
  exit 1
fi

echo -e "${GREEN}  ✔  Ambiente verificado com sucesso.${NC}\n"
