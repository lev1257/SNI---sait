#!/usr/bin/env bash
# MAISON — установка статического сайта: nginx + Let's Encrypt
# Запуск из папки репозитория:   sudo bash deploy.sh [домен] [email]
# Или прямо с GitHub:            sudo REPO_URL=https://github.com/USER/REPO.git bash deploy.sh
# Поддержка: Debian / Ubuntu.
set -euo pipefail

REPO_URL="${REPO_URL:-}"
SRC_CLONE_DIR="/opt/maison-src"
WEB_BASE="/var/www"

info() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Запусти от root: sudo bash deploy.sh"
command -v apt-get >/dev/null || die "Поддерживаются только Debian/Ubuntu"

# ---------- Ввод домена и email ----------
DOMAIN="${1:-}"
EMAIL="${2:-}"
[[ -n "$DOMAIN" ]] || read -rp "Домен (например maison.example.com): " DOMAIN
DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z' | sed -E 's#^https?://##; s#/.*$##; s#\s##g')"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$ ]] || die "Некорректный домен: $DOMAIN"

[[ -n "$EMAIL" ]] || read -rp "Email для Let's Encrypt: " EMAIL
[[ "$EMAIL" =~ ^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$ ]] || die "Некорректный email: $EMAIL"

WEB_ROOT="$WEB_BASE/$DOMAIN"

# ---------- Пакеты ----------
info "Установка пакетов (nginx, certbot, git)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-certbot-nginx git curl ca-certificates

systemctl enable --now nginx

# ---------- Исходники сайта ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$SCRIPT_DIR/index.html" ]]; then
  SRC_DIR="$SCRIPT_DIR"
  info "Использую файлы из $SRC_DIR"
else
  [[ -n "$REPO_URL" ]] || die "index.html рядом со скриптом не найден. Укажи REPO_URL."
  info "Клонирую репозиторий $REPO_URL"
  if [[ -d "$SRC_CLONE_DIR/.git" ]]; then
    git -C "$SRC_CLONE_DIR" pull --ff-only
  else
    rm -rf "$SRC_CLONE_DIR"
    git clone --depth 1 "$REPO_URL" "$SRC_CLONE_DIR"
  fi
  SRC_DIR="$SRC_CLONE_DIR"
fi
[[ -f "$SRC_DIR/index.html" ]] || die "В $SRC_DIR нет index.html"

# ---------- Проверка DNS ----------
info "Проверка DNS для $DOMAIN"
SERVER_IP="$(curl -4 -fsS --max-time 10 https://ifconfig.me 2>/dev/null || true)"
DNS_IP="$(getent ahostsv4 "$DOMAIN" | awk 'NR==1{print $1}' || true)"
if [[ -z "$DNS_IP" ]]; then
  warn "Домен $DOMAIN сейчас не резолвится. Создай A-запись на IP сервера и подожди."
elif [[ -n "$SERVER_IP" && "$DNS_IP" != "$SERVER_IP" ]]; then
  warn "A-запись $DOMAIN -> $DNS_IP, а IP сервера $SERVER_IP. Certbot не выпустит сертификат, пока они не совпадут."
else
  echo "DNS в порядке: $DOMAIN -> $DNS_IP"
fi

# ---------- Копирование сайта ----------
info "Копирую сайт в $WEB_ROOT"
mkdir -p "$WEB_ROOT"
find "$WEB_ROOT" -mindepth 1 -delete
tar -C "$SRC_DIR" --exclude=.git --exclude=deploy.sh -cf - . | tar -C "$WEB_ROOT" -xf -
chown -R www-data:www-data "$WEB_ROOT"
find "$WEB_ROOT" -type d -exec chmod 755 {} \;
find "$WEB_ROOT" -type f -exec chmod 644 {} \;

# ---------- Конфиг nginx ----------
info "Настраиваю nginx для $DOMAIN"
CONF="/etc/nginx/sites-available/$DOMAIN"
sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__ROOT__|$WEB_ROOT|g" > "$CONF" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    root __ROOT__;
    index index.html;
    charset utf-8;

    gzip on;
    gzip_comp_level 5;
    gzip_types text/css application/javascript application/json image/svg+xml;

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "SAMEORIGIN" always;

    location ~ /\. {
        deny all;
    }

    location ~* \.(css|js)$ {
        expires 7d;
        add_header Cache-Control "public";
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ =404;
    }
}
NGINX

ln -sfn "$CONF" "/etc/nginx/sites-enabled/$DOMAIN"
nginx -t
systemctl reload nginx

# ---------- Фаервол ----------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  info "Открываю порты 80/443 в ufw"
  ufw allow 'Nginx Full' >/dev/null
fi

# ---------- Сертификат ----------
info "Выпуск сертификата Let's Encrypt для $DOMAIN"
certbot --nginx \
  -d "$DOMAIN" \
  -m "$EMAIL" \
  --agree-tos --no-eff-email \
  --redirect \
  --keep-until-expiring \
  --non-interactive

nginx -t
systemctl reload nginx

# ---------- Автообновление ----------
info "Включаю автообновление сертификата"
systemctl enable --now certbot.timer
certbot renew --dry-run

info "Готово"
echo "Сайт:       https://$DOMAIN"
echo "Файлы:      $WEB_ROOT"
echo "Конфиг:     $CONF"
echo "Обновление: при изменениях в репо повтори: sudo bash deploy.sh $DOMAIN $EMAIL"