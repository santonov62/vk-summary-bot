# Адрес сервера: из аргумента, переменной окружения или DEPLOY_HOST в .env
DEPLOY_HOST="${1:-${DEPLOY_HOST:-$(grep -E '^DEPLOY_HOST=' .env 2>/dev/null | cut -d= -f2-)}}"
if [ -z "$DEPLOY_HOST" ]; then
  echo "Укажите сервер: DEPLOY_HOST=root@1.2.3.4 в .env или аргументом скрипта" >&2
  exit 1
fi
