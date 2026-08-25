---
title: Agent-native 3D Stage replication spec
---

> Historical clean-room Stage baseline. The current complete product contract—including Canvas,
> Video Editor, exact-target Agent binding, idempotency, evidence delivery, and DCC handoff—is
> documented in `docs/site/src/content/docs/` and summarized in the repository `README.md`. The
> canonical Codex/Claude operating and recovery loop is
> `docs/site/src/content/docs/engineering/AGENT_NATIVE_OPERATOR_GUIDE.md`.

## Clean-room boundary

This implementation is based on the public rendered interface, public network assets,
and behavioral observation of the production JavaScript bundle. It does not copy the
production source tree or require private APIs. The reference app remains the visual
and behavioral authority; our implementation is original code.

## Reference screen

- Desktop reference viewport: 3440 × 1440.
- App header: 34 px, white, square 1 px dividers.
- Scene strip: 49 px.
- Bottom show/timeline dock: approximately 238 px.
- Stage inspector: approximately 220 px.
- Agent conversation rail: approximately 360 px.
- 3D viewport background: `#373a40`.
- Ground material: `#484c52`.
- Grid major/minor colors: `#848891` / `#4f535a`.
- Timeline action: blue; recording: muted red; app chrome: true white.
- Primary UI fonts: Jost/Rosario-like narrow sans, with deliberate 11–13 px chrome text.

