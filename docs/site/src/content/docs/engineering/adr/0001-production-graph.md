---
title: "ADR 0001: project-level ProductionGraph"
---

- **Status:** Accepted (read-only projector shipped 2026-08-25; editors remain authoritative for detailed state)
- **Decision owners:** Director architecture maintainers
- **Related:** `PIPELINE_SYSTEM_DESIGN.md`, `PIPELINE_IMPLEMENTATION_ROADMAP.md`

## Context

Stage, Canvas, Video, the media library, production records, collaboration, and
generation/DCC jobs each have useful local IDs. They do not yet share one durable
identity and lineage layer. As a result, “this generated character version is used by
this Stage object and these two Video clips” must be reconstructed from several
stores, and promotion or archive reachability is difficult to express.

Moving every detailed editor field into one global store would create a god model,
increase migration risk, and couple high-frequency UI state to production metadata.

## Decision

Add a versioned `ProductionGraph` that owns cross-workspace identity and lineage only.
Existing stores remain authoritative for detailed editing:

- DirectorProject owns metric scene, cameras, performance, and coverage.
- Creative workspace owns Canvas and Video editing state.
- Persistent media store owns bytes and decoded derivatives.
- Yjs owns shared state, awareness, review comments, and versions.

These models reference graph IDs. Pure projectors build and audit the graph from
legacy state during migration.

## Initial entities

- production asset and immutable asset version;
- source/derivative relationship;
- screenplay beat;
- shot intent;
- performance take identity and camera coverage identity;
- generated/rendered artifact version;
- editorial usage;
- review/approval decision.

## Consequences

### Positive

- One lineage query spans Canvas, Stage, Video, DCC, and provider outputs.
- Promotion and version comparison no longer overwrite history.
- Archive garbage collection can follow reachability.
- Agent tools can use stable semantic IDs across workspaces.

### Costs

- Temporary dual references during migration.
- New consistency audits and repair tooling.
- Collaboration and archive schemas must preserve graph identity.

## Rejected alternatives

1. **Use DirectorProject for everything.** Rejected because editorial clips, provider
   jobs, and media derivatives do not belong in the metric scene model.
2. **Use Yjs as the canonical database.** Rejected because CRDT representation is a
   synchronization implementation, not a portable production contract.
3. **Infer lineage from hashes only.** Rejected because identical bytes can represent
   different semantic assets or rights contexts.

## Compatibility

Graph IDs begin optional. Legacy import deterministically creates them; exports retain
legacy fields during a transition version. Missing graph links initially warn rather
than block editing.

## Acceptance

- Deterministic pure projection from frozen legacy fixtures.
- Stable IDs survive save/reload, collaboration, and archive round-trip.
- No automatic semantic merge on hash or localized name.
- Graph corruption cannot replace validated Stage or Creative state.
