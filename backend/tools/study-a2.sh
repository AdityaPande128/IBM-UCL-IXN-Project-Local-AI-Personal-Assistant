#!/bin/zsh
# Stage A2 confirmation, exactly as pre-registered: shortlisted models ×
# {v0, v1, v2, v3} × {free, json}, two-stage, test split, K=2 repeats; plus
# single-stage at each model's best A1 prompt with free decoding. Strictly
# sequential; resumable. Run from anywhere; paths are self-anchored.
set -u
cd "$(dirname "$0")/.." || exit 1
STUDY="$(pwd)/../docs/measurements/router-study"
MODELS=(
  mlx-community/Qwen3.5-4B-MLX-8bit
  mlx-community/Qwen3.5-4B-MLX-4bit
  mlx-community/gemma-4-E4B-it-qat-4bit
  mlx-community/Qwen3-4B-Instruct-2507-4bit
)
# best A1 prompt per model, same order, for the single-stage runs
BEST=(v0 v0 v2 v0)

slug() { echo "${1##*/}" | tr 'A-Z' 'a-z' | sed -E 's/[^a-z0-9]+/-/g'; }

STARTED_INFERENCE=""
if [ -z "$(lsof -ti :8787 -sTCP:LISTEN 2>/dev/null)" ]; then
  ( cd inference && nohup python3 server.py > "$STUDY/a2-inference.log" 2>&1 & echo $! > "$STUDY/.a2-inference.pid" )
  STARTED_INFERENCE=$(cat "$STUDY/.a2-inference.pid")
  echo "started inference server (pid $STARTED_INFERENCE)"
  for i in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 2; done
fi
curl -s -m 5 http://127.0.0.1:8787/health >/dev/null 2>&1 || { echo "inference server not reachable; aborting"; exit 1; }

run_cfg() {
  local model=$1 prompt=$2 decoding=$3 stage=$4
  local f="$STUDY/runs/$(slug "$model")__${prompt}__${decoding}__${stage}__test.jsonl"
  if [ -f "$f" ] && tail -1 "$f" | grep -q '"kind":"footer"'; then
    echo "skip  $model $prompt $decoding $stage (done)"; return
  fi
  echo "run   $(date '+%T') $model $prompt $decoding $stage"
  node tools/router-bench.js --model "$model" --prompt "$prompt" --decoding "$decoding" \
    --stage "$stage" --split test --repeat 2 --warm 2 \
    || echo "FAILED $model $prompt $decoding $stage"
}

echo "A2 start $(date '+%F %T') loadavg $(sysctl -n vm.loadavg)"
i=1
for model in "${MODELS[@]}"; do
  for prompt in v0 v1 v2 v3; do
    for decoding in free json; do
      run_cfg "$model" "$prompt" "$decoding" two
    done
  done
  run_cfg "$model" "${BEST[$i]}" free single
  i=$((i+1))
done
echo "A2 end $(date '+%F %T')"
if [ -n "$STARTED_INFERENCE" ]; then kill $(lsof -ti :8787 -sTCP:LISTEN) 2>/dev/null; rm -f "$STUDY/.a2-inference.pid"; echo "stopped the inference server this run started"; fi