External behavior reference: the public
[Flick 3D Stage](https://flick.art/canvas/dc024bd1-d1bb-43ee-b131-74d811fa10ca?view=stage).
The third-party screenshot used during local review is deliberately excluded from the source
repository; it is evidence, not a redistributable Director asset.

## Scene model

The public bundle currently uses schema version 5:

```ts
type StageScene = {
  v: 5;
  objects: Record<string, StageObject>;
  show: { name: string; tracks: StageTrack[] };
  recordAspect: "16:9" | "9:16" | "1:1";
};
```

Default scene:

- Humanoid at `[-0.4202181122, 0, -1.1049523828]`, idle.
- Camera target at `[-0.4202181122, 1.4046224310, -1.1049523828]`.
- Camera at `[-0.8428234049, 1.6756546447, 0.6750296045]`, 35 mm, shake off.
- One camera track with a `cam-move` item at 0 s, duration 5 s, orbit,
  counter-clockwise, 360°, zero height delta, distance scale 1.

Object kinds supported by the clean-room runtime: humanoid, camera, target, cube,
sphere, prop, and group.

Show item kinds supported: camera move/still/path/follow/transform/manual, object
transform keyframes, humanoid clip, and humanoid path.

## Runtime architecture

1. Versioned scene JSON is the source of truth.
2. A deterministic store owns objects, selection, mode, timeline, playback, undo/redo,
   and serialization.
3. Three.js renders a perspective camera (50° FOV), a 4000-unit ground plane, a
   200-unit grid with 100 divisions, scene objects, camera frusta, and transform gizmos.
4. Orbit/navigation, selection, transforms, playback, camera actions, focus animation,
   and capture run as separated systems in the render loop.
5. Local persistence is debounced by 1000 ms. The Agent gateway mirrors the latest
   scene and can continue operating headlessly.

## Agent protocol

The compact Stage compatibility surface exposes `stage_read`, `stage_scene`, `stage_object`,
`stage_camera`, and `stage_show`, each accepting one operation or an ordered `ops` batch. A create
operation may include `ref`, and later operations in the same batch can use that alias instead of
the generated id. Full-editor integrations should prefer `director_workbench`; Canvas and Video
Editor integrations use `director_creative`.

### `stage_read`

- `observe` returns a compact Agent perception snapshot.
- `inspect` returns exact state and relationships for one object id.
- `critique` returns deterministic camera-space framing issues and suggested corrections.
- `scene_state`
- `help`
- `search_props` (`query` required)
- `look_at_scene`

MCP responses expose a stable structured feedback envelope with the result, readable
error, changed entity ids, compact scene readiness hints, relevant object/track
context, visible ref aliases, and UI events. A successful `look_at_scene` response
also includes the captured frame as a native MCP image content block.

### `director_workbench`

The complete-editor MCP surface controls the validated DirectorProject and editor UI,
including assets, object/reference bindings, character and crowd state, cameras,
timeline animation, storyboard, selection, viewport, playback, undo, and capture.
`patch` uses safe JSON Pointer operations rooted at `/project` or `/ui`; a batch is
validated and committed as one undoable edit or rejected without partial mutation.

The preferred loop is selective `observe → author → deliver`. Mutations use project revision and
idempotency guards. Capture, Shot Package, and delivery require the observed revision so stale
evidence is rejected before pixels are captured.

### `director_creative`

The live Canvas/Video contract exposes capabilities, observation, single execution, atomic
`execute_batch`, production audit, and fingerprint-bound clean PNG preview. Mutations require the
observed snapshot fingerprint and an idempotency key; created IDs can be saved and reused as
`@alias`. A failed batch restores the complete pre-intent workspace, and the gateway never
redirects a bound operation to another tab. Preview checks the fingerprint before and after render
and does not move the Video playhead.

### `stage_object`

- `create` (`kind` required)
- `transform` (`object_id` required)
- `translate` (`object_id`, `delta`)
- `update` (`object_id`)
- `delete` (`object_ids`)
- `group` (`object_ids`)
- `place` (`object_id`, `on`)

### `stage_camera`

- `add`
- `set_shot` (`object_id`; lens and shake)
- `set_target` (`object_id`, `position`)
- `frame` (`shot`)

### `stage_show`

- `add_track` (`object_id`)
- `add_transform_item` (`track_id`)
- `add_keyframe` (`track_id`, `item_id`, `time_s`, `position`, `rotation`, `scale`)
- `add_clip` (`track_id`, `clip`)
- `add_camera_action` (`track_id`, `action`)
- `set_camera_action` (`track_id`, `item_id`)
- `add_path` (`track_id`, `points`)
- `remove_item` (`track_id`, `item_id`)
- `remove_track` (`track_id`)
- `play`

## Provider-neutral control surfaces

- MCP stdio server for Codex, Claude, and any MCP-compatible agent.
- JSON HTTP gateway for remote/local agents.
- CLI wrapper for shell-capable agents such as Codex and Claude Code.
- In-browser `window.stageAgent` API for UI automation and debugging.

## Fidelity lock

The following are required and may not be redesigned:

- Thin white app chrome and square controls.
- Centered three-view switcher.
- Large graphite 3D viewport with a fine ground grid.
- Right hierarchy/component rail plus far-right Agent conversation rail.
- Bottom camera timeline with blue orbit clip, rehearsal, recording, ruler, and track.
- Compact desktop-editor density and code-native Chinese labels.

## Visual fidelity ledger

Compared against the public Flick 3D Stage at 1800 × 900 after the browser implementation pass.
No third-party screenshot is shipped with Director:

| Area            | Reference lock                                                                       | Implemented result                                                                                |
| --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Chrome          | 34 px header, 49 px scene strip, white square-divided UI                             | Matched dimensions, dividers, centered view switcher, scene tab, share/credits/avatar cluster     |
| Workspace split | Large stage, 220 px hierarchy rail, 360 px Agent rail                                | Matched three-column desktop composition; compact breakpoints reduce rail widths without overflow |
| 3D stage        | Graphite horizon, fine perspective grid, ochre figure, black camera and teal frustum | Recreated with live Three.js geometry, lighting, shadows, camera frustum and transform gizmos     |
| Inspector       | Scene/camera/components tabs, search, selected hierarchy row                         | Matched tab density, selection treatment, add/delete controls and searchable prop catalog         |
| Agent rail      | Welcome copy, four two-column visual prompts, bottom composer                        | Matched structure and spacing; status row additionally exposes MCP/HTTP/CLI connectivity          |
| Timeline        | 42 px toolbar, half-second ruler, blue five-second orbit clip, red record control    | Matched visual rhythm and implemented actual playback, scrubbing and track mutation               |

Intentional clean-room differences are limited to the `Director` brand, an original
procedural mannequin instead of Flick's character asset, Lucide control glyphs, and
the explicit agent-native connection indicator. A mobile layout stacks the Stage and
Agent rail while retaining a horizontally scrollable timeline; it is an extension of
the desktop reference rather than a redesign of that reference.
