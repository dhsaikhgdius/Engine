# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

"""Host-free stress tests for the Blender kernel policy denylists.

Runs without Blender installed; kernel_policy deliberately has no ``bpy``
import. The TypeScript copy in packages/protocol/src/blenderKernel.ts is kept
in sync by packages/protocol/tests/blenderKernel.test.ts.
"""

import pathlib
import sys
import unittest


ADDON_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_ROOT))

import kernel_policy  # noqa: E402


class OperatorDenylistTest(unittest.TestCase):
    def test_session_destroying_mainfile_loads_are_denied(self):
        for operator in (
            "wm.quit_blender",
            "wm.window_close",
            "wm.open_mainfile",
            "wm.revert_mainfile",
            "wm.read_homefile",
            "wm.read_factory_settings",
            "wm.recover_last_session",
            "wm.recover_auto_save",
        ):
            self.assertFalse(kernel_policy.is_allowed_operator(operator), operator)
            self.assertFalse(kernel_policy.is_allowed_operator(operator.upper()), operator)

    def test_saving_and_modeling_operators_stay_allowed(self):
        for operator in (
            "wm.save_as_mainfile",
            "wm.save_mainfile",
            "mesh.subdivide",
            "import_scene.gltf",
            "render.render",
        ):
            self.assertTrue(kernel_policy.is_allowed_operator(operator), operator)

    def test_denied_categories_reject_every_member(self):
        for category in sorted(kernel_policy.OPERATOR_CATEGORY_DENYLIST):
            self.assertFalse(kernel_policy.is_allowed_operator(f"{category}.anything"))

    def test_malformed_operator_identifiers_are_denied(self):
        for identifier in ("", "mesh", "mesh.", ".subdivide", "mesh.subdivide.extra", "mesh/../wm.quit_blender"):
            self.assertFalse(kernel_policy.is_allowed_operator(identifier), identifier)

    def test_assert_kernel_policy_raises_for_denied_invocations(self):
        with self.assertRaises(ValueError):
            kernel_policy.assert_kernel_policy({"op": "invoke_operator", "operator": "wm.open_mainfile"})
        with self.assertRaises(ValueError):
            kernel_policy.assert_kernel_policy({"op": "describe_operator", "operator": "console.do_console"})
        kernel_policy.assert_kernel_policy({"op": "invoke_operator", "operator": "wm.save_as_mainfile"})


class RnaWriteTest(unittest.TestCase):
    def test_rna_target_kinds_outside_the_allowlist_are_denied(self):
        self.assertFalse(kernel_policy.is_allowed_rna_write({"target": {"kind": "image"}, "path": ["name"]}))
        self.assertFalse(kernel_policy.is_allowed_rna_write({"target": {"kind": "text"}, "path": ["name"]}))
        self.assertFalse(kernel_policy.is_allowed_rna_write({"target": None, "path": ["name"]}))
        self.assertFalse(kernel_policy.is_allowed_rna_write({"target": {"kind": "scene"}, "path": None}))

    def test_library_script_expression_segments_are_denied_case_insensitively(self):
        for segment in ("library", "LIBRARY", "script", "expression", "Expression"):
            self.assertFalse(
                kernel_policy.is_allowed_rna_write({"target": {"kind": "object"}, "path": [segment]}),
                segment,
            )

    def test_render_output_filepath_stays_writable_via_rna(self):
        self.assertTrue(
            kernel_policy.is_allowed_rna_write({"target": {"kind": "scene"}, "path": ["render", "filepath"]})
        )


class TypedPropertyDenyTest(unittest.TestCase):
    def test_path_like_and_code_carrying_names_are_denied(self):
        for name in ("filepath", "FILEPATH", "filename", "directory", "library", "script", "expression"):
            self.assertIsNotNone(kernel_policy._TYPED_PROPERTY_DENY.match(name), name)

    def test_regular_modeling_property_names_are_allowed(self):
        for name in ("width", "segments", "use_clamp_overlap", "filepath_extra", "my_filename"):
            self.assertIsNone(kernel_policy._TYPED_PROPERTY_DENY.match(name), name)


if __name__ == "__main__":
    unittest.main(verbosity=2)
