#!/bin/zsh
# Start the inference server under an explicit tier configuration, the way
# the protocol's eval-arm.js sets arms: tiers and budget written to
# config.json (original kept once at config.json.pre-study), server restarted,
# /health checked. This is the only correct way to measure memory and
# latency: what is resident is what the config says, nothing else.
#
#   study-server.sh start <budget_gb|default> <guard> <engine> <smith> [smith_policy]
#   study-server.sh stop
#   study-server.sh restore        # put config.json.pre-study back and stop
set -u
cd "$(dirname "$0")/.." || exit 1
ROOT="$(cd .. && pwd)"
CONFIG="$ROOT/config.json"
BACKUP="$ROOT/config.json.pre-study"
LOG="$ROOT/docs/measurements/router-study/study-inference.log"

stop_server() {
  local pid
  pid=$(lsof -ti :8787 -sTCP:LISTEN 2>/dev/null)
  if [ -n "$pid" ]; then kill $pid; for i in $(seq 1 30); do lsof -ti :8787 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 1; done; fi
}

case "${1:-}" in
  start)
    BUDGET=${2:?budget_gb or default}; GUARD=${3:?guard}; ENGINE=${4:?engine}; SMITH=${5:?smith}; SPOL=${6:-transient}
    [ -f "$BACKUP" ] || cp "$CONFIG" "$BACKUP"
    python3 - "$CONFIG" "$BUDGET" "$GUARD" "$ENGINE" "$SMITH" "$SPOL" <<'EOF'
import json, sys
path, budget, guard, engine, smith, spol = sys.argv[1:]
c = json.load(open(path))
m = c['models']
if budget == 'default': m.pop('budget_gb', None)
else: m['budget_gb'] = float(budget)
m['tiers'] = {
    'guard': {'model': guard, 'policy': 'resident'},
    'engine': {'model': engine, 'policy': 'resident'},
    'smith': {'model': smith, 'policy': spol},
}
json.dump(c, open(path, 'w'), indent=4); open(path, 'a').write('\n')
EOF
    stop_server
    ( cd inference && nohup python3 server.py >> "$LOG" 2>&1 & )
    for i in $(seq 1 90); do curl -s -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 2; done
    curl -s -m 5 http://127.0.0.1:8787/health | python3 -c "import json,sys; h=json.load(sys.stdin)['llm']; print('server up: tiers', {k:v.split('/')[-1] for k,v in h['tiers'].items()}, 'budget', h['budget_gb'], 'resident', [r.split('/')[-1] for r in h['resident']])" || { echo "server not reachable"; exit 1; }
    ;;
  stop) stop_server; echo "stopped" ;;
  restore)
    stop_server
    [ -f "$BACKUP" ] && cp "$BACKUP" "$CONFIG" && echo "config.json restored from pre-study copy"
    ;;
  *) echo "usage: study-server.sh start <budget|default> <guard> <engine> <smith> [smith_policy] | stop | restore"; exit 1 ;;
esac
