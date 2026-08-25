# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

import pathlib
import sys
import unittest


ADDON_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_ROOT))

import material_names  # noqa: E402


class MaterialNamesTestCase(unittest.TestCase):
    def test_unique_names_collapse_blender_clones_and_prefer_used(self):
        names = [
            "bark_brown",
            "Beta_HighLimbsGeoSG3.001",
            "Beta_HighLimbsGeoSG3.002",
            "Beta_HighLimbsGeoSG3.063",
            "roof_tile",
            "ground_grey",
        ]
        listed = material_names.unique_material_names(
            names,
            used=["roof_tile", "Beta_HighLimbsGeoSG3.002"],
            limit=8,
        )
        self.assertEqual(listed[0], "roof_tile")
        self.assertEqual(listed[1], "Beta_HighLimbsGeoSG3.002")
        self.assertEqual(
            listed,
            ["roof_tile", "Beta_HighLimbsGeoSG3.002", "bark_brown", "ground_grey"],
        )

    def test_nearby_requires_shared_tokens_or_a_close_typo(self):
        names = ["ground_grey", "roof_tile", "gold_leaf", "Gold Plaque", "bark_brown"]
        nearby = material_names.nearby_material_names_from("gold_plaque", names)
        self.assertIn("gold_leaf", nearby)
        self.assertIn("Gold Plaque", nearby)
        self.assertNotIn("ground_grey", nearby)
        self.assertNotIn("roof_tile", nearby)

    def test_nearby_keeps_chinese_substring_tokens(self):
        names = ["清华园匾额", "gate_roof", "亭顶宝珠"]
        nearby = material_names.nearby_material_names_from("清华", names)
        self.assertEqual(nearby, ["清华园匾额"])


if __name__ == "__main__":
    unittest.main()
