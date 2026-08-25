# SPDX-FileCopyrightText: 2026 OpenEnvision Authors
#
# SPDX-License-Identifier: GPL-2.0-or-later

import pathlib
import sys
import unittest


ADDON_ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ADDON_ROOT))

import live_link  # noqa: E402


EPOCH_A = "82a6f8c1-7cb8-4d6f-a5f2-a4f5654a0420"
EPOCH_B = "1d1cf6cc-0b39-4f21-a2ad-05a3cbb0be51"


def snapshot(revision=1, frame=0, objects=(), cameras=(), lights=()):
    return {
        "revision": revision,
        "contentRevision": revision,
        "frame": frame,
        "objects": list(objects),
        "cameras": list(cameras),
        "lights": list(lights),
    }


def cube(position=(0.0, 0.0, 0.0), name="Cube", visible=True):
    return {
        "id": "obj-cube",
        "directorId": "director-cube",
        "name": name,
        "position": list(position),
        "rotation": [0.0, 0.0, 0.0],
        "scale": [1.0, 1.0, 1.0],
        "visible": visible,
    }


def camera(position=(0.0, 1.0, 4.0), lens=35.0, active=True):
    return {
        "id": "cam-main",
        "name": "Main",
        "position": list(position),
        "rotation": [0.0, 0.0, 0.0],
        "focalLengthMm": lens,
        "active": active,
    }


def light(energy=420.0):
    return {
        "id": "light-key",
        "name": "Key",
        "position": [4.0, -4.0, 7.0],
        "rotation": [0.4, 0.0, 0.6],
        "color": [1.0, 0.94, 0.86],
        "energy": energy,
    }


