#!/usr/bin/env bash
# PreToolUse (Edit|Write|MultiEdit): bloqueia alterações em arquivos sensíveis.
set -euo pipefail
input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")
tool=$(jq -r '.tool_name // empty' <<<"$input")
[ -z "$file" ] && exit 0
rel=${file#"$CLAUDE_PROJECT_DIR/"}
base=$(basename "$file")

deny() { echo "Bloqueado pelo hook protect-files: $1" >&2; exit 2; }

case "$base" in
  .env|.env.local|.env.*.local|.env.production|.env.development)
    deny "$rel contém segredos locais. Edite manualmente." ;;
  package-lock.json)
    deny "package-lock.json só deve mudar via npm install/uninstall." ;;
esac

# Migrations versionadas são imutáveis (já podem ter sido aplicadas em algum ambiente).
# Criar novas e ajustar as recém-geradas (ainda fora do Git) é permitido.
if [[ "$rel" == src/database/migrations/*.ts && -f "$file" ]] \
   && git -C "$CLAUDE_PROJECT_DIR" ls-files --error-unmatch "$rel" >/dev/null 2>&1; then
  deny "$rel é uma migration existente. Gere uma nova com 'make migration-generate name=...'."
fi
exit 0
