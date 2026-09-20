#!/bin/zsh
# Supplement runs: the four A2-shortlisted routers at their best A2 prompt,
# free decoding, two-stage, K=2, on the post-hoc supplement set.
set -u
cd "$(dirname "$0")/.." || exit 1
for spec in mlx-community/gemma-4-E4B-it-qat-4bit:v3 mlx-community/Qwen3.5-4B-MLX-8bit:v0 mlx-community/Qwen3.5-4B-MLX-4bit:v0 mlx-community/Qwen3-4B-Instruct-2507-4bit:v0 mlx-community/gemma-4-E2B-it-qat-4bit:v0; do
  m=${spec%%:*}; p=${spec##*:}
  echo "run $(date '+%T') $m $p supplement"
  node tools/router-bench.js --model "$m" --prompt "$p" --decoding free --stage two --set supplement --repeat 2 --warm 2 || echo "FAILED $m"
done
echo "supplement done $(date '+%F %T')"
