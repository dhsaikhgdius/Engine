---
title: Procedural Modeling
description: Build deterministic, editable blocking patterns with shared human and Agent recipes.
---

Open **3D Stage → Model Library → Procedural Modeling**. Every parameter edit recomputes a read-only
output plan; the Stage changes only after **Apply to Stage**. One apply creates one undo entry and a
durable `proceduralRecipes` record containing the exact operation, source IDs, output IDs, seed where
applicable, timestamp, and limitations.

## Operations

| Operation         | Result                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Linear array      | Copies a prop or scene model by an exact XYZ offset.                                     |
| Radial array      | Copies around a bounded arc with preserved, inward, outward, or tangent orientation.     |
| Mirror            | Reflects a copy across X/Y/Z; optional negative scale preserves geometric handedness.    |
| Seeded scatter    | Places bounded copies in an area with deterministic yaw, height, and scale variation.    |
| Staircase         | Creates editable straight riser blocks or spiral treads with an optional support pillar. |
| Terrain           | Creates a seeded FBM primitive-cell height field, capped at 12 × 12 cells.               |
| L-system plant    | Creates a bounded primitive branch/foliage scaffold with deterministic branching.        |
| Fragment scaffold | Creates seeded blocking fragments and can atomically delete an unlocked source.          |

Each output receives an `action` reference binding to its recipe. Source-copy operations retain up to
31 prior bindings and append the procedural binding. Output is capped at 256 objects per operation.
Locked source deletion, invalid parent deletion, duplicate IDs, out-of-range parameters, and invalid
asset references reject the complete batch without a partial scene change.

## Agent parity

Workbench exposes the same `apply_procedural` authoring action. For example:

```jsonc
{
  "action": "apply_procedural", // apply one procedural recipe
  "recipe_id": "hero-crates-v1", // stable recipe id stored in proceduralRecipes
  "name": "Hero crate line", // display name in the editor
  "created_at": "2026-08-07T01:00:00.000Z", // creation time (ISO 8601)
  "operation": { // the procedural operation itself
    "kind": "linear-array", // linear array: copy by offset
    "sourceObjectId": "crate-hero", // source object to copy
    "copies": 5, // number of copies
    "offset": [1.5, 0, 0] // XYZ offset per copy, in metres
  }
}
```

The UI preview and Agent execution use the same validator and compiler rather than separate geometry
implementations.

## Supported boundary

Terrain and L-system output are editable primitive blocking, not welded final meshes. Fragment
scaffolds are not Voronoi booleans. Mirrored negative scale can be baked or rejected by downstream
formats. Production boolean operations, continuous terrain/vegetation meshes, materialized geometry
export, and high-volume instancing remain DCC/provider work and must keep visible loss reports.
