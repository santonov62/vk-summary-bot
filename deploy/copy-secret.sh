#!/usr/bin/env bash
# Копирует значение секрета для GitHub Actions в буфер обмена (macOS).
# Использование: ./deploy/copy-secret.sh SSH_PRIVATE_KEY | SSH_KNOWN_HOSTS | ENV_FILE
set -euo pipefail
cd "$(dirname "$0")/.."

KEY="${DEPLOY_KEY:-$HOME/.ssh/vk-summary-bot-deploy}"
case "${1:-}" in
  SSH_PRIVATE_KEY) pbcopy < "$KEY" ;;
  SSH_KNOWN_HOSTS) pbcopy < "$KEY.known_hosts" ;;
  ENV_FILE) pbcopy < .env ;;
  *) echo "Использование: $0 SSH_PRIVATE_KEY | SSH_KNOWN_HOSTS | ENV_FILE" >&2; exit 1 ;;
esac
echo "$1 скопирован в буфер обмена — вставьте его в GitHub"
