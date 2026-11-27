#!/usr/bin/env bash
# Лог бота с сервера в реальном времени.
# Использование: ./deploy/logs.sh [root@1.2.3.4]
set -euo pipefail
cd "$(dirname "$0")/.."
source deploy/host.sh

ssh "$DEPLOY_HOST" journalctl -u vk-summary-bot -f -n 50
