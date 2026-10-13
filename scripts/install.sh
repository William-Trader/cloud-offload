#!/usr/bin/env bash
# Cloud Offload 一键安装（macOS / launchd）
# 用法： bash scripts/install.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
LA="$HOME/Library/LaunchAgents"
U="gui/$(id -u)"
NODE="$(command -v node || true)"
EDGE="/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
PROFILE="$HOME/.edge-cloud-offload"
LOGDIR="/tmp"

echo "== Cloud Offload 安装 =="
echo "项目目录: $HERE"

if [ -z "$NODE" ]; then echo "缺少 Node.js（>=20）"; exit 1; fi
if [ ! -x "$EDGE" ]; then echo "未找到 Microsoft Edge：$EDGE"; exit 1; fi

mkdir -p "$LA"

# 令牌（本地回环外访问时需要）
if [ ! -f "$HOME/.cloud-offload-token" ]; then
  LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c 32 > "$HOME/.cloud-offload-token"
  chmod 600 "$HOME/.cloud-offload-token"
  echo "已生成 $HOME/.cloud-offload-token"
fi
TOK="$(cat "$HOME/.cloud-offload-token")"

write_plist() {
  local label="$1" out="$2"; shift 2
  cat > "$out" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
$*
</dict></plist>
PLIST
}

# 1) 自动化 Edge（独立 profile，与日常浏览器隔离）
EDGE_ARGS="<key>Label</key><string>ai.openclaw.cloud-offload-edge</string>
<key>ProgramArguments</key><array>
<string>$EDGE</string>
<string>--remote-debugging-port=9222</string>
<string>--user-data-dir=$PROFILE</string>
<string>--no-first-run</string><string>--no-default-browser-check</string>
<string>--hide-crash-restore-bubble</string>
<string>https://chatglm.cn/main/alltoolsdetail</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOGDIR/cloud-offload-edge.log</string>
<key>StandardErrorPath</key><string>$LOGDIR/cloud-offload-edge.log</string>"

# 2) 本地工具桥
BRIDGE_ARGS="<key>Label</key><string>ai.openclaw.cloud-offload-bridge</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$HERE/bridge.mjs</string></array>
<key>EnvironmentVariables</key><dict>
<key>BRIDGE_TOKEN</key><string>$TOK</string>
<key>BRIDGE_HOST</key><string>127.0.0.1</string>
<key>BRIDGE_PORT</key><string>8787</string>
<key>BRIDGE_WORKDIR</key><string>$HOME</string>
<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>WorkingDirectory</key><string>$HERE</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOGDIR/cloud-offload-bridge.log</string>
<key>StandardErrorPath</key><string>$LOGDIR/cloud-offload-bridge.log</string>"

# 3) 网关 API
API_ARGS="<key>Label</key><string>ai.openclaw.cloud-offload-api</string>
<key>ProgramArguments</key><array><string>$NODE</string><string>$HERE/cloud-offload-api.mjs</string></array>
<key>EnvironmentVariables</key><dict>
<key>API_TOKEN</key><string>$TOK</string>
<key>BRIDGE_TOKEN</key><string>$TOK</string>
<key>BRIDGE_URL</key><string>http://127.0.0.1:8787</string>
<key>CDP_URL</key><string>http://127.0.0.1:9222</string>
<key>API_PORT</key><string>8788</string>
<key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>WorkingDirectory</key><string>$HERE</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>StandardOutPath</key><string>$LOGDIR/cloud-offload-api.log</string>
<key>StandardErrorPath</key><string>$LOGDIR/cloud-offload-api.log</string>"

write_plist edge "$LA/ai.openclaw.cloud-offload-edge.plist" "$EDGE_ARGS"
write_plist bridge "$LA/ai.openclaw.cloud-offload-bridge.plist" "$BRIDGE_ARGS"
write_plist api "$LA/ai.openclaw.cloud-offload-api.plist" "$API_ARGS"

for name in edge bridge api; do
  launchctl bootout "$U/ai.openclaw.cloud-offload-$name" 2>/dev/null || true
done
sleep 1
for name in edge bridge api; do
  launchctl bootstrap "$U" "$LA/ai.openclaw.cloud-offload-$name.plist"
  echo "已启动 ai.openclaw.cloud-offload-$name"
done

sleep 6
echo "== 健康检查 =="
curl -s -m 5 http://127.0.0.1:8788/health || echo "API 尚未就绪（Edge 首次需登录 chatglm.cn）"
echo
echo "完成。浏览器自动化 profile: $PROFILE（首次请在窗口里登录 chatglm.cn）"
