#!/bin/zsh
# Latency block: a fixed 20-item test subset (one per stratum by prompt hash,
# filled to 20 by global hash order), the four shortlisted routers at their
# best A2 prompt, three rotating rounds so drift falls on every configuration
# alike. Run once hot (straight after sustained inference) and once cold
# (after a 20-minute idle); the phase name goes into the tag.
#   study-latency.sh hot|cold
set -u
cd "$(dirname "$0")/.." || exit 1
PHASE=${1:?hot|cold}
IDS=S1-17,S2-19,S3-25,S4-13,S5-08,S6-02,S7-01,S8-16,S9-07,S10-08,S11-06,S12-08,S13-09,S8-19,S8-03,S8-12,S5-09,S8-04,S8-10,S5-11
for r in 1 2 3; do
  for spec in mlx-community/gemma-4-E4B-it-qat-4bit:v3 mlx-community/Qwen3.5-4B-MLX-8bit:v0 mlx-community/Qwen3.5-4B-MLX-4bit:v0 mlx-community/Qwen3-4B-Instruct-2507-4bit:v0; do
    m=${spec%%:*}; p=${spec##*:}
    echo "run $(date '+%T') $PHASE r$r $m"
    node tools/router-bench.js --model "$m" --prompt "$p" --decoding free --stage two --split test --ids "$IDS" --repeat 1 --warm 1 --tag "latency-$PHASE-r$r" || echo "FAILED $m $PHASE r$r"
  done
done
echo "latency $PHASE done $(date '+%F %T') loadavg $(sysctl -n vm.loadavg)"
