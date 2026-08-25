---
title: Control Plane and Python Workers
description: Understand the browser, TypeScript control plane, Agent harness, and Python inference boundaries.
---

Director runs production work across three explicit planes:

```text
Browser execution plane
  React/R3F, 3D Stage, Canvas, Video Editor, clean-frame capture
        │ authenticated HTTP / WebSocket + exact browser target
TypeScript control plane
  gateway auth, Agent sessions, API Harness, multi-agent runs,
  role policy, manifests, provider adapters
        │ spawn official Python CLIs / provider HTTP
Official model sources (`vendor/`)
  LTX-2 DistilledPipeline, Hunyuan3D, TRELLIS, ARDY
```

## Browser execution plane

The browser owns React state, WebGL, browser media, and any operation that must be applied to the
live tab or verified from rendered pixels. `frontend/director/src/comprehensive/editor/api` is the only frontend
transport boundary for control-plane requests. A target binds a request to one tab, Director
instance, scene, creative scope, and protocol version; stale targets fail closed.

The browser does not receive Agent API keys. It sends a short-lived
gateway capability obtained during bootstrap.

## TypeScript control plane

The Node Gateway under `backend/gateway/` owns authentication, configuration, session persistence, role
policy, multi-agent orchestration, video manifests, and provider adapters. It does not load model
weights. The API Harness resolves a server-owned Profile and uses either native OpenAI, native
Anthropic Messages, or an OpenAI-compatible Model Driver. One canonical tool loop validates calls,
applies role policy, executes Director tools against the exact target, and persists redacted,
provider-neutral conversation events.

The production graph is a durable, currently serial DAG:

```text
showrunner → screenwriter → continuity-supervisor → shot-planner
  → stage-director → cinematographer → visual-critic
  → repair-operator → visual-critic → generation-operator → editor
```

Each role receives structured upstream artifacts, creates its own Agent Session with a durable
role-specific Profile, and emits a hash-addressed artifact. The second Critic is the repair
acceptance pass. Resume preserves succeeded nodes and their pinned Profiles; cancel waits for background cleanup.
Read-only roles cannot call scene mutation or video-generation tools. The `generation-operator`
role can call `stage_video` but not unrelated scene mutation tools.

## Official model sources

The Gateway spawns `tools/scripts/ltx23-generate.py` against `vendor/ltx-2` for one DistilledPipeline
job at a time. There is no resident FastAPI worker. LTX dimensions are multiples of 64 and frame
counts satisfy `8k+1`. Director stores requested delivery dimensions separately from resolved
inference dimensions, along with the seed, audio flag, prompt-enhancement flag, scene digest,
warnings, and provider receipt. The MP4 lands next to the job manifest under `data/video-jobs/`.

## Persistence and recovery

| State                      | Owner                    | Location                              |
| -------------------------- | ------------------------ | ------------------------------------- |
| Agent sessions/events      | TypeScript control plane | `data/director-agent-sessions.sqlite` |
| Multi-agent runs/artifacts | TypeScript control plane | `data/multi-agent-runs/`              |
| Director video manifests   | TypeScript control plane | `data/video-jobs/`                    |
| LTX-2.3 MP4 output         | Gateway spawn            | `data/video-jobs/<id>/output.mp4`     |

See the full [control-plane architecture record](/engineering/architecture/control-plane/)
for the complete endpoint, environment-variable, and extension contract.