class LiveLinkBufferTestCase(unittest.TestCase):
    def publish_baseline(self, buffer):
        # The first snapshot after an epoch reset is a structure frame that
        # forces consumers through the authoritative snapshot.
        frame = buffer.publish(EPOCH_A, snapshot(objects=[cube()], cameras=[camera()], lights=[light()]))
        self.assertEqual(frame["kind"], "structure")
        self.assertEqual(frame["seq"], 1)
        return frame

    def test_identical_snapshots_emit_no_frame(self):
        buffer = live_link.LiveLinkBuffer()
        self.publish_baseline(buffer)
        self.assertIsNone(
            buffer.publish(EPOCH_A, snapshot(objects=[cube()], cameras=[camera()], lights=[light()]))
        )
        self.assertEqual(buffer.seq, 1)

    def test_transform_delta_is_sequenced_and_bounded_to_changed_entities(self):
        buffer = live_link.LiveLinkBuffer()
        self.publish_baseline(buffer)
        frame = buffer.publish(
            EPOCH_A,
            snapshot(revision=2, objects=[cube(position=(2.0, 0.0, 0.0))], cameras=[camera()], lights=[light()]),
        )
        self.assertEqual(frame["kind"], "transform")
        self.assertEqual(frame["seq"], 2)
        self.assertEqual(frame["revision"], 2)
        self.assertEqual([update["id"] for update in frame["objects"]], ["obj-cube"])
        self.assertEqual(frame["objects"][0]["directorId"], "director-cube")
        self.assertEqual(frame["objects"][0]["position"], [2.0, 0.0, 0.0])
        self.assertEqual(frame["cameras"], [])
        self.assertEqual(frame["lights"], [])

    def test_camera_lens_and_light_energy_travel_as_transform_deltas(self):
        buffer = live_link.LiveLinkBuffer()
        self.publish_baseline(buffer)
        frame = buffer.publish(
            EPOCH_A,
            snapshot(revision=2, objects=[cube()], cameras=[camera(lens=50.0)], lights=[light(energy=180.0)]),
        )
        self.assertEqual(frame["kind"], "transform")
        self.assertEqual(frame["cameras"][0]["focalLengthMm"], 50.0)
        self.assertEqual(frame["lights"][0]["energy"], 180.0)

    def test_structural_changes_degrade_to_structure_frames(self):
        buffer = live_link.LiveLinkBuffer()
        self.publish_baseline(buffer)
        renamed = buffer.publish(
            EPOCH_A,
            snapshot(revision=2, objects=[cube(name="Renamed")], cameras=[camera()], lights=[light()]),
        )
        self.assertEqual(renamed["kind"], "structure")
        self.assertEqual(renamed["objects"], [])
        deleted = buffer.publish(EPOCH_A, snapshot(revision=3, cameras=[camera()], lights=[light()]))
        self.assertEqual(deleted["kind"], "structure")

    def test_poll_serves_contiguous_frames_after_cursor(self):
        buffer = live_link.LiveLinkBuffer()
        self.publish_baseline(buffer)
        for step in range(2, 5):
            buffer.publish(
                EPOCH_A,
                snapshot(revision=step, objects=[cube(position=(float(step), 0.0, 0.0))], cameras=[camera()], lights=[light()]),
            )
        poll = buffer.poll(EPOCH_A, 2)
        self.assertEqual(poll["kind"], "frames")
        self.assertEqual(poll["sceneEpoch"], EPOCH_A)
        self.assertEqual(poll["seq"], 4)
        self.assertEqual([frame["seq"] for frame in poll["frames"]], [3, 4])
        replay = buffer.poll(EPOCH_A, 4)
        self.assertEqual(replay["kind"], "frames")
        self.assertEqual(replay["frames"], [])

    def test_poll_resyncs_on_first_contact_epoch_change_and_eviction(self):
        buffer = live_link.LiveLinkBuffer(capacity=2)
        self.publish_baseline(buffer)
        self.assertEqual(buffer.poll(None, None)["reason"], "initial")
        self.assertEqual(buffer.poll(EPOCH_B, 0)["reason"], "epoch_changed")
        for step in range(2, 6):
            buffer.publish(
                EPOCH_A,
                snapshot(revision=step, objects=[cube(position=(float(step), 0.0, 0.0))], cameras=[camera()], lights=[light()]),
            )
        evicted = buffer.poll(EPOCH_A, 1)
        self.assertEqual(evicted["kind"], "resync")
        self.assertEqual(evicted["reason"], "history_evicted")
        future = buffer.poll(EPOCH_A, 99)
        self.assertEqual(future["reason"], "history_evicted")

    def test_epoch_change_resets_sequencing_and_history(self):
        buffer = live_link.LiveLinkBuffer()
        self.publish_baseline(buffer)
        buffer.publish(
            EPOCH_A,
            snapshot(revision=2, objects=[cube(position=(1.0, 0.0, 0.0))], cameras=[camera()], lights=[light()]),
        )
        self.assertEqual(buffer.seq, 2)
        rebased = buffer.publish(EPOCH_B, snapshot(objects=[cube()], cameras=[camera()], lights=[light()]))
        self.assertEqual(buffer.epoch, EPOCH_B)
        self.assertEqual(rebased["seq"], 1)
        self.assertEqual(rebased["kind"], "structure")
        self.assertEqual(buffer.poll(EPOCH_A, 2)["reason"], "epoch_changed")

    def test_frame_scrub_emits_transform_frame_without_entity_updates(self):
        buffer = live_link.LiveLinkBuffer()
        self.publish_baseline(buffer)
        frame = buffer.publish(
            EPOCH_A,
            snapshot(revision=1, frame=24, objects=[cube()], cameras=[camera()], lights=[light()]),
        )
        self.assertEqual(frame["kind"], "transform")
        self.assertEqual(frame["frame"], 24)
        self.assertEqual(frame["objects"], [])

    def test_health_state_reports_seq_and_capacity(self):
        buffer = live_link.LiveLinkBuffer(capacity=8)
        self.publish_baseline(buffer)
        state = buffer.state()
        self.assertEqual(state, {"seq": 1, "bufferedFrames": 1, "capacity": 8})


if __name__ == "__main__":
    unittest.main()
