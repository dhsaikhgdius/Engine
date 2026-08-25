# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

import pathlib
import sys
import tempfile
import unittest
import zipfile


ADDON_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_ROOT))

import asset_library_http  # noqa: E402


class AssetLibraryHttpTestCase(unittest.TestCase):
    def test_filters_polyhaven_assets_by_id_name_and_tags(self):
        assets = {
            "modern_chair": {
                "name": "Modern Chair",
                "type": "models",
                "categories": ["furniture"],
                "tags": ["seat"],
            },
            "studio_hdri": {
                "name": "Studio",
                "type": "hdris",
                "categories": ["indoor"],
                "tags": ["studio"],
            },
        }
        matches = asset_library_http.filter_polyhaven_assets(assets, "chair", 20)
        self.assertEqual([item["id"] for item in matches], ["modern_chair"])
        self.assertEqual(len(asset_library_http.filter_polyhaven_assets(assets, "", 1)), 1)

    def test_rejects_zip_slip_and_https_only_urls(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            with self.assertRaises(ValueError):
                asset_library_http.safe_join(root, "../secret.txt")
            with self.assertRaises(ValueError):
                asset_library_http.safe_join(root, "/etc/passwd")
            nested = asset_library_http.safe_join(root, "textures/color.jpg")
            self.assertEqual(nested, (root / "textures" / "color.jpg").resolve())

            archive = root / "payload.zip"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr("ok.gltf", "{}")
                bundle.writestr("../escape.bin", "nope")
            with self.assertRaises(ValueError):
                asset_library_http.extract_zip(archive, root / "extracted")

        with self.assertRaises(ValueError):
            asset_library_http.assert_https_url("http://cdn.example.test/file.hdr")
        asset_library_http.assert_https_url("https://cdn.polyhaven.org/file.hdr")

    def test_builds_library_urls(self):
        self.assertIn("type=models", asset_library_http.polyhaven_assets_url(asset_type="models", categories=None))
        self.assertIn("categories=furniture", asset_library_http.polyhaven_assets_url(asset_type="models", categories="furniture"))
        self.assertTrue(asset_library_http.polyhaven_assets_url(asset_type="all", categories=None).endswith("/assets"))
        self.assertIn("downloadable=true", asset_library_http.sketchfab_search_url(query="chair", count=5))


if __name__ == "__main__":
    unittest.main()
