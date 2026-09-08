"""Admission control for the models sharing one memory budget.

Policies: pinned is never evicted, resident stays while it fits, transient
goes as soon as anything needs the room. A model in use is never evicted.
"""

import gc
import os
import threading
import time
from contextlib import contextmanager

GB = 1024 ** 3

POLICIES = ("pinned", "resident", "transient")

_EVICTION_ORDER = {"transient": 0, "resident": 1}


class ResidencyError(RuntimeError):
    """A model cannot be made resident within the budget."""


class Slot:
    __slots__ = ("model_id", "policy", "model", "tokenizer",
                 "size", "last_used", "refcount", "loads")

    def __init__(self, model_id, policy):
        self.model_id = model_id
        self.policy = policy if policy in POLICIES else "transient"
        self.model = None
        self.tokenizer = None
        self.size = 0
        self.last_used = 0.0
        self.refcount = 0
        self.loads = 0

    @property
    def loaded(self):
        return self.model is not None

    @property
    def evictable(self):
        return self.loaded and self.policy != "pinned" and self.refcount == 0


class ResidencyManager:
    """Admission control over a fixed memory budget; thread-safe."""

    def __init__(self, budget_bytes, tiers, loader, known_sizes=None, log=print):
        """tiers: {tier: {model, policy}}; loader: model_id -> (model, tokenizer)."""
        self._budget = int(budget_bytes)
        self._loader = loader
        self._log = log
        self._lock = threading.RLock()
        self._slots = {}
        self._tiers = {}
        self._known = dict(known_sizes or {})

        for tier, spec in (tiers or {}).items():
            model_id = spec.get("model")
            if not model_id:
                continue
            self._tiers[tier] = model_id
            self._slots.setdefault(model_id, Slot(model_id, spec.get("policy", "transient")))

    def resolve(self, name):
        """Map a tier name, bare model name, or full model id to a model id."""
        if not name:
            return self.default_model_id
        if name in self._tiers:
            return self._tiers[name]
        if name in self._slots:
            return name
        for model_id in self._slots:
            if model_id.split("/")[-1] == name:
                return model_id
        return name

    def tier_of(self, model_id):
        for tier, mid in self._tiers.items():
            if mid == model_id:
                return tier
        return None

    @property
    def default_model_id(self):
        for tier in ("engine", "guard"):
            if tier in self._tiers:
                return self._tiers[tier]
        return next(iter(self._tiers.values()), None)

    def _used(self):
        return sum(slot.size for slot in self._slots.values() if slot.loaded)

    def _estimate(self, model_id):
        """Expected size of a load; unmeasured models assume the largest known."""
        if model_id in self._known:
            return self._known[model_id]
        return max([*self._known.values(), 8 * GB])

    def _evict(self, slot):
        self._log(f"[Residency] evicting {slot.model_id.split('/')[-1]} "
                  f"({slot.size / GB:.2f} GB, {slot.policy})")
        slot.model = None
        slot.tokenizer = None
        gc.collect()
        try:
            import mlx.core as mx
            mx.clear_cache()
        except Exception:
            pass

    def _make_room(self, model_id, need):
        """Evict until `need` bytes are available, or explain why we cannot."""
        available = self._budget - self._used()
        if available >= need:
            return

        candidates = [s for s in self._slots.values()
                      if s.evictable and s.model_id != model_id]
        candidates.sort(key=lambda s: (_EVICTION_ORDER.get(s.policy, 0), s.last_used))

        for slot in candidates:
            if available >= need:
                break
            self._evict(slot)
            available += slot.size

        if available < need:
            pinned = sum(s.size for s in self._slots.values()
                         if s.loaded and s.policy == "pinned")
            busy = [s.model_id.split("/")[-1] for s in self._slots.values()
                    if s.loaded and s.refcount > 0]
            raise ResidencyError(
                f"cannot fit {model_id.split('/')[-1]} "
                f"({need / GB:.2f} GB) in a {self._budget / GB:.2f} GB budget: "
                f"{available / GB:.2f} GB free after eviction, "
                f"{pinned / GB:.2f} GB pinned"
                + (f", in use: {', '.join(busy)}" if busy else "")
            )

    def _ensure_loaded(self, slot):
        if slot.loaded:
            return

        self._make_room(slot.model_id, self._estimate(slot.model_id))

        try:
            import mlx.core as mx
            before = mx.get_active_memory()
        except Exception:
            mx, before = None, None

        started = time.time()
        self._log(f"[Residency] loading {slot.model_id} "
                  f"({slot.policy}, {self._used() / GB:.2f}/{self._budget / GB:.2f} GB used)")
        slot.model, slot.tokenizer = self._loader(slot.model_id)

        if mx is not None:
            try:
                mx.eval(slot.model.parameters())
                measured = max(mx.get_active_memory() - before, 0)
                if measured:
                    slot.size = max(measured, self._known.get(slot.model_id, 0))
                    self._known.setdefault(slot.model_id, slot.size)
            except Exception:
                pass
        if not slot.size:
            slot.size = self._estimate(slot.model_id)

        slot.loads += 1
        slot.last_used = time.time()
        self._log(f"[Residency] loaded {slot.model_id.split('/')[-1]} "
                  f"in {time.time() - started:.1f}s "
                  f"({slot.size / GB:.2f} GB, {self._used() / GB:.2f}/{self._budget / GB:.2f} GB used)")

    def _slot_for(self, name):
        model_id = self.resolve(name)
        slot = self._slots.get(model_id)
        if slot is None:
            if not self._on_disk(model_id):
                raise ResidencyError(
                    f"unknown model {model_id!r}: not a configured tier and not present locally; "
                    "models are fetched during setup, never on request")
            slot = Slot(model_id, "transient")
            self._slots[model_id] = slot
        return slot

    def _on_disk(self, model_id):
        if model_id in self._known:
            return True
        if os.path.isabs(model_id):
            return os.path.isfile(os.path.join(model_id, "config.json"))
        if model_id.count("/") != 1:
            return False
        org, name = model_id.split("/")
        hub = os.environ.get("HF_HUB_CACHE") or os.path.join(
            os.environ.get("HF_HOME", os.path.join(os.path.expanduser("~"), ".cache", "huggingface")), "hub")
        return os.path.isdir(os.path.join(hub, f"models--{org}--{name}", "snapshots"))

    def preload(self, name):
        with self._lock:
            self._ensure_loaded(self._slot_for(name))

    @contextmanager
    def use(self, name):
        """Borrow a model for one call; the refcount blocks eviction while it runs."""
        with self._lock:
            slot = self._slot_for(name)
            self._ensure_loaded(slot)
            slot.refcount += 1
            slot.last_used = time.time()
        try:
            yield slot.model, slot.tokenizer
        finally:
            with self._lock:
                slot.refcount = max(0, slot.refcount - 1)
                slot.last_used = time.time()

    def state(self):
        with self._lock:
            return {
                "budget_gb": round(self._budget / GB, 2),
                "used_gb": round(self._used() / GB, 2),
                "free_gb": round((self._budget - self._used()) / GB, 2),
                "tiers": dict(self._tiers),
                "models": [
                    {
                        "id": slot.model_id,
                        "tier": self.tier_of(slot.model_id),
                        "policy": slot.policy,
                        "loaded": slot.loaded,
                        "gb": round(slot.size / GB, 3) if slot.size else None,
                        "in_use": slot.refcount > 0,
                        "loads": slot.loads,
                    }
                    for slot in sorted(self._slots.values(), key=lambda s: s.model_id)
                ],
            }
