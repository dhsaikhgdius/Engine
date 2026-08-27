---
title: Product Constitution
description: The North Star, the ten principles, and the three admission questions that decide what ships in Director.
---

This page is the decision filter for Director. When a feature request, a refactor, or a roadmap
debate stalls, resolve it here. The [Golden Journey](/concepts/golden-journey/) shows what these
principles look like as a workflow; [Agent-native Production](/concepts/agent-native-production/)
defines the contracts they demand.

## North Star

**Director is a verified shot factory**: it turns creative intent into shots whose layout,
optics, and pixels are provably bound to one accepted project revision — for humans and agents
through the same project.

Everything else — the Stage, Canvas, Video Editor, generation pipelines, the Blender bridge, the
agent tools — exists to make producing the next verified shot cheaper, faster, or more trustworthy.

## Ten principles

1. **Verified over generated.** A shot is done when a delivery receipt binds audit, clean
   capture, and package hashes to one revision — not when a model returns pixels.
2. **One project, every surface.** The browser UI, MCP, HTTP, and CLI read and write the same
   `DirectorProject`. No shadow state, no agent-only or human-only features.
3. **Discover, never guess.** `capabilities` and `catalog` are the only vocabulary. Invented
   operations, asset IDs, or coordinates are bugs, not creativity.
4. **One intent, one atomic batch.** Every mutation carries a revision guard and an idempotency
   key. Either the whole intent commits as one undo unit or nothing changes.
5. **Cheap decisions first.** Layout, scale, lens, and continuity are fixed in the metric
   white-box, where a mistake costs seconds — never discovered after an expensive generation.
6. **Semantic operations over coordinates.** Place relative, orient toward, compose blocking.
   Screen-coordinate automation and guessed world positions are last resorts, not defaults.
7. **Real geometry only.** Scenes instance catalog meshes, Blender-authored geometry, or promoted
   generated-3D assets. White-box is a clay look, not a stack of Stage boxes.
8. **Deterministic checks before taste.** `audit` catches what a machine can catch; a human or
   critic judges a 35–65 mm clean capture. `audit.ready` is never visual acceptance.
9. **Receipts, not optimism.** Every operation and job reports what actually committed. A claim
   without a receipt, or a receipt without inspection, is not evidence.
10. **Reuse the ecosystem.** Official third-party projects stay vendored submodules, the agent
    harness is DeepSeek Harness, and vocabulary lives in ranked teaching channels — no in-tree
    forks, no second tool loop, no fifth prose channel.

## What we are / what we are not

**We are:**

- a production desk that carries one shot from intent to revision-bound visual evidence;
- an agent-native control plane where naive agents can author, verify, and repair safely;
- a white-box-to-generation pipeline that conditions video models on verified 3D framing;
- the project of record connecting Stage, Canvas, Video Editor, Gallery, and DCC handoff.

**We are not:**

- a prompt-to-video toy — generation without staged, auditable framing is out of scope;
- a game engine or a DCC replacement — Blender stays authoritative for native geometry, and
  engines receive exports rather than being reimplemented;
- a second agent harness — Director extends DeepSeek Harness with domain tools instead of
  forking a tool loop;
- an asset marketplace — the catalog exists to make shots verifiable, not to sell content.

## WorldEngine vs Director

- **WorldEngine** is the repository and platform: the Gateway, shared packages, pipelines,
  integrations, and vendored inference projects.
- **Director** is the browser product built on it: the production desk a human directs and an
  agent controls.

Use _Director_ for anything user-facing (UI copy, docs, tool names); use _WorldEngine_ only when
naming the repository or the platform layer. The [Glossary](/concepts/glossary/) keeps the
canonical one-line definitions.

## Three admission questions

Every new feature must answer yes to all three before it ships:

1. **Which golden-journey step does it strengthen?** Name the step (J1–J6) in the
   [Golden Journey](/concepts/golden-journey/). A feature that serves none of them does not ship.
2. **Can an agent drive it end to end?** It must be discoverable through `capabilities`,
   addressable through an exact target, guarded, idempotent, and observable — not UI-only and
   not agent-only.
3. **Does it produce evidence?** Its success must be checkable against a revision: a receipt, an
   audit, a diff, or a clean capture. If success cannot be verified, the feature is not done.

Decisions that change these answers are recorded as
[architecture decision records](/engineering/adr/); ADR 0005 records the adoption of this
constitution.
