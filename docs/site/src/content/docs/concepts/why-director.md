---
title: Why Director
description: The problem Director solves and where its boundary sits against Runway, Unreal, Cursor, and Blender.
---

## The problem

AI video generation produces beautiful frames but takes no direction: layout, lens, and
continuity change on every roll, so teams burn budget re-prompting instead of directing. 3D
tools give full control but no contract an agent can trust — no discoverable vocabulary, no
guarded mutations, no revision-bound evidence that a shot is actually right. The result is a gap
between "I can describe the shot" and "I can prove the shot": humans click through opaque UIs,
agents hallucinate IDs and coordinates, and nobody can say which pixels correspond to which
accepted state.

Director closes that gap. A human directs scenes visually in the browser while agents inspect
and change the same project through typed MCP, HTTP, and CLI surfaces. Composition is fixed in a
metric white-box where mistakes cost seconds, verified by deterministic audits and clean
captures, and only then handed to generation — so every delivered shot carries evidence bound to
one project revision.

## Where the boundary sits

- **vs Runway** — Runway generates a shot from a prompt and hopes; Director stages layout, lens,
  and continuity in verifiable 3D first, then conditions generation on that framing.
- **vs Unreal** — Unreal is a real-time engine you build worlds inside at engine depth; Director
  is a production desk that stays at shot level and exports to engines through DCC handoff
  rather than replacing them.
- **vs Cursor** — Cursor makes agents first-class in a codebase; Director applies the same
  discipline — discovery, guarded atomic edits, verifiable results — to a film project instead
  of source files.
- **vs Blender** — Blender authors geometry and stays authoritative for native meshes through
  Director's live bridge; Director owns the production semantics around it: cameras, takes,
  coverage, audits, and delivery.

## Where to go next

The rules that keep these boundaries stable — the North Star, the ten principles, and the three
admission questions for new features — live in the
[Product Constitution](/concepts/product-constitution/). To see the workflow they produce,
follow the [Golden Journey](/concepts/golden-journey/).
