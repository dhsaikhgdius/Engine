# Director Godot 4 connector

Source-only editor plugin (`addons/director_bridge`) plus a fixed
`godot --headless --script` entry point that connects a licensed Godot 4.2+
installation (Godot 4.x only) to Director.

Godot 4's world basis (right-handed, Y-up, metres, camera forward -Z) matches
Director's canonical space exactly, so the provider-boundary conversion is the
identity map `(x, y, z) -> (x, y, z)`; it still runs through `director_space.gd`
so the boundary stays explicit and testable.

## What it does

- **Import** (`--mode import`): reads a `director-dcc-exchange-package-v1`
  directory and builds a saved scene under `res://director/scenes/` with:
  - one `Node3D` per Director object (instancing GLB payloads through
    `GLTFDocument`, which works headless) and one `Camera3D` per Director
    camera with optics, every node stamped with `director_id` metadata;
  - the restored Director parent hierarchy (locals rebuilt as
    `parent_world^-1 * child_world`, exact under negative scale and mirrored
    transforms) with cycle detection;
  - Director lights as `OmniLight3D` / `SpotLight3D` / `DirectionalLight3D`
    nodes with `director_id`; the first visible ambient/hemisphere light bakes
    into a `WorldEnvironment` ambient term (hemisphere flattens its sky/ground
    gradient with an approximation code); rect-area and duplicate ambient
    lights warn-and-omit with structured codes
    (`light_rect_area_unsupported`, `light_ambient_duplicate`);
  - glTF PBR payload materials as `StandardMaterial3D`, Director PBR
    overrides applied on top; unsupported channels (e.g. transmission) and
    custom `ShaderMaterial`s warn-and-omit;
  - embedded payload textures externalized to content-hashed
    `res://director/textures/` resources so the saved scene references
    relative hashed files;
  - `Skeleton3D` + skin from skinned GLB payloads, verified in bind pose and
    tagged with `director_id` on the skeleton root; characters without a
    usable skeleton warn-and-omit;
  - when the Gateway pinned an animation bake (`--animation` +
    `--animation-sha256`), an `AnimationPlayer`/`AnimationLibrary` on the
    scene root keyed from the hash-verified sidecar on the rational timebase
    (`seconds = frame * denominator / numerator`); glTF payload animations
    are preserved as their own AnimationPlayers;
  - storyboard shot ranges from the hash-pinned bake mapped onto discrete
    `Camera3D.current` cut tracks inside the timeline animation (playing it
    performs the storyboard's camera cuts), with the raw shots additionally
    preserved as `director_shots` metadata; shots without a mappable camera
    warn-and-omit with structured codes (`shot_no_camera_binding`,
    `shot_camera_not_imported`, `shot_target_not_camera`);
  - a `director-dcc-engine-report-v1` receipt with a Godot-specific `godot`
    block (track/key/shot-cut counts, light/skeleton/material/texture counts,
    `worldEnvironmentAmbient`, `omittedLightCount`) that is read back from the
    saved scene, plus an echoed canonical-space return package.
- **Export** (`--mode export`): reloads the Director scene and writes a
  `director-dcc-return-v1` package containing the canonical transforms of every
  `director_id`-tagged object/camera node that moved relative to the exchange
  baseline. Drift is measured at matrix level, so mirrored transforms round-trip
  without false positives; skeleton and light tags never produce changes.
- **Health** (`--mode health`): prints a JSON line with the engine and connector
  version, validated by the Gateway readiness probe.

## Install

1. Copy `addons/director_bridge` into `<YourProject>/addons/director_bridge`.
2. Enable **Director Bridge** in Project → Project Settings → Plugins.
3. Point the Director Gateway at your installation:

```bash
export DIRECTOR_GODOT_BIN=/path/to/godot4
export DIRECTOR_GODOT_PROJECT=/path/to/YourProject
```

`director_dcc {"op":"status","provider":"godot"}` reports `nativeReady: true` only
when all of these check out: the connector source, the Godot 4 executable, the
version probe, the installed addon, the enabled plugin entry in `project.godot`
(`[editor_plugins]`), and a valid `--mode health` JSON line whose connector
version matches the workspace. A `godot` binary on PATH alone is only ever
`installed`. Portable GLB exchange stays available either way.

## Headless invocation (what the Gateway runs)

```bash
"$DIRECTOR_GODOT_BIN" --headless --path "$DIRECTOR_GODOT_PROJECT" \
  --script res://addons/director_bridge/director_headless.gd -- \
  --mode import --package <package-dir> --report <job>/report.json \
  --return-dir <job>/return \
  --animation <job>/animation.json --animation-sha256 <hex>
```

The entry script is fixed; the Gateway never executes request-supplied GDScript.
The animation sidecar is hash-pinned: the connector recomputes the SHA-256 of
the bytes on disk and refuses a tampered or truncated bake. The run writes a
`director-dcc-engine-report-v1` receipt that the Gateway schema-validates and
cross-checks against the exchange package id and source revision.

All connector modules are referenced through `preload`, never global
`class_name` lookup: a fresh project that was never opened in the editor has no
global class cache, and the headless entry must work there.

## Live preview (outbound only)

The editor plugin's **Director: Toggle Live Preview** tool menu item streams
ephemeral, sequence-numbered preview frames of `director_id`-tagged nodes to
the Director Gateway's token-guarded live-link routes
(`director-godot-live-link-v1`: hello → frame… → bye). The transport is
strictly outbound — Godot never opens a listening port and never exposes a
scripting endpoint — and preview frames are never authoritative: durable
changes still travel only through the reviewed `director-dcc-return-v1`
package path. Stale or replayed sequence numbers are rejected by the Gateway,
and a dropped connection (missed bye) is swept by the Gateway's idle timeout
without touching the last committed Director revision. Configure the target
with `DIRECTOR_GATEWAY_URL` and `DIRECTOR_GATEWAY_TOKEN`.

## Capability honesty

Implemented and versioned (backed by host-free goldens plus a skip-if-missing
real headless roundtrip in `backend/gateway/tests/dcc/godot*.test.ts`): headless
import/export, stable `director_id` round trip, scene hierarchy including
negative scale and mirrored transforms, cameras with animated vertical fov,
Gateway-baked transform animation on a rational timebase, storyboard shot
ranges as `Camera3D.current` camera-cut tracks, skinned GLB skeletons in bind
pose, `StandardMaterial3D` translation with hashed external textures,
Omni/Spot/Directional lights plus a `WorldEnvironment` ambient bake, and the
outbound-only live preview link (sequence, replay, and disconnect goldens in
`backend/gateway/tests/dcc/godotLiveLink.test.ts`).

Still warn-and-omit, never silently flattened: rig pose channels and character
motion clips (only world transforms are baked — the bake carries structured
`omittedDetail` naming the affected pose controls and clips), rect-area
lights, duplicate ambient sources, and custom shader translation. Every
omission carries a structured code so agents can act on it instead of parsing
prose.
