"""Efficiency ladder rung 2: prompt prefix caching.

Every tier's requests open with the same long system prompt, and the KV cache
built for those tokens is identical across calls. This holds one cache — the
most recent model's — and on each request trims it back to the longest shared
token prefix, so the model only prefills what actually changed. Memory is
bounded by max_tokens of KV for one model; correctness never depends on the
cache, because any doubt drops it and the call runs cold.
"""

from mlx_lm.models.cache import (
    can_trim_prompt_cache,
    make_prompt_cache,
    trim_prompt_cache,
)


class PrefixCache:
    def __init__(self, max_tokens=2048, min_prefix=64, log=print):
        self.max_tokens = int(max_tokens)
        self.min_prefix = int(min_prefix)
        self.log = log
        self.key = None
        self.tokens = []
        self.cache = None
        self.hits = 0
        self.misses = 0

    def _drop(self):
        self.key = None
        self.tokens = []
        self.cache = None

    def _reset(self, key, model):
        self.key = key
        self.tokens = []
        self.cache = make_prompt_cache(model)

    def begin(self, key, model, tokens):
        """Prepare for a prompt. Returns (cache, tokens_to_feed, tokens_reused)."""
        if self.max_tokens <= 0:
            return None, tokens, 0
        try:
            if self.key != key or self.cache is None:
                self._reset(key, model)

            limit = min(len(self.tokens), len(tokens) - 1, self.max_tokens)
            shared = 0
            while shared < limit and self.tokens[shared] == tokens[shared]:
                shared += 1

            if shared < self.min_prefix or not can_trim_prompt_cache(self.cache):
                self._reset(key, model)
                self.misses += 1
                return self.cache, tokens, 0

            trim_prompt_cache(self.cache, len(self.tokens) - shared)
            self.tokens = self.tokens[:shared]
            self.hits += 1
            return self.cache, tokens[shared:], shared
        except Exception as err:
            self.log(f"[PrefixCache] cold call after error: {err}")
            self._drop()
            return None, tokens, 0

    def end(self, key, tokens):
        """After generation: trim the generated tail so only the prompt's KV stays."""
        if self.cache is None or self.key != key:
            return
        try:
            offset = self._offset()
            if offset is None or not can_trim_prompt_cache(self.cache):
                self._drop()
                return

            kept = min(len(tokens), self.max_tokens)
            extra = offset - kept
            if extra < 0:
                self._drop()
                return
            if extra > 0:
                trim_prompt_cache(self.cache, extra)
            self.tokens = list(tokens[:kept])
        except Exception as err:
            self.log(f"[PrefixCache] dropped after error: {err}")
            self._drop()

    def _offset(self):
        try:
            return max(layer.offset for layer in self.cache)
        except Exception:
            return None

    def state(self):
        return {
            "cached_tokens": len(self.tokens),
            "hits": self.hits,
            "misses": self.misses,
        }
