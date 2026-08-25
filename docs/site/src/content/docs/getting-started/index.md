---
title: Getting Started
description: The practical path from a fresh checkout to a verified Director scene.
---

Director is a browser-based 3D production desk with an Agent control plane. A human blocks a
scene visually; an Agent inspects and changes the same project through typed contracts; both
finish with rendered, verifiable evidence instead of an unverified "command succeeded".

This section is the shortest path from a fresh checkout to that first verified scene.

## Prerequisites

Confirm the environment on [Install & Run](/getting-started/install/#requirements) before the first
`npm install`: Node.js 22 LTS, npm 10+, a WebGL 2 browser, and optional Blender 4.2+ only if you
need the integrated Blender backend.

## Recommended path

1. [Install and run Director](/getting-started/install/) — `npm install`, then `npm run dev`.
2. Open the editor at <http://127.0.0.1:5175> and confirm the gateway health check at
   <http://127.0.0.1:8787/health> responds.
3. Build the [Quick Start](/getting-started/quick-start/) scene, in the editor or over the CLI.
4. Continue with the track that matches your goal below.

## Services

`npm run dev` starts the two processes a first scene needs: the **editor you operate** on
port `5175`, and the **Agent gateway** on port `8787`. Open the UI in a browser; use `8787`
only for health checks, HTTP, MCP, and CLI. The documentation site on `4321` is separate and
starts with `npm run docs:dev`.

| Service       | Default address                | Purpose                                                           |
| ------------- | ------------------------------ | ----------------------------------------------------------------- |
| Director UI   | `http://127.0.0.1:5175`        | Complete 3D editor, Agent workbench, and Blender integration |
| Agent gateway | `http://127.0.0.1:8787`        | HTTP, WebSocket, capture, production, and Agent APIs              |
| Health check  | `http://127.0.0.1:8787/health` | Gateway availability                                              |
| Documentation | `http://127.0.0.1:4321`        | This site, started separately with `npm run docs:dev`             |

## Choose your track

- **I operate the editor by hand.** Read the [3D Editor overview](/editor/), then
  [Scenes & Assets](/editor/scenes-and-assets/) and [Characters](/editor/characters/).
- **I connect an Agent.** Read [Agent-native Production](/concepts/agent-native-production/)
  for the model, then [Agent Control](/agents/) for the concrete interfaces.
- **I want a complete worked example.** Follow the
  [End-to-end Verified Shot](/tutorials/verified-shot/) tutorial.

Terms such as _white-box_, _clean capture_, and _revision guard_ are defined once in the
[Glossary](/concepts/glossary/) and used consistently across the documentation.

The underlying document model — `DirectorProject`, the compact `StageScene` projection, and the
Blender binding — is described in [Data Models](/architecture/data-models/). You do not need
it to complete the quick start.
