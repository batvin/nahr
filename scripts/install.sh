#!/usr/bin/env bash
# نهر — نصب ایجنت به عنوان سرویس systemd روی لینوکس
# استفاده: sudo bash scripts/install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
USER_NAME="${SUDO_USER:-$(whoami)}"
SERVICE_FILE="/etc/systemd/system/nahr-agent.service"

echo "==> نصب وابستگی‌ها"
cd "$DIR"
npm ci --omit=dev

echo "==> ایجاد مسیر داده"
mkdir -p "$DIR/data"
chown -R "$USER_NAME":"$USER_NAME" "$DIR/data" || true

echo "==> نصب سرویس systemd"
sed -e "s|__DIR__|$DIR|g" \
    -e "s|__USER__|$USER_NAME|g" \
    "$DIR/scripts/nahr-agent.service" > "$SERVICE_FILE"

systemctl daemon-reload
systemctl enable nahr-agent
systemctl restart nahr-agent

echo "==> تمام"
echo "وضعیت:  systemctl status nahr-agent"
echo "لاگ:     journalctl -u nahr-agent -f"
echo "پنل:     http://<SERVER-IP>:8080/panel"
