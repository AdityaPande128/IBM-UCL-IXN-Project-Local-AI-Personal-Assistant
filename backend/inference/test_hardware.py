"""Memory-class selection tests: pure table lookups, no hardware touched.

    python3 -m unittest discover backend/inference
"""

import unittest

from hardware import memory_class, tiers_for, total_memory_bytes, GB

DEFAULTS = {
    "8": {"guard": {"model": "org/guard-4b", "policy": "pinned"}},
    "16": {"guard": {"model": "org/guard-4b", "policy": "pinned"},
           "engine": {"model": "org/engine-8b", "policy": "resident"}},
    "24": {"guard": {"model": "org/guard-4b", "policy": "pinned"},
           "engine": {"model": "org/engine-8b", "policy": "resident"},
           "smith": {"model": "org/smith-14b", "policy": "transient"}},
}


class MemoryClassTest(unittest.TestCase):

    def test_exact_classes_map_to_themselves(self):
        for gb in (8, 16, 24):
            self.assertEqual(memory_class(DEFAULTS, gb * GB), gb)

    def test_between_classes_rounds_down(self):
        self.assertEqual(memory_class(DEFAULTS, 12 * GB), 8)
        self.assertEqual(memory_class(DEFAULTS, 18 * GB), 16)
        self.assertEqual(memory_class(DEFAULTS, 23 * GB), 16)

    def test_above_the_table_takes_the_largest_class(self):
        self.assertEqual(memory_class(DEFAULTS, 32 * GB), 24)
        self.assertEqual(memory_class(DEFAULTS, 128 * GB), 24)

    def test_below_the_table_takes_the_smallest_as_a_floor(self):
        self.assertEqual(memory_class(DEFAULTS, 6 * GB), 8)

    def test_reported_size_slightly_under_nominal_still_counts(self):
        self.assertEqual(memory_class(DEFAULTS, int(15.6 * GB)), 16)


class TiersForTest(unittest.TestCase):

    def test_returns_the_chosen_class_entry(self):
        tiers = tiers_for(DEFAULTS, 24 * GB, log=lambda *_: None)
        self.assertEqual(tiers, DEFAULTS["24"])
        tiers = tiers_for(DEFAULTS, 16 * GB, log=lambda *_: None)
        self.assertEqual(tiers, DEFAULTS["16"])

    def test_no_table_means_no_answer(self):
        self.assertIsNone(tiers_for(None, 24 * GB, log=lambda *_: None))
        self.assertIsNone(tiers_for({}, 24 * GB, log=lambda *_: None))

    def test_integer_keys_are_tolerated(self):
        table = {8: {"guard": {"model": "org/guard-4b", "policy": "pinned"}}}
        tiers = tiers_for(table, 8 * GB, log=lambda *_: None)
        self.assertEqual(tiers, table[8])

    def test_logs_the_choice(self):
        lines = []
        tiers_for(DEFAULTS, 16 * GB, log=lines.append)
        self.assertEqual(len(lines), 1)
        self.assertIn("16 GB defaults", lines[0])


class TotalMemoryTest(unittest.TestCase):

    def test_reports_something_plausible(self):
        total = total_memory_bytes()
        self.assertIsInstance(total, int)
        self.assertGreaterEqual(total, 2 * GB)


if __name__ == "__main__":
    unittest.main()
