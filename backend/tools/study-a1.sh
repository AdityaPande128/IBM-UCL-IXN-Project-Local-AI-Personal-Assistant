#!/bin/zsh
# Stage A1 screening, exactly as pre-registered: every router candidate ×
# {v0, v2, v3} × {free, json}, two-stage, dev split, one repeat. Strictly
# sequential; resumable (a configuration whose run file already ends with a
# footer is skipped). Run on an idle machine with the inference server up:
#   nohup backend/tools/study-a1.sh > docs/measurements/router-study/a1.log 2>&1 &
set -u
cd "$(dirname "$0")/.." || exit 1
STUDY="$(pwd)/../docs/measurements/router-study"
MODELS=(
  mlx-community/Qwen3-4B-Instruct-2507-4bit
  mlx-community/Qwen3-4B-Instruct-2507-8bit
  mlx-community/Qwen3.5-4B-MLX-4bit
  mlx-community/Qwen3.5-4B-MLX-8bit
  mlx-community/Qwen3.5-9B-MLX-4bit
  mlx-community/Qwen3.5-2B-MLX-4bit
  mlx-community/gemma-4-E4B-it-qat-4bit
  mlx-community/granite-4.1-8b-4bit
  lmstudio-community/granite-4.2-3b-MLX-4bit
  lmstudio-community/granite-4.2-8b-MLX-4bit
)
[ -f "$HOME/.cache/jarvis-models/Nemotron-3-Nano-4B-4bit/config.json" ] && MODELS+=("$HOME/.cache/jarvis-models/Nemotron-3-Nano-4B-4bit")
# A1_MODELS="id id ..." runs the same grid over a different pool (the small-router screen).
[ -n "${A1_MODELS:-}" ] && MODELS=(${=A1_MODELS})
[ "${A1_WITH_LFM:-0}" = "1" ] && MODELS+=(mlx-community/LFM2.5-2.6B-4bit)

slug() { echo "${1##*/}" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g'; }

STARTED_INFERENCE=""
if [ -z "$(lsof -ti :8787 -sTCP:LISTEN 2>/dev/null)" ]; then
  ( cd inference && nohup python3 server.py > "$STUDY/a1-inference.log" 2>&1 & echo $! > "$STUDY/.a1-inference.pid" )
  STARTED_INFERENCE=$(cat "$STUDY/.a1-inference.pid")
  echo "started inference server (pid $STARTED_INFERENCE)"
  for i in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 2; done
fi
curl -s -m 5 http://127.0.0.1:8787/health >/dev/null 2>&1 || { echo "inference server not reachable; aborting"; exit 1; }

echo "A1 start $(date '+%F %T') loadavg $(sysctl -n vm.loadavg)"
for model in "${MODELS[@]}"; do
  for prompt in v0 v2 v3; do
    for decoding in free json; do
      f="$STUDY/runs/$(slug "$model")__${prompt}__${decoding}__two__dev.jsonl"
      if [ -f "$f" ] && tail -1 "$f" | grep -q '"kind":"footer"'; then
        echo "skip  $model $prompt $decoding (done)"; continue
      fi
      echo "run   $(date '+%T') $model $prompt $decoding"
      node tools/router-bench.js --model "$model" --prompt "$prompt" --decoding "$decoding" --stage two --split dev --repeat 1 --warm 2 \
        || echo "FAILED $model $prompt $decoding"
    done
  done
done
echo "A1 end $(date '+%F %T')"
if [ -n "$STARTED_INFERENCE" ]; then kill "$STARTED_INFERENCE" 2>/dev/null; rm -f "$STUDY/.a1-inference.pid"; echo "stopped the inference server this run started"; fi
node tools/eval-analyze.js --split dev --out "$STUDY/../model-study-dev.md" > /dev/null && echo "dev analysis written: docs/measurements/model-study-dev.md"
