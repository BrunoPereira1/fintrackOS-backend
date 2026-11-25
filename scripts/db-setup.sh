#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# FinTrack OS Backend — Setup do banco de dados
# Uso: bash scripts/db-setup.sh [--seed]
# ─────────────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

step()  { echo -e "\n${GREEN}▶ $1${NC}"; }
error() { echo -e "${RED}✗ $1${NC}"; exit 1; }

RUN_SEED=false
for arg in "$@"; do
  case $arg in
    --seed) RUN_SEED=true ;;
  esac
done

# Carrega o .env se existir
if [ -f .env ]; then
  set -o allexport
  # shellcheck source=/dev/null
  source .env
  set +o allexport
fi

DB_USERNAME="${DB_USERNAME:-fintrack}"

# ── Aguarda PostgreSQL ────────────────────────────────────────────────────────

step "Aguardando PostgreSQL ficar pronto..."

RETRIES=30
until docker exec fintrack_postgres pg_isready -U "$DB_USERNAME" >/dev/null 2>&1; do
  RETRIES=$((RETRIES - 1))
  if [ "$RETRIES" -le 0 ]; then
    error "PostgreSQL não ficou pronto a tempo. Verifique o container."
  fi
  sleep 1
done

echo "  PostgreSQL pronto."

# ── Migrations ────────────────────────────────────────────────────────────────

step "Executando migrations..."
npm run migration:run
echo "  Migrations aplicadas."

# ── Seed (opcional) ───────────────────────────────────────────────────────────

if [ "$RUN_SEED" = true ]; then
  step "Populando banco com dados iniciais (seed)..."
  npm run seed
  echo "  Seed concluído."
fi

echo -e "\n${GREEN}  ✔  Banco de dados pronto.${NC}\n"
