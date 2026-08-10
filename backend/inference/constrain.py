"""Constrained decoding: a logits processor that keeps generated text a valid
prefix of exactly one JSON object, and hands generation to EOS once it closes.

The scanner is a character-level pushdown automaton over RFC 8259. The
processor rebuilds the scanner from the full decoded generation each step, so
detokenization quirks cannot accumulate; any internal failure latches the
processor open and generation continues unconstrained.

    python3 -m unittest discover backend/inference
"""

WS = " \t\n\r"
DIGITS = "0123456789"
HEX = "0123456789abcdefABCDEF"
ESCAPES = '"\\/bfnrtu'

# Scanner states
EXPECT_ROOT = "expect_root"
EXPECT_VALUE = "expect_value"
IN_STRING = "in_string"
STR_ESCAPE = "str_escape"
STR_UNICODE = "str_unicode"
IN_NUMBER = "in_number"
IN_LITERAL = "in_literal"
AFTER_VALUE = "after_value"
OBJ_EXPECT_KEY = "obj_expect_key"
OBJ_EXPECT_FIRST = "obj_expect_first"
OBJ_AFTER_KEY = "obj_after_key"
DONE = "done"

# Number sub-states
NUM_SIGN = "sign"
NUM_ZERO = "zero"
NUM_INT = "int"
NUM_DOT = "dot"
NUM_FRAC = "frac"
NUM_E = "e"
NUM_ESIGN = "esign"
NUM_EXP = "exp"

NUM_COMPLETE = {NUM_ZERO, NUM_INT, NUM_FRAC, NUM_EXP}


class JsonScanner:
    """Accepts characters while they remain a prefix of one JSON object."""

    def __init__(self):
        self.state = EXPECT_ROOT
        self.stack = []
        self.key = False
        self.num = None
        self.literal = None
        self.literal_at = 0
        self.unicode_left = 0

    def copy(self):
        clone = JsonScanner.__new__(JsonScanner)
        clone.state = self.state
        clone.stack = list(self.stack)
        clone.key = self.key
        clone.num = self.num
        clone.literal = self.literal
        clone.literal_at = self.literal_at
        clone.unicode_left = self.unicode_left
        return clone

    @property
    def done(self):
        return self.state == DONE

    def feed(self, text):
        for ch in text:
            if not self.advance(ch):
                return False
        return True

    def advance(self, ch):
        state = self.state

        if state == DONE:
            return ch in WS

        if state == IN_STRING:
            if ch == '"':
                self.state = OBJ_AFTER_KEY if self.key else AFTER_VALUE
                return True
            if ch == "\\":
                self.state = STR_ESCAPE
                return True
            return ord(ch) >= 0x20

        if state == STR_ESCAPE:
            if ch not in ESCAPES:
                return False
            if ch == "u":
                self.state = STR_UNICODE
                self.unicode_left = 4
            else:
                self.state = IN_STRING
            return True

        if state == STR_UNICODE:
            if ch not in HEX:
                return False
            self.unicode_left -= 1
            if self.unicode_left == 0:
                self.state = IN_STRING
            return True

        if state == IN_NUMBER:
            if self._number_char(ch):
                return True
            if self.num not in NUM_COMPLETE:
                return False
            self.state = AFTER_VALUE
            return self.advance(ch)

        if state == IN_LITERAL:
            if self.literal_at < len(self.literal) and ch == self.literal[self.literal_at]:
                self.literal_at += 1
                if self.literal_at == len(self.literal):
                    self.state = AFTER_VALUE
                return True
            return False

        if ch in WS:
            return True

        if state == EXPECT_ROOT:
            if ch == "{":
                self.stack.append("obj")
                self.state = OBJ_EXPECT_FIRST
                return True
            return False

        if state in (OBJ_EXPECT_FIRST, OBJ_EXPECT_KEY):
            if ch == '"':
                self.key = True
                self.state = IN_STRING
                return True
            if ch == "}" and state == OBJ_EXPECT_FIRST:
                return self._close("obj")
            return False

        if state == OBJ_AFTER_KEY:
            if ch == ":":
                self.key = False
                self.state = EXPECT_VALUE
                return True
            return False

        if state == EXPECT_VALUE:
            if ch == '"':
                self.state = IN_STRING
                return True
            if ch == "{":
                self.stack.append("obj")
                self.state = OBJ_EXPECT_FIRST
                return True
            if ch == "[":
                self.stack.append("arr")
                return True
            if ch == "]" and self.stack and self.stack[-1] == "arr":
                return self._close("arr")
            if ch == "-" or ch in DIGITS:
                self.state = IN_NUMBER
                self.num = NUM_SIGN if ch == "-" else (NUM_ZERO if ch == "0" else NUM_INT)
                return True
            for word in ("true", "false", "null"):
                if ch == word[0]:
                    self.state = IN_LITERAL
                    self.literal = word
                    self.literal_at = 1
                    return True
            return False

        if state == AFTER_VALUE:
            if not self.stack:
                return False
            container = self.stack[-1]
            if ch == ",":
                self.state = OBJ_EXPECT_KEY if container == "obj" else EXPECT_VALUE
                return True
            if ch == "}" and container == "obj":
                return self._close("obj")
            if ch == "]" and container == "arr":
                return self._close("arr")
            return False

        return False

    def _close(self, expected):
        if not self.stack or self.stack[-1] != expected:
            return False
        self.stack.pop()
        self.state = AFTER_VALUE if self.stack else DONE
        return True

    def _number_char(self, ch):
        num = self.num
        if ch in DIGITS:
            if num in (NUM_SIGN, NUM_INT):
                self.num = NUM_INT
            elif num == NUM_ZERO:
                return False
            elif num in (NUM_DOT, NUM_FRAC):
                self.num = NUM_FRAC
            elif num in (NUM_E, NUM_ESIGN, NUM_EXP):
                self.num = NUM_EXP
            else:
                return False
            return True
        if ch == ".":
            if num in (NUM_ZERO, NUM_INT):
                self.num = NUM_DOT
                return True
            return False
        if ch in "eE":
            if num in (NUM_ZERO, NUM_INT, NUM_FRAC):
                self.num = NUM_E
                return True
            return False
        if ch in "+-":
            if num == NUM_E:
                self.num = NUM_ESIGN
                return True
            return False
        return False


