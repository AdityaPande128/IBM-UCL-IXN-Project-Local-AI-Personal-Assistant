import unittest

import prefixcache
from prefixcache import PrefixCache


class FakeLayer:
    def __init__(self):
        self.offset = 0


class Fakes:
    """Stand-ins for the mlx cache primitives, with the same trim semantics."""

    def __init__(self):
        self.trims = []
        self.trimmable = True

    def make(self, model):
        return [FakeLayer(), FakeLayer()]

    def trim(self, cache, count):
        self.trims.append(count)
        for layer in cache:
            layer.offset = max(0, layer.offset - count)

    def can_trim(self, cache):
        return self.trimmable


def fill(cache, count):
    """What generate() does to the cache: every layer's offset grows."""
    for layer in cache:
        layer.offset += count


class PrefixCacheTest(unittest.TestCase):
    def setUp(self):
        self.fakes = Fakes()
        prefixcache.make_prompt_cache = self.fakes.make
        prefixcache.trim_prompt_cache = self.fakes.trim
        prefixcache.can_trim_prompt_cache = self.fakes.can_trim
        self.model = object()

    def run_call(self, pc, tokens, generated=4):
        cache, feed, reused = pc.begin("m", self.model, tokens)
        self.assertIsNotNone(cache)
        fill(cache, len(feed) + generated)
        pc.end("m", tokens)
        return feed, reused

    def test_cold_call_feeds_everything_and_keeps_the_prompt(self):
        pc = PrefixCache(min_prefix=4, log=lambda *_: None)
        prompt = list(range(100))

        feed, reused = self.run_call(pc, prompt, generated=7)

        self.assertEqual(feed, prompt)
        self.assertEqual(reused, 0)
        # end() trimmed the 7 generated tokens off; the prompt's KV stays
        self.assertEqual(pc.tokens, prompt)
        self.assertEqual(pc.cache[0].offset, 100)

    def test_a_shared_prefix_is_not_prefilled_twice(self):
        pc = PrefixCache(min_prefix=4, log=lambda *_: None)
        system = list(range(80))
        self.run_call(pc, system + [200, 201])

        feed, reused = self.run_call(pc, system + [300, 301, 302])

        self.assertEqual(reused, 80)
        self.assertEqual(feed, [300, 301, 302])
        self.assertEqual(pc.hits, 1)

    def test_the_identical_prompt_still_feeds_one_token(self):
        pc = PrefixCache(min_prefix=4, log=lambda *_: None)
        prompt = list(range(50))
        self.run_call(pc, prompt)

        feed, reused = self.run_call(pc, prompt)

        self.assertEqual(reused, 49)
        self.assertEqual(feed, [49])

    def test_an_early_divergence_runs_cold(self):
        pc = PrefixCache(min_prefix=32, log=lambda *_: None)
        self.run_call(pc, list(range(64)))
        before = pc.misses

        feed, reused = self.run_call(pc, [999] + list(range(63)))

        self.assertEqual(reused, 0)
        self.assertEqual(len(feed), 64)
        self.assertEqual(pc.misses, before + 1)
        self.assertEqual(pc.hits, 0)

    def test_a_different_model_never_sees_the_old_cache(self):
        pc = PrefixCache(min_prefix=4, log=lambda *_: None)
        prompt = list(range(50))
        self.run_call(pc, prompt)

        cache, feed, reused = pc.begin("other", object(), prompt)

        self.assertEqual(reused, 0)
        self.assertEqual(feed, prompt)

    def test_the_cache_is_capped_at_max_tokens(self):
        pc = PrefixCache(max_tokens=32, min_prefix=4, log=lambda *_: None)
        prompt = list(range(100))
        self.run_call(pc, prompt)

        self.assertEqual(len(pc.tokens), 32)
        self.assertEqual(pc.cache[0].offset, 32)

    def test_zero_max_tokens_disables_the_cache_entirely(self):
        pc = PrefixCache(max_tokens=0, log=lambda *_: None)
        cache, feed, reused = pc.begin("m", self.model, list(range(50)))

        self.assertIsNone(cache)
        self.assertEqual(reused, 0)

    def test_an_untrimmable_cache_runs_cold_instead_of_wrong(self):
        pc = PrefixCache(min_prefix=4, log=lambda *_: None)
        prompt = list(range(50))
        self.run_call(pc, prompt)

        self.fakes.trimmable = False
        cache, feed, reused = pc.begin("m", self.model, prompt + [1])

        self.assertEqual(reused, 0)
        self.assertEqual(len(feed), 51)

    def test_a_trim_error_fails_open(self):
        pc = PrefixCache(min_prefix=4, log=lambda *_: None)
        prompt = list(range(50))
        self.run_call(pc, prompt)

        def broken(cache, count):
            raise RuntimeError("metal said no")
        prefixcache.trim_prompt_cache = broken

        cache, feed, reused = pc.begin("m", self.model, prompt + [1])

        self.assertIsNone(cache)
        self.assertEqual(reused, 0)
        self.assertEqual(len(feed), 51)
        self.assertIsNone(pc.cache)

    def test_a_short_cache_is_dropped_rather_than_trusted(self):
        pc = PrefixCache(min_prefix=4, log=lambda *_: None)
        prompt = list(range(50))
        cache, feed, reused = pc.begin("m", self.model, prompt)
        fill(cache, 10)  # generation died early: cache holds less than the prompt

        pc.end("m", prompt)

        self.assertIsNone(pc.cache)


if __name__ == "__main__":
    unittest.main()
