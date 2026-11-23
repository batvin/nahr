#!/usr/bin/env bash
# نهر — نصب تکخطی روی Ubuntu/Debian
# استفاده:
#   curl -fsSL https://raw.githubusercontent.com/batvin/nahr/main/scripts/quick-install.sh | sudo bash
set -euo pipefail

REPO="https://github.com/batvin/nahr.git"
DIR="/opt/nahr"
NODE_VERSION="v22.23.5"
PANEL_PORT="18080"
AGENT_PORT="7700"

if [ "$(id -u)" -ne 0 ]; then
  echo "لطفاً با sudo اجرا کنید:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/batvin/nahr/main/scripts/quick-install.sh | sudo bash" >&2
  exit 1
fi

echo "==> نصب ابزارهای پایه"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git ca-certificates xz-utils >/dev/null

echo "==> بررسی Node.js"
need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  major="$(node -v | sed 's/^v//' | cut -d. -f1)"
  [ "$major" -ge 20 ] || need_node=1
fi

if [ "$need_node" -eq 1 ]; then
  case "$(uname -m)" in
    x86_64|amd64) arch="x64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) echo "معماری پشتیبانی نشده: $(uname -m)" >&2; exit 1 ;;
  esac
  echo "==> نصب Node $NODE_VERSION ($arch)"
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$arch.tar.xz" \
    | tar -xJ --strip-components=1 -C /usr/local
fi
NODE_BIN="$(command -v node)"
echo "    $(node -v) — $NODE_BIN"

echo "==> دریافت/بهروزرسانی کد نهر"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --quiet origin main
  git -C "$DIR" reset --hard --quiet origin/main
else
  rm -rf "$DIR"
  git clone --quiet --depth 1 "$REPO" "$DIR"
fi

echo "==> نصب وابستگیها"
cd "$DIR"
npm ci --omit=dev --silent

echo "==> نصب فرمانهای ترمینالی"
chmod +x "$DIR/bin/nahr.js" "$DIR/bin/nahr-manager.js"
ln -sfn "$DIR/bin/nahr.js" /usr/local/bin/nahr
ln -sfn "$DIR/bin/nahr-manager.js" /usr/local/bin/nahr-manager

echo "==> ایجاد کاربر و مسیرهای داده"
id -u nahr >/dev/null 2>&1 || useradd --system --home-dir /var/lib/nahr --shell /usr/sbin/nologin nahr
mkdir -p /var/lib/nahr/panel /var/lib/nahr/agent
chown -R nahr:nahr /var/lib/nahr "$DIR"

echo "==> ساخت توکن و state اولیه"
if [ ! -s /var/lib/nahr/panel/state.json ]; then
  TOKEN="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("hex"))')"
  NAHR_DATA=/var/lib/nahr/panel node -e '
    const fs=require("fs"),p=process.env.NAHR_DATA+"/state.json";
    fs.writeFileSync(p, JSON.stringify({
      version:1, secret:process.argv[1], servers:[], tunnels:[],
      settings:{theme:"dark",benchSeconds:3,benchStreams:3,autoScore:true},
      history:[], demo:{running:false,agents:[]}
    }, null, 2));
  ' "$TOKEN"
else
  TOKEN="$(NAHR_DATA=/var/lib/nahr/panel node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.NAHR_DATA+"/state.json","utf8")).secret||"")')"
fi
chmod 600 /var/lib/nahr/panel/state.json

HOST_ID="$(hostname)"

echo "==> نصب واحدهای systemd"
cat > /etc/systemd/system/nahr-panel.service <<EOF
[Unit]
Description=Nahr Panel (RTL)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nahr
WorkingDirectory=$DIR
Environment=NODE_ENV=production
Environment=NAHR_DATA=/var/lib/nahr/panel
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=$NODE_BIN $DIR/bin/nahr.js panel --port $PANEL_PORT --host 127.0.0.1
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/nahr-agent.service <<EOF
[Unit]
Description=Nahr Tunnel Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=nahr
WorkingDirectory=$DIR
Environment=NODE_ENV=production
Environment=NAHR_DATA=/var/lib/nahr/agent
Environment=NAHR_TOKEN=$TOKEN
Environment=NODE_OPTIONS=--max-old-space-size=256
ExecStart=$NODE_BIN $DIR/bin/nahr.js agent --port $AGENT_PORT --id $HOST_ID --name $HOST_ID --host 0.0.0.0
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now nahr-panel nahr-agent >/dev/null

for _ in $(seq 1 15); do
  curl -fsS "http://127.0.0.1:$PANEL_PORT/api/tunnels" >/dev/null 2>&1 && break
  sleep 1
done

PUBLIC_IP="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"

cat <<EOF

============================================================
  نهر نصب شد ✓
============================================================
  پنل (روی همین سرور):   http://127.0.0.1:$PANEL_PORT/panel
  وبسایت و مستندات:      http://127.0.0.1:$PANEL_PORT/
  ایجنت:                 0.0.0.0:$AGENT_PORT
  توکن مشترک:            $TOKEN

  برای دیدن پنل از کامپیوتر خود، روی ویندوز/مکتان بزنید:
    ssh -L $PANEL_PORT:127.0.0.1:$PANEL_PORT root@$PUBLIC_IP

  سپس در مرورگر باز کنید:
    http://localhost:$PANEL_PORT/panel

  وضعیت سرویسها:
    systemctl status nahr-panel nahr-agent
  لاگ:
    journalctl -u nahr-panel -f

   منوی ترمینالی (نصب، پنل، ایجنت، لاگ و حذف):
     sudo nahr-manager
============================================================
EOF
