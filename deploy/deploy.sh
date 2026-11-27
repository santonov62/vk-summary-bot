#!/usr/bin/env bash
# Копирует бота на сервер и (пере)запускает сервис.
# Использование: ./deploy/deploy.sh [root@1.2.3.4] (по умолчанию — DEPLOY_HOST из .env)
set -euo pipefail

APP_DIR=/opt/vk-summary-bot
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "Нет файла .env — заполните его по .env.example" >&2
  exit 1
fi
source deploy/host.sh
HOST="$DEPLOY_HOST"

ssh "$HOST" "mkdir -p $APP_DIR"
rsync -az --delete src package.json "$HOST:$APP_DIR/"
rsync -az .env "$HOST:$APP_DIR/.env"
rsync -az deploy/vk-summary-bot.service "$HOST:/etc/systemd/system/vk-summary-bot.service"

ssh "$HOST" bash -s <<EOF
set -euo pipefail
id vkbot >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin vkbot
chown -R root:vkbot $APP_DIR
chmod 750 $APP_DIR
chmod 640 $APP_DIR/.env
systemctl daemon-reload
systemctl enable vk-summary-bot >/dev/null
systemctl restart vk-summary-bot
sleep 3
systemctl --no-pager --lines=5 status vk-summary-bot
EOF
