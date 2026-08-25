---
title: White-box to Video
description: Package a validated Director shot and submit it to LTX-2.3 or a configurable ComfyUI workflow.
---

Director treats video generation as a downstream render stage. The 3D project remains the
source of truth for layout, scale, subject placement, lens, aspect, and camera motion.

## Agent sequence

1. Build or load a scene.
2. Validate the Stage scene.
3. Select and inspect the intended camera.
4. Capture a clean reference frame.
5. Export `director_workbench {"op":"shot_ir", ...}` for the exact camera/frame.
6. Export `shot_package` when the generator or compositor needs clean/depth/normal/object-ID/mask.
7. Call `stage_video prepare`.
8. Review the job manifest and retain the Shot IR `revisionFingerprint`.
9. Call `capabilities` to inspect the real provider state.
10. Call `render` or `submit`, poll with `status`, and use `cancel` when required.

Shot IR is provider-neutral. It records the evaluated objects, camera, target, real sensor
gate/crop, lens, exposure/focus metadata, aspect, motion intent, and portable references.
When `take_id` and `coverage_shot_id` are supplied, the pure production evaluator resolves
the shared take and the coverage-owned camera before building Shot IR. A provider adapter may
turn that contract into a prompt or workflow, but the generated prompt is never the scene truth.

## LTX-2.3 Python inference

:::caution[Experimental integration]
Gateway spawn tests pass, but this checkout does not yet have a verified local GPU output receipt.
Source validation accepts both a normal `.git` directory and a submodule/worktree `.git` file, then
verifies the pinned origin, commit, license blob, required packages, and clean tracked state. Do not
represent a prepared job or spawn test as a generated video; weights, a compatible CUDA environment,
and a stored real-inference receipt are still required.
:::

LTX-2.3 runs as a one-shot `uv` child of the Gateway: `tools/scripts/ltx23-generate.py` against
`vendor/ltx-2`. There is no resident FastAPI worker. The official distilled pipeline loads for that
job, writes `data/video-jobs/<id>/output.mp4`, and exits.

Director uses an untouched official source checkout, not a reimplementation or floating package. The upstream URL,
commit, package versions, LICENSE blob, and model revisions are pinned in
`vendor/ltx-2.lock.json`. Review the LTX-2 Community License before enabling it:

```bash
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
npm run setup:ltx2
```

`LTX2` here is the upstream LTX-2 family / license name. The Director provider id remains
`ltx-2.3`. They refer to the same experimental integration.

After downloading the pinned checkpoints, configure the TypeScript control plane:

```bash
export DIRECTOR_VIDEO_PROVIDER=ltx-2.3
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
export LTX23_DISTILLED_CHECKPOINT_PATH=/models/ltx-2.3/ltx-2.3-22b-distilled-1.1.safetensors
export LTX23_SPATIAL_UPSAMPLER_PATH=/models/ltx-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors
export LTX23_GEMMA_ROOT=/models/gemma-3-12b
```

The spawn independently enforces dimensions divisible by 64 and frame counts of `8k+1`.
`manifest.json` preserves both requested delivery framing and resolved inference framing, plus the
exact seed, audio flag, prompt-enhancement flag, scene digest, warnings, and provider receipt.

The current LTX adapter sends the clean reference frame. It does not yet consume Director's depth,
normal, object-ID, or mask passes. Those passes remain available in the control package for other or
future conditioning adapters.

## Optional ComfyUI provider

Export the workflow in ComfyUI API format and save it inside this repository:

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_VIDEO_WORKFLOW_PATH=workflows/director-video-api.json
```

## Workflow tokens

| Token                      | Replacement                                             |
| -------------------------- | ------------------------------------------------------- |
| `{{PROMPT}}`               | Positive render prompt                                  |
| `{{NEGATIVE_PROMPT}}`      | Negative prompt                                         |
| `{{REFERENCE_IMAGE}}`      | Director camera frame uploaded to ComfyUI input storage |
| `{{WIDTH}}`                | Output width                                            |
| `{{HEIGHT}}`               | Output height                                           |
| `{{FPS}}`                  | Output FPS                                              |
| `{{DURATION_SECONDS}}`     | Requested duration                                      |
| `{{SEED}}`                 | Deterministic seed                                      |
| `{{SCENE_STRUCTURE_JSON}}` | Compact object kinds, names, positions, and scales      |
| `{{CAMERA_PLAN_JSON}}`     | Lens, target, and ordered timeline actions              |

If a value is exactly one numeric token, substitution preserves the JSON number type.

## Prepare without spending credits

```bash
npm run stage -- stage_video '{
  "op": "prepare",
  "prompt": "Preserve the exact white-box composition and camera; cinematic rainy street at night",
  "duration_s": 5,
  "fps": 24
}'
```

`prepare` does not contact a model provider.

## Prepare and submit

```bash
npm run stage -- stage_video '{
  "op": "render",
  "prompt": "Preserve the exact white-box composition and camera; cinematic rainy street at night",
  "negative_prompt": "geometry drift, flicker, warped architecture",
  "duration_s": 5,
  "fps": 24
}'
```

## Poll a job

```bash
npm run stage -- stage_video '{"op":"status","job_id":"video-..."}'
```

Each job keeps:

```text
data/video-jobs/<job_id>/manifest.json
data/video-jobs/<job_id>/scene.json
data/video-jobs/<job_id>/<reference-frame>
```

The deterministic shot-package pipeline renders helper-free `clean`, packed `depth`,
view-space `normal`, and stable `object-id` RGBA passes through an off-screen WebGL target.
It restores renderer, scene, material, and helper state even after a GPU error. Browser PNG
encoding happens only after top-to-bottom pixel normalization. Package manifests omit binary
payloads, store SHA-256 for every real artifact, and derive a stable package fingerprint.

```json
{
  "op": "shot_package",
  "expected_revision": "director-project-revision:v1:sha256:...",
  "take_id": "take-main",
  "coverage_shot_id": "coverage-close",
  "frame": 48,
  "width": 1280,
  "height": 720,
  "render_passes": ["clean", "depth", "normal", "object-id", "mask"]
}
```

This is deterministic single-frame capture and packaging. For a complete timeline range, the
editor's **确定性帧包** performs sequential inclusive IN/OUT PNG capture, writes explicit
microsecond timestamps and durations, then stores per-frame SHA-256 hashes and a package
fingerprint in a deterministic ZIP. It is the appropriate white-box sequence handoff for a video
generator. A browser `MediaRecorder` recording is still available for quick review, but remains a
separate real-time, non-deterministic contract. Director produces a playable deterministic
MP4/WebM only when a real WebCodecs encoder and container muxer are configured; otherwise the
honest output remains the PNG ZIP.

## Review checklist

- The reference frame contains no editor helpers.
- The active camera, lens, and aspect are correct.
- Objects are grounded and have intentional scale.
- The IN/OUT range matches the requested duration.
- The negative prompt names likely failure modes.
- The final result is compared against the stored white-box reference.
