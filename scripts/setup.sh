#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# FinTrack OS Backend — Script de configuração para novos desenvolvedores
# ─────────────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

step()  { echo -e "\n${GREEN}▶ $1${NC}"; }
warn()  { echo -e "${YELLOW}⚠  $1${NC}"; }
error() { echo -e "${RED}✗ $1${NC}"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Pré-requisitos ────────────────────────────────────────────────────────────

step "Verificando pré-requisitos..."

command -v node   >/dev/null 2>&1 || error "Node.js não encontrado. Instale a versão LTS em https://nodejs.org"
command -v npm    >/dev/null 2>&1 || error "npm não encontrado."
command -v docker >/dev/null 2>&1 || error "Docker não encontrado. Instale em https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || error "Docker Compose não encontrado."

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js v20+ é necessário (atual: $(node -v))"
fi

echo "  Node.js  : $(node -v)"
echo "  npm      : $(npm -v)"
echo "  Docker   : $(docker --version)"

# ── Variáveis de ambiente ─────────────────────────────────────────────────────

step "Configurando variáveis de ambiente..."

if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Arquivo .env criado a partir do .env.example"
  warn "Revise o .env antes de continuar (Firebase, WhatsApp, banco, Redis...)"
else
  echo "  Arquivo .env já existe, pulando."
fi

# ── Validação de variáveis ────────────────────────────────────────────────────

step "Validando variáveis de ambiente..."
bash "$SCRIPT_DIR/validate-env.sh"

# ── Dependências ──────────────────────────────────────────────────────────────

step "Instalando dependências npm..."
npm install

# ── Infraestrutura local ──────────────────────────────────────────────────────

step "Subindo containers (PostgreSQL + Redis)..."
docker compose up -d

echo "  Aguardando Redis ficar pronto..."
until docker exec fintrack_redis redis-cli ping 2>/dev/null | grep -q PONG; do
  sleep 1
done
echo "  Redis pronto."

# ── Banco de dados ────────────────────────────────────────────────────────────

bash "$SCRIPT_DIR/db-setup.sh"

# ── Verificação final ─────────────────────────────────────────────────────────

step "Verificando ambiente..."
bash "$SCRIPT_DIR/validate-setup.sh"

# ── Conclusão ─────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  ✔  Ambiente pronto!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Para iniciar o servidor em modo desenvolvimento:"
echo ""
echo "      make dev"
echo ""
echo "  Swagger disponível em:  http://localhost:3001/docs"
echo "  Bull Board (filas):     http://localhost:3002"
echo "  PostgreSQL:             localhost:5432  (banco: fintrack_db)"
echo "  Redis:                  localhost:6379"
echo ""
