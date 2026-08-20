#!/bin/zsh
# Pairing code for the phone app: the daemon's host, port and socket token,
# as a QR the phone scans once. Prefers the tailnet address; falls back to
# the LAN. LAN pairing needs remote.lan_bind true in config.json (and a
# daemon restart); the tailnet path needs `tailscale serve` instead.
TOKEN=$(cat "$HOME/.jarvis/socket-token" 2>/dev/null)
[ -z "$TOKEN" ] && { echo "No socket token yet; start the daemon once first."; exit 1; }
SECRET=$(cat "$HOME/.jarvis/pairing-secret" 2>/dev/null)
[ -z "$SECRET" ] && { echo "No pairing secret yet; start the daemon once first."; exit 1; }
HOST=${1:-}
if [ -z "$HOST" ] && command -v tailscale >/dev/null 2>&1; then
    HOST=$(tailscale ip -4 2>/dev/null | head -1)
    [ -n "$HOST" ] && echo "Using the tailnet address."
fi
if [ -z "$HOST" ]; then
    HOST=$(ipconfig getifaddr en0 2>/dev/null)
    [ -n "$HOST" ] && echo "Using the Wi-Fi address (both devices must share this network)."
fi
[ -z "$HOST" ] && { echo "No address found; pass one: pair-phone.sh <host>"; exit 1; }
echo "Pairing target: $HOST:8080"
# The QR carries the TURN relay list too, so the phone learns the relay the
# moment it pairs — no app rebuild when the relay changes.
CONFIG="${0:A:h}/../../config.json"
TURN=$(node -e "
try {
  const t = (require('$CONFIG').remote || {}).turn;
  if (Array.isArray(t) && t.length) process.stdout.write(t.join(','));
} catch {}" 2>/dev/null)
PAYLOAD="{\"host\":\"$HOST\",\"port\":8080,\"token\":\"$TOKEN\",\"secret\":\"$SECRET\"}"
[ -n "$TURN" ] && PAYLOAD="{\"host\":\"$HOST\",\"port\":8080,\"token\":\"$TOKEN\",\"secret\":\"$SECRET\",\"turn\":\"$TURN\"}"
qrencode -t ansiutf8 "$PAYLOAD"
echo "Scan from the app's pairing screen. Treat this code like a password."
