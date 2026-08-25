---
title: Persistence & Sync
description: Understand browser snapshots, gateway files, revisions, and Agent session storage.
---

Director uses separate stores for editor state, compact Stage state, production metadata, and
Agent sessions.

## Browser editor state

The complete editor snapshot is stored under:

```text
storyai-3d-director-desk-demo
storyai-3d-director-desk-demo:<instanceId>
```

An `instanceId` query parameter scopes independent embedded workspaces.

Project persistence is debounced by 1000 ms. A pending snapshot is flushed on `pagehide`.
Direct project replacement and other boundary operations can request an immediate write.

Canvas and Video Editor use a separate version 2 scene-scoped envelope. Their nodes, edges, tracks,
clips, settings, and playhead are persisted per creative scope; imported media bytes are deduplicated
in IndexedDB. Switching tabs does not make another visible workspace an acceptable Agent target.
Each browser connection announces a client, instance, scene, and creative-scope identity, and the
gateway binds later Workbench/Creative calls to an opaque token for that exact tuple.

## Local model library

Local model metadata uses:

```text
storyai-3d-director-local-model-library
```

Browser quota failures do not make the current editor session unusable. Large source files
should still be managed as project assets instead of assuming unlimited browser storage.

## UI preferences

Examples:

| Key                                | Purpose                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| `director.ui.locale`               | Interface language                                            |
| `director.performance.profile`     | Legacy preference key; Director normalizes it to High quality |
| session-scoped camera overlay keys | Draggable camera panel positions                              |
| session-scoped thumbnail keys      | Scene/camera thumbnail cache                                  |

## Gateway data

| Path                                   | Content                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------- |
| `data/stage-scene.json`                | Validated StageScene v5                                                            |
| `data/director-workbench.json`         | Complete gateway-side workbench project                                            |
| `data/director-production-state.json`  | Production manifest plus validated, revisioned per-scene DirectorProject documents |
| `data/latest-preview.png`              | Most recent capture                                                                |
| `data/director-agent-plan.schema.json` | Generated legacy plan schema                                                       |
| `data/director-agent-sessions.sqlite`  | Durable Agent sessions and events                                                  |

## Synchronization

The gateway broadcasts validated project changes only to compatible workbench peers in the same
scene and creative scope. Revisions, snapshot fingerprints, exact target tokens, schema parsing, and
graph checks prevent malformed, stale, or cross-project updates from silently replacing valid work.

Scene-project autosave is serialized and revision guarded. A stale browser never overwrites the
server document: it re-observes the remote revision, accepts an exact-content replay, and otherwise
surfaces a conflict. A legacy `data/director-production.json` is a one-time migration input only.

## Commit policy

Do not commit generated runtime state by default:

- SQLite session files and WAL artifacts;
- captures and previews;
- prepared video jobs;
- temporary image-model jobs;
- browser-local snapshots.

Commit source assets, intentional fixtures, documentation, and reproducible configuration.
