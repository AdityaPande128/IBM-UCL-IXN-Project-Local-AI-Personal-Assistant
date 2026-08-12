"""Fetch one model into the hub cache, narrating progress as JSON lines.

The daemon spawns this per model and reads stdout: {"total": n} once the
size is known, {"received": n, "total": n} while bytes arrive, and a final
{"done": true} on success. Progress is read from the cache directory itself
rather than hooked into the hub client, so it keeps working across hub
versions; xet is disabled upstream so partial files land where they can be
counted. A killed download resumes on the next run — the hub client skips
completed blobs.
"""

import json
import os
import sys
import threading


def repo_dir(model_id):
    if os.environ.get("HF_HUB_CACHE"):
        hub = os.environ["HF_HUB_CACHE"]
    elif os.environ.get("HF_HOME"):
        hub = os.path.join(os.environ["HF_HOME"], "hub")
    else:
        hub = os.path.join(os.path.expanduser("~"), ".cache", "huggingface", "hub")
    return os.path.join(hub, "models--" + model_id.replace("/", "--"))


def dir_bytes(root):
    total = 0
    for base, _dirs, files in os.walk(root):
        for name in files:
            try:
                full = os.path.join(base, name)
                if not os.path.islink(full):
                    total += os.path.getsize(full)
            except OSError:
                pass
    return total


def main():
    if len(sys.argv) != 2:
        print(json.dumps({"error": "usage: download.py <model_id>"}), flush=True)
        return 2
    model_id = sys.argv[1]

    from huggingface_hub import HfApi, snapshot_download

    try:
        info = HfApi().model_info(model_id, files_metadata=True)
        total = sum(f.size or 0 for f in info.siblings or [])
    except Exception as err:
        print(json.dumps({"error": f"could not reach the hub: {err}"}), flush=True)
        return 1
    print(json.dumps({"total": total}), flush=True)

    failure = []

    def work():
        try:
            snapshot_download(model_id)
        except Exception as err:
            failure.append(str(err))

    worker = threading.Thread(target=work, daemon=True)
    worker.start()
    while worker.is_alive():
        print(json.dumps({"received": dir_bytes(repo_dir(model_id)), "total": total}),
              flush=True)
        worker.join(1.0)

    if failure:
        print(json.dumps({"error": failure[0]}), flush=True)
        print(failure[0], file=sys.stderr)
        return 1
    print(json.dumps({"received": total, "total": total, "done": True}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
