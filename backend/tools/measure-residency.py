"""Measure each model's memory cost and swap latency for the residency budget.

  python3 tools/measure-residency.py           # everything
  python3 tools/measure-residency.py voice     # STT, TTS, embeddings
  python3 tools/measure-residency.py llm       # language models

Run with the inference server stopped.
"""
import gc
import json
import os
import sys
import time
import wave

import numpy as np
import mlx.core as mx

GB = 1024 ** 3

INFO = mx.device_info()
WORKING_SET = INFO["max_recommended_working_set_size"]

results = {"device": INFO["device_name"],
           "memory_size_gb": round(INFO["memory_size"] / GB, 2),
           "working_set_gb": round(WORKING_SET / GB, 2),
           "models": []}


def active():
    return mx.get_active_memory()


def drop():
    """Release everything MLX is holding, as the eviction path would."""
    gc.collect()
    mx.clear_cache()


def record(name, kind, load_seconds, delta, note=""):
    row = {"name": name, "kind": kind,
           "load_s": round(load_seconds, 2),
           "gb": round(delta / GB, 3),
           "note": note}
    results["models"].append(row)
    print(f"  {name:52s} {kind:8s} {row['gb']:6.3f} GB  {row['load_s']:6.2f}s  {note}",
          flush=True)
    return row


def measure_llm(model_id, warm_cycles=1):
    """Cold load, then evict and reload to separate disk cost from page-cache cost."""
    from mlx_lm import load, generate

    drop()
    before = active()
    t0 = time.time()
    model, tokenizer = load(model_id)
    mx.eval(model.parameters())
    cold = time.time() - t0
    delta = active() - before

    row = record(model_id, "llm", cold, delta, "cold")

    t0 = time.time()
    generate(model, tokenizer, prompt="Reply with the single word: ready.",
             max_tokens=8, verbose=False)
    row["first_gen_s"] = round(time.time() - t0, 2)
    row["peak_gb"] = round(mx.get_peak_memory() / GB, 3)
    print(f"    first generation {row['first_gen_s']}s, peak {row['peak_gb']} GB", flush=True)

    warm_times = []
    for _ in range(warm_cycles):
        del model, tokenizer
        drop()
        t0 = time.time()
        model, tokenizer = load(model_id)
        mx.eval(model.parameters())
        warm_times.append(time.time() - t0)
    row["warm_s"] = round(min(warm_times), 2)
    print(f"    warm reload after eviction: {row['warm_s']}s", flush=True)

    del model, tokenizer
    drop()
    mx.reset_peak_memory()
    return row


