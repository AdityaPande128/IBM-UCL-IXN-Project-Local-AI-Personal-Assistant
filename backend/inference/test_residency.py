"""Eviction-policy tests: a fake loader and seeded sizes, no models load.

    python3 -m unittest discover backend/inference
"""

import unittest

from residency import ResidencyManager, ResidencyError, GB

GUARD = "org/guard-4b"
ENGINE = "org/engine-8b"
SMITH = "org/smith-14b"

TIERS = {
    "guard": {"model": GUARD, "policy": "pinned"},
    "engine": {"model": ENGINE, "policy": "resident"},
    "smith": {"model": SMITH, "policy": "transient"},
}

SIZES = {GUARD: 2.1 * GB, ENGINE: 4.9 * GB, SMITH: 7.7 * GB}


class FakeModel:
    """Deliberately without .parameters(), so no MLX call succeeds."""

    def __init__(self, model_id):
        self.model_id = model_id


def manager(budget_gb=14.0, tiers=TIERS, sizes=SIZES):
    loaded = []

    def loader(model_id):
        loaded.append(model_id)
        return FakeModel(model_id), f"tokenizer:{model_id}"

    mgr = ResidencyManager(budget_bytes=budget_gb * GB, tiers=tiers,
                           loader=loader, known_sizes=sizes, log=lambda *_: None)
    mgr.loaded_log = loaded
    return mgr


def resident(mgr):
    return {m["id"] for m in mgr.state()["models"] if m["loaded"]}


class TestResolution(unittest.TestCase):

    def test_a_tier_name_resolves_to_its_model(self):
        self.assertEqual(manager().resolve("engine"), ENGINE)

    def test_a_bare_name_resolves_to_the_full_id(self):
        self.assertEqual(manager().resolve("smith-14b"), SMITH)

    def test_a_full_id_resolves_to_itself(self):
        self.assertEqual(manager().resolve(GUARD), GUARD)

    def test_no_model_named_falls_back_to_the_engine(self):
        self.assertEqual(manager().resolve(None), ENGINE)


class TestEviction(unittest.TestCase):

    def test_the_pinned_guard_survives_everything_else_loading(self):
        mgr = manager()
        with mgr.use("guard"):
            pass
        for tier in ("engine", "smith", "engine", "smith"):
            with mgr.use(tier):
                pass
        self.assertIn(GUARD, resident(mgr))

    def test_a_transient_is_evicted_before_a_resident(self):
        mgr = manager(budget_gb=11.0)
        with mgr.use("guard"):
            pass
        with mgr.use("smith"):
            pass
        self.assertEqual(resident(mgr), {GUARD, SMITH})

        with mgr.use("engine"):
            pass
        self.assertEqual(resident(mgr), {GUARD, ENGINE})

    def test_the_least_recently_used_resident_goes_first(self):
        tiers = {
            "guard": {"model": GUARD, "policy": "pinned"},
            "a": {"model": "org/a", "policy": "resident"},
            "b": {"model": "org/b", "policy": "resident"},
            "c": {"model": "org/c", "policy": "resident"},
        }
        sizes = {GUARD: 2.1 * GB, "org/a": 4 * GB, "org/b": 4 * GB, "org/c": 4 * GB}
        mgr = manager(budget_gb=11.0, tiers=tiers, sizes=sizes)

        mgr.preload("guard")

        with mgr.use("a"):
            pass
        with mgr.use("b"):
            pass
        self.assertEqual(resident(mgr), {GUARD, "org/a", "org/b"})

        with mgr.use("c"):
            pass
        self.assertEqual(resident(mgr), {GUARD, "org/b", "org/c"})

    def test_a_model_in_use_is_never_evicted(self):
        mgr = manager(budget_gb=11.0)
        with mgr.use("engine"):
            with self.assertRaises(ResidencyError):
                with mgr.use("smith"):
                    pass
            self.assertIn(ENGINE, resident(mgr))

    def test_the_error_names_what_is_holding_the_memory(self):
        mgr = manager(budget_gb=11.0)
        with mgr.use("engine"):
            with self.assertRaises(ResidencyError) as caught:
                with mgr.use("smith"):
                    pass
        self.assertIn("engine-8b", str(caught.exception))

    def test_a_model_too_large_for_the_budget_fails_rather_than_thrashing(self):
        mgr = manager(budget_gb=6.0)
        with self.assertRaises(ResidencyError):
            with mgr.use("smith"):
                pass


class TestAdmission(unittest.TestCase):

    def test_an_undeclared_model_is_admitted_as_transient(self):
        mgr = manager()
        with mgr.use("org/stranger"):
            pass
        entry = next(m for m in mgr.state()["models"] if m["id"] == "org/stranger")
        self.assertEqual(entry["policy"], "transient")
        self.assertIsNone(entry["tier"])

    def test_a_reload_is_counted_so_thrashing_is_visible(self):
        mgr = manager(budget_gb=11.0)
        for tier in ("engine", "smith", "engine"):
            with mgr.use(tier):
                pass
        engine = next(m for m in mgr.state()["models"] if m["id"] == ENGINE)
        self.assertEqual(engine["loads"], 2)

    def test_an_already_resident_model_is_not_reloaded(self):
        mgr = manager()
        for _ in range(3):
            with mgr.use("guard"):
                pass
        self.assertEqual(mgr.loaded_log.count(GUARD), 1)


class TestAccounting(unittest.TestCase):

    def test_state_reports_the_budget_it_is_holding_to(self):
        mgr = manager()
        with mgr.use("engine"):
            pass
        state = mgr.state()
        self.assertEqual(state["budget_gb"], 14.0)
        self.assertAlmostEqual(state["used_gb"], 4.9, places=1)
        self.assertAlmostEqual(state["free_gb"], 9.1, places=1)

    def test_in_use_is_visible_while_a_generation_holds_a_model(self):
        mgr = manager()
        with mgr.use("engine"):
            entry = next(m for m in mgr.state()["models"] if m["id"] == ENGINE)
            self.assertTrue(entry["in_use"])
        entry = next(m for m in mgr.state()["models"] if m["id"] == ENGINE)
        self.assertFalse(entry["in_use"])

    def test_a_release_happens_even_when_the_call_raises(self):
        mgr = manager()
        with self.assertRaises(ValueError):
            with mgr.use("engine"):
                raise ValueError("generation blew up")
        entry = next(m for m in mgr.state()["models"] if m["id"] == ENGINE)
        self.assertFalse(entry["in_use"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
