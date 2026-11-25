#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit): formata e corrige lint no arquivo .ts editado.
set -uo pipefail
file=$(jq -r '.tool_input.file_path // empty')
[[ "$file" == *.ts && -f "$file" ]] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
npx --no-install prettier --write "$file" >/dev/null 2>&1
if ! out=$(npx --no-install eslint --fix "$file" 2>&1); then
  echo "ESLint encontrou problemas em $file:" >&2
  echo "$out" >&2
  exit 2   # devolve o erro ao Claude para corrigir
fi
exit 0
