"""Grammar and processor tests: a fake tokenizer and hand-built logits, no
models load.

    python3 -m unittest discover backend/inference
"""

import json
import unittest

import mlx.core as mx
import numpy as np

from constrain import JsonScanner, JsonConstraint


def scan(text):
    scanner = JsonScanner()
    return scanner.feed(text), scanner


class ScannerPrefixes(unittest.TestCase):
    def test_valid_prefixes_are_accepted(self):
        for prefix in [
            "{", '{"', '{"a', '{"a"', '{"a":', '{"a": ', '{"a": 12.',
            '{"a": [1, {"b": tr', '{"a": "he\\', '{"a": "\\u00e', '{ }',
            '  {"a": null, "b": [true, false]', '{"a": -0.5e+',
            '{"query": "from:philip", "act": "read"',
        ]:
            ok, _ = scan(prefix)
            self.assertTrue(ok, f"rejected valid prefix: {prefix!r}")

    def test_invalid_text_is_rejected(self):
        for bad in [
            "x", "Sure, here", "[1, 2]", '"top-level string"',
            "{,", '{"a" 1', '{"a":: 1', "{]", '{"a": 01', '{"a": -.5',
            '{"a": tru0', '{"a": "\\x', '{"a": 1,}', '{"a": 1 2',
            "```json", '{"a": .5', '{"a": +1', '{}}',
        ]:
            ok, _ = scan(bad)
            self.assertFalse(ok, f"accepted invalid text: {bad!r}")

    def test_control_characters_must_be_escaped_inside_strings(self):
        ok, _ = scan('{"a": "line\none"')
        self.assertFalse(ok)
        ok, _ = scan('{"a": "line\\none"')
        self.assertTrue(ok)

    def test_numbers_must_be_complete_before_a_delimiter(self):
        for bad in ['{"n": 1.}', '{"n": 1e}', '{"n": 1e+}', '{"n": -}']:
            ok, _ = scan(bad)
            self.assertFalse(ok, f"accepted incomplete number in: {bad!r}")
        for good in ['{"n": 1}', '{"n": 1.5}', '{"n": 1e+2}', '{"n": 0}',
                     '{"n": -0.5e10}']:
            ok, scanner = scan(good)
            self.assertTrue(ok, f"rejected valid number in: {good!r}")
            self.assertTrue(scanner.done)

    def test_done_admits_trailing_whitespace_and_nothing_else(self):
        ok, scanner = scan('{"a": 1}')
        self.assertTrue(ok)
        self.assertTrue(scanner.done)
        self.assertTrue(scanner.advance("\n"))
        self.assertTrue(scanner.done)
        self.assertFalse(scanner.advance("x"))

    def test_nested_structures_close_in_order(self):
        ok, scanner = scan('{"a": {"b": [1, [2, {"c": "d"}]]}}')
        self.assertTrue(ok)
        self.assertTrue(scanner.done)
        ok, _ = scan('{"a": [1}')
        self.assertFalse(ok)

    def test_empty_object_and_empty_array_values(self):
        for good in ["{}", '{"a": {}}', '{"a": []}']:
            ok, scanner = scan(good)
            self.assertTrue(ok, f"rejected: {good!r}")
            self.assertTrue(scanner.done)

    def test_copy_is_independent(self):
        _, scanner = scan('{"a": ')
        probe = scanner.copy()
        self.assertTrue(probe.feed('1}'))
        self.assertTrue(probe.done)
        self.assertFalse(scanner.done)
        self.assertTrue(scanner.feed('"still open'))


class FakeTokenizer:
    """decode() joins string pieces; the eos piece renders as nothing."""

    def __init__(self, vocab, eos_id=0):
        self.vocab = vocab
        self.eos_token_id = eos_id
        self.eos_token_ids = {eos_id}

    def decode(self, ids):
        return "".join(self.vocab[i] if i != self.eos_token_id else ""
                       for i in ids)


VOCAB = [
    "</s>",            # 0 eos
    "{",               # 1
    "}",               # 2
    '"act"',           # 3
    ":",               # 4
    ' "read"',         # 5
    "Sure",            # 6
    ", here is",       # 7
    '{"',              # 8
    "act",             # 9
    '":',              # 10
    " ",               # 11
]

PROMPT = [6, 7, 6]


def logits_for(preferred, size=None):
    scores = np.full((1, size or len(VOCAB)), -10.0, dtype=np.float32)
    for rank, token in enumerate(preferred):
        scores[0, token] = 5.0 - rank
    return mx.array(scores)


def step(constraint, generated, preferred, size=None):
    if constraint.prompt_len is None:
        constraint.prompt_len = len(PROMPT)
    tokens = mx.array(PROMPT + generated)
    out = constraint(tokens, logits_for(preferred, size))
    return int(np.array(out.reshape(-1)).argmax())


