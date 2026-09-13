#!/bin/zsh
# One pass of the evaluation suite through the running app. Usage:
#   tools/eval-pass.sh <mailbox> <arm> <pass-name> [mail-only]
# The mailbox names an entry of docs/evaluation/mailboxes.json, which gives
# its provider and the counterpart address; the daemon's mail provider is set
# to match and the app restarted. Runs are
# strictly sequential; a task in the suite's repeat list runs three times in
# a row. Resumable: rows already recorded for this pass are skipped.
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT/backend" || exit 1
M=$ROOT/docs/measurements
E=$ROOT/docs/evaluation
APP=$ROOT/frontend/src-tauri/target/release/bundle/macos/JARVIS.app
OUT=$M/suite-runs.jsonl
MAILBOX=$1 ARM=$2 PASS=$3 MAILONLY=${4:-}
SYSTEM=${SYSTEM:-jarvis}
OC=$HOME/.openclaw/openclaw.json
WEBTRUTH=${WEBTRUTH:-$E/web-truth.js}
MAILTOOL=${MAILTOOL:-$E/mailbox.js}
export PATH="$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
read_mailbox() { node -e "const m=require('$E/mailboxes.json')['$MAILBOX']; if(!m){console.error('unknown mailbox $MAILBOX');process.exit(1)} process.stdout.write(m.$1)"; }
PROVIDER=$(read_mailbox provider) || exit 1
CONTACT=$(read_mailbox contact) || exit 1
export EVAL_MAILBOX=$MAILBOX EVAL_CONTACT=$CONTACT
say() { echo "[$PASS] $(date '+%F %T') $*"; }
# The baseline is pointed at the configuration's guard model and asked one
# capped question before the pass, so a hung gateway cannot hold the night.
set_openclaw_model() {
  python3 - "$OC" "$1" <<'PY'
import json, sys
path, model = sys.argv[1:]
c = json.load(open(path))
c.setdefault('agents', {}).setdefault('defaults', {}).setdefault('model', {})['primary'] = f'jarvis/{model}'
json.dump(c, open(path, 'w'), indent=2); open(path, 'a').write('\n')
PY
  openclaw daemon restart >/dev/null 2>&1 || { openclaw daemon stop >/dev/null 2>&1; sleep 2; openclaw daemon start >/dev/null 2>&1; }
  sleep 6
  say "openclaw model: $(openclaw agents list 2>/dev/null | /usr/bin/grep -m1 'Model:' | sed 's/.*Model: //')"
}
baseline_ready() {
  local plumb=$(node -e "
const { execFile } = require('child_process');
execFile('openclaw', ['agent', '--agent', 'main', '--message', 'reply with the single word ready', '--timeout', '180'], { timeout: 200000 }, (err, out, errOut) => {
  process.stdout.write(String(out || '') + String(errOut || '')); process.exit(0); });" 2>&1 | tail -c 400)
  echo "$plumb" | /usr/bin/grep -qi "ready" && { say "openclaw answers"; return 0; }
  say "openclaw plumbing failed: $(echo "$plumb" | tail -c 120 | tr '\n' ' ')"; return 1
}
up() { curl -s -m 3 http://127.0.0.1:8080/health >/dev/null 2>&1 && curl -s -m 3 http://127.0.0.1:8787/health >/dev/null 2>&1; }
tiers() { curl -s -m 5 http://127.0.0.1:8787/health | python3 -c "import json,sys; h=json.load(sys.stdin)['llm']; print(' '.join(v.split('/')[-1] for v in h['tiers'].values()))" 2>/dev/null; }
stop_app() {
  osascript -e 'quit app "JARVIS"' >/dev/null 2>&1; sleep 3
  pkill -f "JARVIS.app/Contents/MacOS" >/dev/null 2>&1
  for p in 8080 8787; do pid=$(lsof -ti :$p -sTCP:LISTEN 2>/dev/null); [ -n "$pid" ] && kill $pid; done
  sleep 4
  pkill -f "user-data-dir=$ROOT/backend/data/browser-profile" >/dev/null 2>&1; sleep 2
}
restart_app() {
  stop_app; open "$APP"
  for i in $(seq 1 75); do up && { say "app up: $(tiers)"; return 0; }; sleep 4; done
  say "app did not come back"; return 1
}
ensure_app() { up && return 0; say "app not answering; relaunching"; restart_app; }
set_config() {
  python3 - "$1" "$2" "$ROOT/config.json" <<'PY'
import json,sys
p=sys.argv[3]; c=json.load(open(p))
c.setdefault('mail',{})['provider']=sys.argv[1]; c['profile']['voice']['enabled']=(sys.argv[2]=='on')
json.dump(c,open(p,'w'),indent=2); open(p,'a').write('\n')
PY
}
done_count() { node -e "
const fs=require('fs');const rows=fs.existsSync('$OUT')?fs.readFileSync('$OUT','utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)):[];
process.stdout.write(String(rows.filter(r=>r.pass==='$PASS'&&r.task==='$1').length));"; }
run_task() {
  local task=$1 want=$2
  local have=$(done_count "$task")
  if [ "$have" -ge "$want" ]; then say "skip $task ($have rows)"; return 0; fi
  ensure_app || return
  say "run $task"
  EVAL_PASS=$PASS node tools/eval-run.js --task "$task" --system "$SYSTEM" --arm "$ARM" --mailbox "$MAILBOX" --contact "$CONTACT" --tag "$PASS" --no-prompt 2>&1 | /usr/bin/grep -E "^\[eval\]" | cut -c1-220 | tail -n 5
  node tools/eval-reset.js task >/dev/null 2>&1
}
STATE=$E/pass-$PASS.state
if [ -f "$STATE" ]; then say "resuming"; else date -u +%FT%T.000Z > "$STATE"; say "pass begins"; fi
osascript -e 'set volume output muted true' >/dev/null 2>&1
set_config "$PROVIDER" off
# The seeded messages are sent again before the pass, with the app closed,
# so each is the newest message on its subject ahead of what earlier runs
# sent; nothing is removed from the mailbox.
stop_app
node "$MAILTOOL" reseed "$PROVIDER" 2>&1 | /usr/bin/grep -E "sent from|RESEEDED|SIGNED_OUT|ERR" | tail -n 6
if [ "$(tr -d '[:space:]' < $M/eval-arm.state 2>/dev/null)" != "$ARM" ] || [ ! -f "$E/pass-$PASS.armed" ]; then
  cp -R "$M/skills-shipped" skills.next && rm -rf skills && mv skills.next skills && say "catalogue restored: $(ls skills | wc -l | tr -d ' ') skills"
  node tools/eval-reset.js arm >/dev/null 2>&1 && say "state reset (traces, recipes)"
  node tools/eval-arm.js "$ARM" >/dev/null && restart_app || exit 1
  touch "$E/pass-$PASS.armed"
else
  restart_app || exit 1
fi
say "mailbox $MAILBOX, provider $PROVIDER, arm $ARM, system $SYSTEM: $(tiers)"
if [ "$SYSTEM" = openclaw ]; then
  export EVAL_OPENCLAW_CMD="openclaw agent --agent main --message {TEXT} --timeout 180" EVAL_TIMEOUT_MS=200000
  case $ARM in P) set_openclaw_model mlx-community/Qwen3-4B-Instruct-2507-4bit ;; *) set_openclaw_model mlx-community/gemma-4-E4B-it-qat-4bit ;; esac
  baseline_ready || exit 1
fi
REPEATS=$(node -e "process.stdout.write(require('$E/suite.json').repeat.join(' '))")
TASKS=$(node -e "const s=require('$E/suite.json');process.stdout.write(s.tasks.filter(t=>'$MAILONLY'?t.mail:true).map(t=>t.id).join(' '))")
order() { for b in D M C S K G; do for t in ${=TASKS}; do [ "${t[1,1]}" = "$b" ] && echo $t; done; done; }
for task in $(order); do
  [ "${task[1,1]}" = G ] && [ -z "${WEB_READ:-}" ] && { node "$WEBTRUTH" >/dev/null 2>&1 && say "web facts read"; WEB_READ=1; }
  run_task "$task" 1
done
# The repeat-cost block: each listed task three times in a row, after the
# blocks, so the trajectory starts from a task the system has seen once.
for task in ${=REPEATS}; do
  case " $TASKS " in *" $task "*) ;; *) continue ;; esac
  for n in 2 3 4; do run_task "$task" $n; done
done
[ -n "${WEB_READ:-}" ] && node "$WEBTRUTH" >/dev/null 2>&1 && say "web facts read again"
say "pass done"
