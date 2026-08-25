#!/usr/bin/env python3
"""One-shot LTX-2.3 DistilledPipeline run. Gateway spawns this; it is not a server."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path


def progress(phase: str, percent: float) -> None:
    print(f"PROGRESS {phase} {percent}", flush=True)


def require_license() -> None:
    if os.environ.get("DIRECTOR_ACCEPT_LTX2_LICENSE") != "1":
        raise SystemExit(
            "Official LTX-2 source is governed by the LTX-2 Community License. "
            "Review it, then set DIRECTOR_ACCEPT_LTX2_LICENSE=1."
        )


def env_path(name: str, directory: bool = False) -> Path:
    value = os.environ.get(name, "").strip()
    path = Path(value).expanduser().resolve() if value else None
    if path is None or (directory and not path.is_dir()) or (not directory and not path.is_file()):
        raise SystemExit(f"Missing or invalid {name}")
    return path


def load_pipeline():
    import torch
    from ltx_pipelines.distilled import DistilledPipeline
    from ltx_pipelines.utils.quantization_factory import QuantizationKind
    from ltx_pipelines.utils.types import OffloadMode

    quantization_name = os.environ.get("LTX23_QUANTIZATION", "").strip()
    checkpoint = env_path("LTX23_DISTILLED_CHECKPOINT_PATH")
    quantization = (
        QuantizationKind(quantization_name).to_policy(checkpoint_path=str(checkpoint)) if quantization_name else None
    )
    device_name = os.environ.get("LTX23_DEVICE", "").strip()
    return DistilledPipeline(
        distilled_checkpoint_path=str(checkpoint),
        spatial_upsampler_path=str(env_path("LTX23_SPATIAL_UPSAMPLER_PATH")),
        gemma_root=str(env_path("LTX23_GEMMA_ROOT", directory=True)),
        loras=[],
        device=torch.device(device_name) if device_name else None,
        quantization=quantization,
        offload_mode=OffloadMode(os.environ.get("LTX23_OFFLOAD", "none")),
    )


def main() -> None:
    require_license()
    parser = argparse.ArgumentParser(description="Run one LTX-2.3 DistilledPipeline job")
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    request = json.loads(args.request.read_text(encoding="utf-8"))

    from ltx_core.model.video_vae import TilingConfig, get_video_chunks_number
    from ltx_pipelines.utils.args import ImageConditioningInput
    from ltx_pipelines.utils.media_io import encode_video

    progress("loading-model", 5)
    pipeline = load_pipeline()
    images = [
        ImageConditioningInput(
            path=str(Path(item["path"]).expanduser().resolve(strict=True)),
            frame_idx=int(item.get("frame_idx", 0)),
            strength=float(item.get("strength", 1)),
            crf=int(item.get("crf", 19)),
        )
        for item in request.get("images", [])
    ]
    tiling_config = TilingConfig.default()
    num_frames = int(request["num_frames"])
    frame_rate = float(request["frame_rate"])
    progress("generating", 15)
    video, audio = pipeline(
        prompt=str(request["prompt"]),
        seed=int(request["seed"]),
        height=int(request["height"]),
        width=int(request["width"]),
        num_frames=num_frames,
        frame_rate=frame_rate,
        images=images,
        tiling_config=tiling_config,
        enhance_prompt=bool(request.get("enhance_prompt", False)),
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    progress("encoding", 85)
    encode_video(
        video=video,
        fps=frame_rate,
        audio=audio if request.get("generate_audio", True) else None,
        output_path=str(args.output),
        video_chunks_number=get_video_chunks_number(num_frames, tiling_config),
    )
    progress("completed", 100)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001 - CLI must print the failure and exit nonzero.
        print(error, file=sys.stderr)
        raise SystemExit(1) from error
