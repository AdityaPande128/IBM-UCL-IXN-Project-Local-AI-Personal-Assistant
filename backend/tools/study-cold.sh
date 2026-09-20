#!/bin/zsh
# Cold latency, measured honestly: for each router candidate the server is
# booted with a DIFFERENT model resident, so the candidate is not in memory,
# and one fixed item is routed with no warm-up. The row's latency is load plus
# the two routing calls, which is what a user waits for after the model was
# evicted. One fresh boot per round; the item rotates across rounds so no
# single sentence carries the number. Strictly sequential; config restored.
#   study-cold.sh [rounds]
set -u
cd "$(dirname "$0")/.." || exit 1
S=tools/study-server.sh
ROUNDS=${1:-5}
FOURB=mlx-community/Qwen3-4B-Instruct-2507-4bit
GEMMA=mlx-community/gemma-4-E4B-it-qat-4bit
C14=mlx-community/Qwen2.5-Coder-14B-Instruct-4bit
IDS=(S1-17 S2-19 S3-25 S4-13 S5-08 S6-02 S7-01 S8-16)
say() { echo "[cold] $(date '+%F %T') $*"; }
say "start, $ROUNDS round(s)"
for r in $(seq 1 $ROUNDS); do
  item=${IDS[$(( (r - 1) % ${#IDS[@]} + 1 ))]}
  for spec in $GEMMA:v3 mlx-community/Qwen3.5-4B-MLX-8bit:v0 mlx-community/Qwen3.5-4B-MLX-4bit:v0 $FOURB:v0; do
    m=${spec%%:*}; p=${spec##*:}
    other=$FOURB; [ "$m" = "$FOURB" ] && other=$GEMMA
    zsh $S start default "$other" "$other" "$C14" transient > /dev/null || { say "server failed before $m r$r"; continue; }
    if curl -s -m 5 http://127.0.0.1:8787/residency | /usr/bin/grep -q "${m##*/}"; then say "WARNING ${m##*/} already resident before r$r"; fi
    say "r$r ${m##*/} $p item $item"
    node tools/router-bench.js --model "$m" --prompt "$p" --decoding free --stage two --split test --ids "$item" --repeat 1 --warm 0 --tag "latency-cold-r$r" 2>&1 | /usr/bin/grep -v "^\[" || say "FAILED $m r$r"
  done
done
zsh $S restore
say "done"