class ProcessorBehaviour(unittest.TestCase):
    def test_prose_opening_is_masked_to_a_grammar_token(self):
        constraint = JsonConstraint(FakeTokenizer(VOCAB))
        picked = step(constraint, [], preferred=[6, 7, 1])
        self.assertEqual(picked, 1, "the mask should leave '{' as the best token")

    def test_legal_argmax_passes_logits_through_untouched(self):
        constraint = JsonConstraint(FakeTokenizer(VOCAB))
        base = logits_for([8, 6])
        out = constraint(mx.array(PROMPT), base)
        self.assertTrue(np.array_equal(np.array(base), np.array(out)))

    def test_eos_is_illegal_while_the_object_is_open(self):
        constraint = JsonConstraint(FakeTokenizer(VOCAB))
        picked = step(constraint, [1], preferred=[0, 3])
        self.assertEqual(picked, 3)

    def test_a_closed_object_forces_eos(self):
        constraint = JsonConstraint(FakeTokenizer(VOCAB))
        picked = step(constraint, [8, 9, 10, 5, 2], preferred=[6, 7, 1])
        self.assertEqual(picked, 0)

    def test_greedy_generation_lands_on_parseable_json(self):
        vocab = ["</s>", "Sure", " thing", "{", '"a"', ":", '"b"', "}"]
        tokenizer = FakeTokenizer(vocab)
        constraint = JsonConstraint(tokenizer)
        generated = []
        prose_first = [1, 2, 6, 4, 5, 7, 3, 0]
        for _ in range(16):
            picked = step(constraint, generated, preferred=prose_first, size=len(vocab))
            if picked == tokenizer.eos_token_id:
                break
            generated.append(picked)
        else:
            self.fail("generation never reached EOS")
        parsed = json.loads(tokenizer.decode(generated))
        self.assertEqual(parsed, {"b": "b"})

    def test_decode_failure_latches_open_and_stays_open(self):
        class Exploding(FakeTokenizer):
            def decode(self, ids):
                raise RuntimeError("boom")

        constraint = JsonConstraint(Exploding(VOCAB), log=lambda msg: None)
        base = logits_for([6])
        out = constraint(mx.array(PROMPT + [6]), base)
        self.assertTrue(np.array_equal(np.array(base), np.array(out)))
        self.assertTrue(constraint.broken)
        out = constraint(mx.array(PROMPT + [6, 6]), base)
        self.assertTrue(np.array_equal(np.array(base), np.array(out)))

    def test_text_already_off_grammar_disables_the_constraint(self):
        constraint = JsonConstraint(FakeTokenizer(VOCAB), log=lambda msg: None)
        constraint.prompt_len = len(PROMPT)
        base = logits_for([1])
        out = constraint(mx.array(PROMPT + [6]), base)
        self.assertTrue(constraint.broken)
        self.assertTrue(np.array_equal(np.array(base), np.array(out)))

    def test_lookahead_call_after_eos_does_not_disable(self):
        # mlx_lm runs one step ahead: the processor is called once more
        # after EOS was sampled, and a real tokenizer decodes that EOS as
        # literal text ("<|im_end|>"), which is off-grammar.
        class LiteralEos(FakeTokenizer):
            def decode(self, ids):
                return "".join("<|im_end|>" if i == self.eos_token_id
                               else self.vocab[i] for i in ids)

        constraint = JsonConstraint(LiteralEos(VOCAB), log=lambda msg: None)
        constraint.prompt_len = len(PROMPT)
        closed = [8, 9, 10, 5, 2, 0]
        out = constraint(mx.array(PROMPT + closed), logits_for([6]))
        self.assertFalse(constraint.broken)
        picked = int(np.asarray(out.astype(mx.float32).reshape(-1)).argmax())
        self.assertEqual(picked, 0, "a closed object still forces eos")

    def test_bfloat16_logits_keep_the_constraint_engaged(self):
        # The live models hand bfloat16 logits, which numpy's buffer
        # protocol rejects; the mask must still engage, not latch open.
        constraint = JsonConstraint(FakeTokenizer(VOCAB), log=lambda msg: None)
        out = constraint(mx.array(PROMPT), logits_for([6, 7, 1]).astype(mx.bfloat16))
        self.assertFalse(constraint.broken)
        picked = int(np.asarray(out.astype(mx.float32).reshape(-1)).argmax())
        self.assertEqual(picked, 1)

    def test_no_legal_candidate_anywhere_fails_open(self):
        prose_only = ["</s>", "Sure", " thing", " boss"]
        constraint = JsonConstraint(FakeTokenizer(prose_only), log=lambda msg: None)
        base = logits_for([1, 2, 3])
        out = constraint(mx.array(PROMPT), base)
        self.assertTrue(constraint.broken)
        self.assertTrue(np.array_equal(np.array(base), np.array(out)))


if __name__ == "__main__":
    unittest.main()