class JsonConstraint:
    """mlx_lm logits processor: (tokens, logits) -> logits, JSON-object shaped.

    Fast path: when the model's own argmax continuation is already legal the
    logits pass through untouched. Only when the model is about to step off
    the grammar does the mask engage. Any internal error latches the
    constraint open — the worst case is exactly today's unconstrained output.
    """

    TOP_K = 256
    WIDE_K = 4096
    TAIL = 8

    def __init__(self, tokenizer, log=None):
        self.tokenizer = tokenizer
        self.log = log or (lambda msg: print(msg, flush=True))
        self.prompt_len = None
        self.broken = False
        eos = getattr(tokenizer, "eos_token_ids", None)
        if not eos:
            single = getattr(tokenizer, "eos_token_id", None)
            eos = {single} if single is not None else set()
        self.eos_ids = set(int(e) for e in eos)

    def __call__(self, tokens, logits):
        if self.broken:
            return logits
        try:
            return self._apply(tokens, logits)
        except Exception as err:
            self.broken = True
            self.log(f"[Constrain] disabled after internal error: {err}")
            return logits

    def _apply(self, tokens, logits):
        import numpy as np

        token_list = [int(t) for t in tokens.tolist()]
        if self.prompt_len is None:
            self.prompt_len = len(token_list)
        generated = token_list[self.prompt_len:]

        text = self.tokenizer.decode(generated) if generated else ""
        scanner = JsonScanner()
        if not scanner.feed(text):
            self.broken = True
            self.log("[Constrain] generated text left the grammar; disabling.")
            return logits

        if scanner.done:
            return self._only_eos(logits)

        flat = logits.reshape(-1)
        scores = np.array(flat, copy=False)
        vocab = scores.shape[0]

        argmax = int(scores.argmax())
        if self._legal(scanner, generated, argmax):
            return logits

        for k in (self.TOP_K, self.WIDE_K):
            k = min(k, vocab)
            candidates = np.argpartition(scores, -k)[-k:]
            allowed = [int(t) for t in candidates if self._legal(scanner, generated, int(t))]
            if allowed:
                return self._mask_to(logits, allowed)

        self.broken = True
        self.log("[Constrain] no legal continuation in the widened candidate set; disabling.")
        return logits

    def _legal(self, scanner, generated, token_id):
        if token_id in self.eos_ids:
            return False
        piece = self._piece(generated, token_id)
        if not piece:
            return False
        probe = scanner.copy()
        return probe.feed(piece)

    def _piece(self, generated, token_id):
        tail = generated[-self.TAIL:]
        before = self.tokenizer.decode(tail) if tail else ""
        after = self.tokenizer.decode(tail + [token_id])
        if after.startswith(before):
            return after[len(before):]
        return after

    def _only_eos(self, logits):
        if not self.eos_ids:
            return logits
        return self._mask_to(logits, list(self.eos_ids))

    def _mask_to(self, logits, allowed):
        import numpy as np
        import mlx.core as mx

        flat = logits.reshape(-1)
        mask = np.zeros(flat.shape[0], dtype=bool)
        mask[[t for t in allowed if 0 <= t < flat.shape[0]]] = True
        floor = mx.array(float("-inf"), dtype=logits.dtype)
        return mx.where(mx.array(mask), flat, floor).reshape(logits.shape)
