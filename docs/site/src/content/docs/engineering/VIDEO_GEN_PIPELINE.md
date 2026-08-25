---
title: Director white-box → video generation
---

Director treats video generation as a downstream render stage. The 3D editor remains
the source of truth for layout, scale, subject placement, lens, aspect, and camera
motion; the video model supplies appearance and temporal detail.

## Agent sequence

1. `stage_scene reset` creates an empty named scene, optionally with a main camera.
2. `stage_object`, `stage_camera`, and `stage_show` build the white-box and timeline.
3. `stage_scene validate` blocks unusable jobs such as an empty scene or missing camera.
4. `stage_read look_at_scene` switches to the requested camera and captures the rendered frame.
5. `stage_video prepare` writes a portable job without contacting a model provider.
6. `stage_video capabilities` discovers the configured LTX-2.3 or ComfyUI provider.
7. `stage_video render` or `submit` sends the immutable request to that provider.
8. `stage_video status` refreshes normalized job progress and outputs; `cancel` requests cancellation.

## LTX-2.3

The Gateway spawns `tools/scripts/ltx23-generate.py` against `vendor/ltx-2`. There is no resident
FastAPI worker. Director and the spawn both validate LTX constraints: dimensions are multiples of 64
and frame count is `8k+1`. Requested delivery framing and the resolved inference shape are stored
separately in `manifest.json`. The MP4 is written to `data/video-jobs/<id>/output.mp4`.

Director executes the untouched official source checkout rather than a reimplemented or floating package. The upstream
URL, commit, package versions, LICENSE blob, and model revisions are pinned in
`vendor/ltx-2.lock.json`. After reviewing the Community License, run:

```bash
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
npm run setup:ltx2
```

```bash
export DIRECTOR_VIDEO_PROVIDER=ltx-2.3
export DIRECTOR_ACCEPT_LTX2_LICENSE=1
export LTX23_DISTILLED_CHECKPOINT_PATH=/models/ltx-2.3/ltx-2.3-22b-distilled-1.1.safetensors
export LTX23_SPATIAL_UPSAMPLER_PATH=/models/ltx-2.3/ltx-2.3-spatial-upscaler-x2-1.1.safetensors
export LTX23_GEMMA_ROOT=/models/gemma-3-12b
```
```

## Optional ComfyUI workflow contract

Export the target workflow in ComfyUI API format and save it inside this repository.
Set these environment variables before starting the gateway:

```bash
export COMFYUI_URL=http://127.0.0.1:8188
export COMFYUI_VIDEO_WORKFLOW_PATH=workflows/director-video-api.json
```

Any string value in the workflow may contain these tokens:

| Token                      | Replacement                                                 |
| -------------------------- | ----------------------------------------------------------- |
| `{{PROMPT}}`               | Positive render prompt                                      |
| `{{NEGATIVE_PROMPT}}`      | Negative prompt                                             |
| `{{REFERENCE_IMAGE}}`      | Uploaded Director camera frame in ComfyUI input storage     |
| `{{WIDTH}}`                | Output width                                                |
| `{{HEIGHT}}`               | Output height                                               |
| `{{FPS}}`                  | Output FPS                                                  |
| `{{DURATION_SECONDS}}`     | Requested duration                                          |
| `{{SEED}}`                 | Deterministic seed                                          |
| `{{SCENE_STRUCTURE_JSON}}` | Compact object kinds, names, positions, and scales          |
| `{{CAMERA_PLAN_JSON}}`     | Lens, target, and ordered timeline actions for every camera |

If a value is exactly one token, numeric tokens remain JSON numbers. Tokens embedded
inside a larger string are substituted as text.

## Example calls

Prepare only:

```bash
npm run stage -- stage_video '{"op":"prepare","prompt":"Preserve the exact white-box composition and camera; cinematic rainy street at night","duration_s":5,"fps":24}'
```

Prepare and submit:

```bash
npm run stage -- stage_video '{"op":"render","prompt":"Preserve the exact white-box composition and camera; cinematic rainy street at night","negative_prompt":"geometry drift, flicker, warped architecture","duration_s":5,"fps":24}'
```

Poll:

```bash
npm run stage -- stage_video '{"op":"status","job_id":"video-..."}'
```

Each job remains inspectable under `data/video-jobs/<job_id>/`, including
`manifest.json`, `scene.json`, and the captured reference image.