def silence_wav(path, seconds=2.0, rate=16000):
    tone = (np.sin(2 * np.pi * 220 * np.linspace(0, seconds, int(rate * seconds)))
            * 0.2 * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(tone.tobytes())


def measure_stt(model_id):
    import mlx_whisper
    wav = "/tmp/jarvis-spike-probe.wav"
    silence_wav(wav)
    drop()
    before = active()
    t0 = time.time()
    mlx_whisper.transcribe(wav, path_or_hf_repo=model_id, language="en")
    cold = time.time() - t0
    row = record(model_id, "stt", cold, active() - before, "cold incl. first transcribe")

    t0 = time.time()
    mlx_whisper.transcribe(wav, path_or_hf_repo=model_id, language="en")
    row["warm_call_s"] = round(time.time() - t0, 2)
    print(f"    warm transcribe: {row['warm_call_s']}s", flush=True)
    os.unlink(wav)
    return row


def measure_tts(model_id):
    import glob
    import shutil
    import tempfile
    from mlx_audio.tts.generate import generate_audio

    scratch = tempfile.mkdtemp(prefix="jarvis-spike-tts-")
    drop()
    before = active()
    t0 = time.time()
    generate_audio(text="Systems ready.", model=model_id, voice="af_heart",
                   file_prefix=os.path.join(scratch, "p"), audio_format="wav",
                   save=True, verbose=False)
    cold = time.time() - t0
    row = record(model_id, "tts", cold, active() - before, "cold incl. first synth")

    t0 = time.time()
    generate_audio(text="Systems ready.", model=model_id, voice="af_heart",
                   file_prefix=os.path.join(scratch, "q"), audio_format="wav",
                   save=True, verbose=False)
    row["warm_call_s"] = round(time.time() - t0, 2)
    print(f"    warm synth: {row['warm_call_s']}s", flush=True)
    shutil.rmtree(scratch, ignore_errors=True)
    return row


def measure_embed(model_id):
    from mlx_embeddings import load as eload, generate as egen
    drop()
    before = active()
    t0 = time.time()
    model, tok = eload(model_id)
    out = egen(model, tok, texts=["warm up the graph"])
    mx.eval(out.text_embeds)
    cold = time.time() - t0
    row = record(model_id, "embed", cold, active() - before, "cold incl. first embed")

    t0 = time.time()
    out = egen(model, tok, texts=["how long does a single query embedding take"])
    mx.eval(out.text_embeds)
    row["warm_call_s"] = round(time.time() - t0, 3)
    print(f"    warm embed: {row['warm_call_s']}s", flush=True)
    del model, tok
    drop()
    return row


def measure_coresident(model_ids):
    """The question that matters: do these fit together, and what is the peak?"""
    from mlx_lm import load
    print("\n  co-residency check", flush=True)
    drop()
    mx.reset_peak_memory()
    held = []
    base = active()
    for mid in model_ids:
        model, tok = load(mid)
        mx.eval(model.parameters())
        held.append((model, tok))
        print(f"    + {mid.split('/')[-1]:44s} total {(active() - base) / GB:6.3f} GB", flush=True)
    total = active() - base
    results["coresident"] = {
        "models": model_ids,
        "total_gb": round(total / GB, 3),
        "peak_gb": round(mx.get_peak_memory() / GB, 3),
        "working_set_gb": round(WORKING_SET / GB, 2),
        "headroom_gb": round((WORKING_SET - active()) / GB, 3),
    }
    held.clear()
    drop()
    return results["coresident"]


if __name__ == "__main__":
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    print(f"\n  {INFO['device_name']}  RAM {INFO['memory_size'] / GB:.1f} GB  "
          f"Metal working set {WORKING_SET / GB:.2f} GB\n", flush=True)

    if which in ("all", "voice"):
        print("  voice + embed (must be permanently resident)", flush=True)
        measure_embed("mlx-community/bge-small-en-v1.5-4bit")
        measure_stt("mlx-community/whisper-large-v3-turbo")
        measure_tts("mlx-community/Kokoro-82M-bf16")

    if which in ("all", "llm"):
        print("\n  language models", flush=True)
        for mid in ["mlx-community/Llama-3.2-1B-Instruct-4bit",
                    "mlx-community/Qwen3-4B-Instruct-2507-4bit",
                    "mlx-community/granite-4.1-8b-4bit",
                    "mlx-community/Qwen2.5-Coder-14B-Instruct-4bit"]:
            try:
                measure_llm(mid)
            except Exception as e:
                print(f"  {mid}: FAILED {e}", flush=True)

    out = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                       "..", "..", "docs", "measurements", "model-residency.json")
    out = os.path.abspath(out)
    os.makedirs(os.path.dirname(out), exist_ok=True)

    if os.path.exists(out):
        with open(out) as f:
            previous = json.load(f)
        measured = {row["name"] for row in results["models"]}
        results["models"] = ([row for row in previous.get("models", [])
                              if row["name"] not in measured]
                             + results["models"])
        for key in previous:
            results.setdefault(key, previous[key])

    results["models"].sort(key=lambda r: (r["kind"], r["gb"]))
    with open(out, "w") as f:
        json.dump(results, f, indent=2)
    print(f"\n  written to {out}\n", flush=True)
