"""Package a curated, animation-only Mixamo library as deterministic GLB clips.

Run with Blender, not the system Python:

  /Applications/Blender.app/Contents/MacOS/Blender --background \
    --factory-startup --python tools/scripts/package_mixamo_animations.py -- \
    --source-dir .external/mixamo-downloader/downloads/animations \
    --output-dir assets/library/mixamo-animations

The source FBX files are supplied locally by the project owner. The generated
catalog keeps source and license provenance visible to both humans and agents.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from dataclasses import dataclass
from pathlib import Path

import bpy


MIXAMO_FAQ_URL = "https://helpx.adobe.com/creative-cloud/faq/mixamo-faq.html"


@dataclass(frozen=True)
class MotionSpec:
    id: str
    name: str
    name_zh: str
    source_file: str
    category: str
    tags: tuple[str, ...]
    default_loop: str
    root_motion: str


MOTIONS = (
    MotionSpec("idle", "Standard Idle", "标准待机", "Standard_Idle.fbx", "idle", ("idle", "standing", "neutral"), "repeat", "in-place"),
    MotionSpec("walk", "Walk Forward", "向前行走", "Unarmed_Walk_Forward__c9cef1a4.fbx", "locomotion", ("walk", "forward", "unarmed"), "repeat", "in-place"),
    MotionSpec(
        "walk-back",
        "Walk Backward",
        "向后行走",
        "Unarmed_Walk_Back.fbx",
        "locomotion",
        ("walk", "backward", "unarmed"),
        "repeat",
        "in-place",
    ),
    MotionSpec(
        "walk-left",
        "Walk Left",
        "向左行走",
        "Standing_Walk_Left__c9cec849.fbx",
        "locomotion",
        ("walk", "left", "strafe"),
        "repeat",
        "in-place",
    ),
    MotionSpec(
        "walk-right",
        "Walk Right",
        "向右行走",
        "Standing_Walk_Right__c9cec9cf.fbx",
        "locomotion",
        ("walk", "right", "strafe"),
        "repeat",
        "in-place",
    ),
    MotionSpec(
        "run",
        "Unarmed Run Forward",
        "无武装向前跑",
        "Unarmed_Run_Forward__c9ceee9c.fbx",
        "locomotion",
        ("run", "forward", "unarmed", "loop"),
        "repeat",
        "in-place",
    ),
    MotionSpec(
        "run-back",
        "Unarmed Run Backward",
        "无武装向后跑",
        "Unarmed_Run_Back.fbx",
        "locomotion",
        ("run", "backward", "unarmed", "loop"),
        "repeat",
        "in-place",
    ),
    MotionSpec(
        "run-left",
        "Run Left",
        "向左跑",
        "Standing_Run_Left__bb7b9d57.fbx",
        "locomotion",
        ("run", "left", "strafe", "loop"),
        "repeat",
        "in-place",
    ),
    MotionSpec(
        "run-right",
        "Run Right",
        "向右跑",
        "Standing_Run_Right__1dc8d38f.fbx",
        "locomotion",
        ("run", "right", "strafe", "loop"),
        "repeat",
        "in-place",
    ),
    MotionSpec("wave", "Wave", "挥手", "Waving__c9c5ed32.fbx", "gesture", ("wave", "greeting", "standing"), "once", "in-place"),
    MotionSpec("clap", "Standing Clap", "站立鼓掌", "Standing_Clap__c9cb6b49.fbx", "gesture", ("clap", "approval", "standing"), "once", "in-place"),
    MotionSpec("sit-idle", "Sitting Idle", "坐姿待机", "Sitting_Idle__c9ccd526.fbx", "idle", ("sit", "idle"), "repeat", "in-place"),
    MotionSpec(
        "jump",
        "Standing Jump",
        "原地跳跃",
        "Standing_Jump__fab2ce21.fbx",
        "action",
        ("jump", "standing", "landing"),
        "once",
        "in-place",
    ),
    MotionSpec("talk", "Standing Talk", "站立说话", "Talking__c9c6de72.fbx", "performance", ("talk", "dialogue", "standing"), "repeat", "in-place"),
)


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def import_animation(source_path: Path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    result = bpy.ops.import_scene.fbx(filepath=str(source_path))
    if "FINISHED" not in result:
        raise RuntimeError(f"FBX import failed: {source_path}")

    armatures = [item for item in bpy.context.scene.objects if item.type == "ARMATURE"]
    if len(armatures) != 1:
        raise RuntimeError(f"Expected one armature in {source_path.name}, found {len(armatures)}")

    armature = armatures[0]
    action = armature.animation_data.action if armature.animation_data else None
    if action is None:
        raise RuntimeError(f"No active animation action in {source_path.name}")
    return armature, action


def export_clip(source_path: Path, output_path: Path, clip_id: str) -> dict[str, object]:
    armature, action = import_animation(source_path)
    action.name = clip_id
    frame_start = int(round(action.frame_range[0]))
    frame_end = int(round(action.frame_range[1]))
    bpy.context.scene.frame_start = frame_start
    bpy.context.scene.frame_end = frame_end
    bpy.context.scene.render.fps = 30
    bpy.context.scene.render.fps_base = 1

    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    bpy.context.view_layer.objects.active = armature
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result = bpy.ops.export_scene.gltf(
        filepath=str(output_path),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="ACTIVE_ACTIONS",
        export_force_sampling=True,
        export_frame_range=True,
        export_yup=True,
        export_cameras=False,
        export_lights=False,
        export_extras=True,
    )
    if "FINISHED" not in result or not output_path.is_file():
        raise RuntimeError(f"glTF export failed: {output_path}")

    frame_count = max(1, frame_end - frame_start + 1)
    return {
        "durationS": round((frame_count - 1) / 30, 6),
        "frameCount": frame_count,
        "sourceFps": 30,
        "byteLength": output_path.stat().st_size,
        "sha256": sha256(output_path),
    }


def main() -> None:
    args = parse_args()
    source_dir = args.source_dir.resolve()
    output_dir = args.output_dir.resolve()
    clips_dir = output_dir / "clips"
    output_dir.mkdir(parents=True, exist_ok=True)

    missing = [spec.source_file for spec in MOTIONS if not (source_dir / spec.source_file).is_file()]
    if missing:
        raise FileNotFoundError(f"Missing Mixamo source files: {', '.join(missing)}")

    items: list[dict[str, object]] = []
    for spec in MOTIONS:
        source_path = source_dir / spec.source_file
        output_path = clips_dir / f"{spec.id}.glb"
        metrics = export_clip(source_path, output_path, spec.id)
        items.append(
            {
                "id": spec.id,
                "name": spec.name,
                "nameZh": spec.name_zh,
                "category": spec.category,
                "tags": list(spec.tags),
                "url": f"/mixamo-animations/clips/{spec.id}.glb",
                "fileName": output_path.name,
                "defaultLoop": spec.default_loop,
                "recommendedRootMotion": spec.root_motion,
                **metrics,
                "source": {
                    "provider": "Adobe Mixamo",
                    "fileName": spec.source_file,
                    "licenseUrl": MIXAMO_FAQ_URL,
                    "provenance": "local-user-supplied",
                },
            }
        )
        print(f"Packaged {spec.id}: {output_path.name} ({metrics['byteLength']} bytes)")

    catalog = {
        "schemaVersion": 1,
        "generator": "tools/scripts/package_mixamo_animations.py",
        "items": items,
    }
    catalog_path = output_dir / "catalog.json"
    catalog_path.write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {catalog_path} with {len(items)} motions")


if __name__ == "__main__":
    main()
