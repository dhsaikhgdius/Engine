# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

import math
import pathlib
import sys
import unittest


ADDON_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_ROOT))

import coordinates  # noqa: E402


class CoordinatesTestCase(unittest.TestCase):
    def test_round_trip(self):
        director = (1.25, -2.5, 3.75)
        blender = coordinates.director_to_blender_point(director)
        self.assertEqual(blender, (1.25, -3.75, -2.5))
        self.assertEqual(coordinates.blender_to_director_point(blender), director)

    def test_rejects_invalid_points(self):
        for point in ((0, 0), (0, True, 0), (0, 0, math.nan), (0, 0, 100_001)):
            with self.subTest(point=point):
                with self.assertRaises(ValueError):
                    coordinates.director_to_blender_point(point)


if __name__ == "__main__":
    unittest.main()
