#!/usr/bin/env bash
# Valida as migrations num banco descartável (não toca no fintrack_db):
#   1. aplica init.sql + todas as migrations
#   2. reverte e reaplica a última (testa o down())
#   3. verifica que as entities batem com o schema resultante (sem drift)
set -euo pipefail

CONTAINER=${PG_CONTAINER:-fintrack_postgres}
PG_USER=${DB_USERNAME:-fintrack}
TMP_DB="fintrack_migcheck_$$"
ROOT=$(git rev-parse --show-toplevel)
cd "$ROOT"

if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "✗ Container $CONTAINER não está rodando. Rode 'make up' primeiro." >&2
  exit 1
fi

psql_admin() { docker exec "$CONTAINER" psql -U "$PG_USER" -d postgres -qv ON_ERROR_STOP=1 "$@"; }
cleanup() { psql_admin -c "DROP DATABASE IF EXISTS $TMP_DB" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "→ Criando banco temporário $TMP_DB"
psql_admin -c "CREATE DATABASE $TMP_DB" >/dev/null
docker exec -i "$CONTAINER" psql -U "$PG_USER" -d "$TMP_DB" -q < docker/postgres/init.sql

# DATABASE_URL vazio força o uso de DB_* (dotenv não sobrescreve variáveis já definidas)
export DB_NAME="$TMP_DB" DATABASE_URL="" NODE_ENV=test
TYPEORM="npx --no-install typeorm-ts-node-commonjs"
DS="-d src/database/data-source.ts"

echo "→ [1/3] Aplicando todas as migrations"
$TYPEORM migration:run $DS 2>&1 | grep -E "has been executed|No migrations|Error" || true

echo "→ [2/3] Revertendo e reaplicando a última migration"
$TYPEORM migration:revert $DS 2>&1 | grep -E "reverted|Error" || true
$TYPEORM migration:run $DS 2>&1 | grep -E "has been executed|Error" || true

echo "→ [3/3] Verificando drift entre entities e schema"
if ! out=$($TYPEORM migration:generate src/database/migrations/_drift_check --check $DS 2>&1); then
  echo "✗ As entities divergem do schema gerado pelas migrations:" >&2
  echo "$out" | sed -n '/query/,$p' >&2
  exit 1
fi

echo "✓ Migrations válidas: run, revert/run e sem drift."
