#!/usr/bin/env python3
"""Fits a LoRA adapter for the guard on its own verified traces.

    python3 backend/tools/lora-tune.py            # dry run: check data, print the command
    python3 backend/tools/lora-tune.py --train    # actually fit the adapter

Hyperparameters come from config.json under models.lora; the model is the
guard tier's. Adoption is gated, not automatic: after training, point
models.tiers.guard.adapter at the adapter directory, restart the inference
server, and run node backend/tools/router-bench.js — the adapter stays only
if it beats the plain guard, and the config line is deleted if it does not.
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CONFIG_PATH = os.path.join(ROOT, "config.json")

MIN_EXAMPLES = 50


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def count_examples(data_dir, name):
    target = os.path.join(data_dir, name)
    if not os.path.exists(target):
        return None
    count = 0
    with open(target, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            record = json.loads(line)
            messages = record.get("messages")
            if not isinstance(messages, list) or len(messages) < 3:
                raise ValueError(f"{name}: a record does not carry a chat triple")
            json.loads(messages[-1]["content"])  # the target must itself be JSON
            count += 1
    return count


def main():
    config = load_config()
    models = config.get("models") or {}
    lora = models.get("lora") or {}

    guard = ((models.get("tiers") or {}).get("guard") or {}).get("model") \
        or (config.get("router") or {}).get("model")
    if not guard:
        print("no guard model is configured; nothing to tune", file=sys.stderr)
        sys.exit(2)

    data_dir = os.environ.get("JARVIS_LORA_DATA") \
        or os.path.join(ROOT, "backend", "data", "lora")
    adapter_dir = lora.get("adapter_dir") or os.path.join(data_dir, "adapter")

    try:
        train = count_examples(data_dir, "train.jsonl")
        valid = count_examples(data_dir, "valid.jsonl")
    except ValueError as err:
        print(f"the training data is malformed: {err}", file=sys.stderr)
        sys.exit(1)
    if train is None or valid is None:
        print("no exported data found — run node backend/tools/export-lora-traces.js first",
              file=sys.stderr)
        sys.exit(1)
    if train + valid < int(lora.get("min_examples", MIN_EXAMPLES)):
        print(f"only {train + valid} example(s) exported; tuning on fewer than "
              f"{lora.get('min_examples', MIN_EXAMPLES)} would memorise, not learn. "
              f"Let more verified traces accumulate.", file=sys.stderr)
        sys.exit(1)

    argv = [
        sys.executable, "-m", "mlx_lm", "lora",
        "--model", guard,
        "--train",
        "--data", data_dir,
        "--adapter-path", adapter_dir,
        "--iters", str(lora.get("iters", 200)),
        "--batch-size", str(lora.get("batch_size", 2)),
        "--num-layers", str(lora.get("num_layers", 8)),
        "--learning-rate", str(lora.get("learning_rate", 1e-5)),
    ]

    print(f"data: {train} train / {valid} valid example(s) in {data_dir}")
    print(f"guard: {guard}")
    print(f"adapter: {adapter_dir}")
    print("command: " + " ".join(argv))

    if "--train" not in sys.argv:
        print("\ndry run only — pass --train to fit the adapter")
        return

    result = subprocess.run(argv)
    if result.returncode != 0:
        sys.exit(result.returncode)
    print(f"\nadapter written to {adapter_dir}")
    print("gate it before adopting: set models.tiers.guard.adapter to that path, "
          "restart the inference server, run node backend/tools/router-bench.js, "
          "and remove the line unless the tuned guard wins.")


if __name__ == "__main__":
    main()
