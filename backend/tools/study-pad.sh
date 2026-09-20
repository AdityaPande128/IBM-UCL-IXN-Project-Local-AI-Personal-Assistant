#!/bin/zsh
# Catalogue-size sensitivity: the three routers that survive to the joint
# factorial, on the test split, against the 72- and 144-skill padded catalogues.
set -u
cd "$(dirname "$0")/.." || exit 1
STUDY="$(pwd)/../docs/measurements/router-study"
for size in 72 144; do
  for spec in mlx-community/gemma-4-E4B-it-qat-4bit:v3 mlx-community/Qwen3.5-4B-MLX-8bit:v0 mlx-community/Qwen3-4B-Instruct-2507-4bit:v0; do
    m=${spec%%:*}; p=${spec##*:}
    echo "run $(date '+%T') $m $p pad$size"
    node tools/router-bench.js --model "$m" --prompt "$p" --decoding free --stage two --split test --repeat 1 --warm 2 \
      --catalogue "$STUDY/skills-padded-$size" --tag "pad$size" || echo "FAILED $m pad$size"
  done
done
echo "pad done $(date '+%F %T')"
