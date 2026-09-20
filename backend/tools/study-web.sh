#!/bin/zsh
# Browser bench on the A2 shortlist plus the small-router survivor, K=2.
set -u
cd "$(dirname "$0")/.." || exit 1
for m in mlx-community/gemma-4-E4B-it-qat-4bit mlx-community/Qwen3.5-4B-MLX-8bit mlx-community/Qwen3.5-4B-MLX-4bit mlx-community/Qwen3-4B-Instruct-2507-4bit mlx-community/gemma-4-E2B-it-qat-4bit; do
  echo "run $(date '+%T') $m web"
  node tools/web-bench.js --model "$m" --repeat 2 --tag k2 || echo "FAILED $m web"
done
echo "web done $(date '+%F %T')"
