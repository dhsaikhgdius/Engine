---
title: Pipeline implementation roadmap
---

This roadmap turns the [pipeline system design](/engineering/pipeline_system_design/) into
incremental changes that can ship without replacing the current Stage, Canvas, Video,
or Agent stores in one migration.

## Delivery rules

1. Every milestone leaves legacy documents readable.
2. New IDs are additive before they become required.
3. Pure schema/projection code lands before store mutations or UI.
4. Import and external jobs produce a plan/receipt before they can modify state.
5. An Agent operation and recovery test are required for every user-facing mutation.
6. A migration is not complete until archive round-trip and refresh persistence pass.

## Milestone 0 — freeze the baseline

**Goal:** make later migrations measurable.

### Work

- Add fixture projects covering Stage assets, Mixamo motion, performance takes,
  coverage, Canvas lineage, Video tracks, proxies, offline media, review comments,
  and named versions.
- Record the current DirectorProject revision, creative snapshot fingerprint, OTIO
  output, Shot Package fingerprint, and DCC package for each fixture.
- Add a small contract-version registry so exported manifests do not scatter literal
  version strings across modules.
- Document which fields are canonical and which are compatibility projections.

### Acceptance

- Current project and creative fixtures load, migrate, save, reload, and compare
  structurally equal.
- Existing OTIO, USD, glTF, Shot Package, and DCC fixture tests stay unchanged.
- No UI or store behavior changes.

## Milestone 1 — ProductionGraph v1, read only

**Status:** Done (2026-08-25). Projector lives in `packages/project-schema/src/productionGraph/`; Agents observe via `director_workbench` field `production_graph`.

**Goal:** introduce cross-workspace identity without moving existing editor state.

### New modules

```text
frontend/director/src/comprehensive/editor/productionGraph/
  productionGraph.ts
  productionGraphSchema.ts
  productionGraphProjection.ts
  productionGraphIntegrity.ts
  productionGraph.test.ts
```

### Minimum schema

```ts
interface ProductionGraphV1 {
  version: 1;
  productionId: string;
  entities: {
    assets: ProductionAsset[];
    beats: ScriptBeat[];
    shots: ProductionShot[];
    takes: PerformanceTakeIdentity[];
    coverages: CoverageIdentity[];
    artifacts: ArtifactVersion[];
    usages: EditUsage[];
    reviews: ReviewDecision[];
  };
}
```

Graph records contain identity and lineage, not duplicate transforms, camera curves,
or clip effects. Those stay in DirectorProject and Creative workspace.

### Projection rules

- `DirectorAssetRef` projects to a `ProductionAsset` plus one source/runtime version.
- `scriptBeatId` projects Fountain/storyboard identity.
- Storyboard shot and coverage records point to one `ProductionShot` identity.
- Creative media and Stage assets may reference the same graph asset without sharing
  browser object URLs.
- Existing IDs are preserved when collision free; generated graph IDs are stable and
  namespaced.

### Acceptance

- Projection is deterministic and pure.
- Project + creative state produce the same graph after refresh.
- Duplicate byte hashes do not merge semantic assets automatically.
- Broken graph references are reported without blocking legacy project loading.

## Milestone 2 — persist graph IDs additively

**Status:** Done (2026-08-25). Identity maps persist additively on `DirectorProject.productionGraphIdentities`. Load (`migrateDirectorProject`) and JSON export (`serializeProject`) backfill missing IDs. The map is omitted from `director-project-revision` so background migration does not churn mutation guards or undo. Conflicting legacy mappings stay as receipts and do not rewrite source IDs.

**Goal:** allow editors to retain graph identity across changes.

### Work

- Add optional graph identity fields to Stage assets, storyboard/coverage records,
  Canvas nodes, media records, and Video clips.
- Migrate missing fields deterministically on load.
- Store the graph in the scene-scoped creative/archive envelope, not inside binary
  media records.
- Add a graph consistency audit and repair preview.

### Migration policy

1. Parse the legacy schema.
2. Migrate optional graph IDs.
3. Build/repair the graph projection.
4. Validate graph plus legacy cross-entity references.
5. Commit once and schedule persistence.

### Acceptance

- Old JSON and `.director.zip` imports gain IDs without losing data.
- Re-export and re-import preserve graph identities.
- Undo affects the user edit, not the background migration.
- Collaboration does not continuously regenerate different IDs on peers.

## Milestone 3 — durable ProductionJob state machine

**Goal:** use one execution contract for generation, DCC, proxy, and transcode work.

### Shared contract and server modules

```text
packages/protocol/src/
  productionJobProtocol.ts   # zod wire schema + pure transition rules
backend/gateway/jobs/
  productionJobStore.ts
  canvasPlaceholderArtifact.ts
  executors/
backend/gateway/routes/
  productionJobRoutes.ts
```

### State transitions

```text
queued → running → succeeded
  │         ├────→ failed
  │         ├────→ cancelled
  │         └────→ outcome-unknown → reconciling ──┬→ succeeded
  └─────────────────────────────────────────────────└→ failed
```

Only the service transitions state. UI and Agents issue requests such as enqueue,
cancel, retry, or reconcile.

### Idempotency

- `inputFingerprint` hashes normalized inputs and exact source revisions.
- Same idempotency key + same fingerprint replays the existing receipt.
- Same key + changed fingerprint fails.
- Retry creates a new attempt under the same logical job.
- Outcome-unknown must reconcile provider state before another paid request.

### Acceptance

- Refresh restores queued/running/final state.
- Cancellation is observable even when a provider cannot cancel remotely.
- A simulated timeout never causes an untracked duplicate request.
- Artifact hashes and logs survive executor failure.
- Agent, HTTP, and UI return the same normalized job receipt.

## Milestone 4 — immutable ArtifactVersion and promotion

**Goal:** stop treating a generated result as a mutable media card.

### Work

- Every successful job creates one or more immutable `ArtifactVersion` records.
- Record exact inputs, provider snapshot, seed/configuration, cost/usage when
  available, timestamps, byte hash, media metadata, and lineage edges.
- Add compare, promote, deprecate, and use-in-Canvas/Stage/Video operations.
- Promotion changes the preferred version pointer; it never deletes history.

### Acceptance

- Retry outputs remain comparable.
- Replacing a clip or Stage reference is one undoable operation.
- Deleting a graph node cannot delete an artifact still referenced by Video or a
  review decision.
- Archive export includes only reachable bytes plus required lineage metadata.

## Milestone 5 — ImportPlan and ExportReceipt

**Goal:** make every interchange mutation reviewable and recoverable.

### Import flow

```text
bytes → probe → parse → normalize → ImportPlan → preview warnings/conflicts
      → atomic commit → ImportReceipt
```

`ImportPlan` lists creates, updates, links, skipped semantics, ID remaps, media
requirements, and blocking conflicts. It is immutable and fingerprinted.

### Export flow

```text
validated state → ExportManifest → write artifacts → verify hashes → ExportReceipt
```

`ExportReceipt` records source revision, adapter/contract versions, artifact hashes,
warnings, and destination details.

### First adapters

1. Director JSON/archive.
2. OTIO/OTIOZ.
3. Fountain.
4. glTF/USD/USDZ.
5. Blender package.

### Acceptance

- Import never mutates during parsing.
- A stale plan cannot commit against changed state.
- Unsupported fields are visible in warnings or namespaced metadata.
- Failed binary write cannot produce a success receipt.
- Agent import/export uses the same plan and receipt as the UI.

## Milestone 6 — Blender return package

**Goal:** support controlled round-trip DCC work.

### Contract

`DccReturnPackage v1` contains:

- source DCC package ID and Director revision;
- stable Director entity IDs;
- changed transforms/cameras/animation curves;
- new or replaced asset versions and hashes;
- unsupported Blender feature warnings;
- optional helper-free preview;
- requested conflict policy.

### Work

- Blender exporter writes stable IDs into custom properties.
- Blender return script exports only recognized, changed entities.
- Director converts the return package into an `ImportPlan`.
- User or Agent reviews a structural diff before atomic commit.

### Acceptance

- Round-trip without changes is a no-op.
- Camera transform/lens round-trip stays within documented tolerances.
- Deleted or renamed Blender objects do not silently delete Director objects.
- A return against a stale Director revision requires explicit rebase or variant.

## Milestone 7 — Unreal/OpenUSD package

**Goal:** use Unreal's ecosystem without making UE the source of truth.

### Work

- Deterministic USD prim paths derived from stable Director IDs.
- CineCameraActor-compatible filmback, lens, aperture, focus, and clipping metadata.
- Level Sequence-compatible camera/object animation and timebase.
- Runtime GLB proxy relationship to source USD assets.
- UE import sidecar reporting created package paths, substitutions, and warnings.

### Acceptance

- Fixture camera and object transforms match in Director, USD inspection, and UE.
- 23.976/29.97/59.94 timebases retain exact rational rates.
- Unsupported materials/skeletons report explicit degradation.
- Package can be rebuilt deterministically without a live UE session.

## Milestone 8 — fingerprint-bound approval

**Status:** Done for live project revisions (2026-08-25). New `putApproval` writes require a `kind:project` fingerprint; project-bound approvals become stale when the observed director-project-revision changes. Creative/package/schema bindings remain optional extra fingerprints.

**Goal:** make review decisions durable production evidence.

### Work

- Extend review decisions with Stage revision, Creative fingerprint, artifact/package
  fingerprint, reviewer, status, and optional policy checklist.
- Mark approval stale when referenced state changes.
- Allow approval of a shot, artifact version, edit range, or final delivery.

### Acceptance

- Editing an approved shot never leaves the new revision shown as approved.
- Version restore also restores its review context without rewriting old decisions.
- Export receipt can list the exact approval record used for delivery.

## Milestone 9 — scale and operations

### Media

- Move proxy, waveform, thumbnail, and transcode work into cancellable jobs.
- Add local filesystem and object-storage artifact backends.
- Add reachability-based garbage collection with retention and legal-hold policies.

### Collaboration

- Add authenticated room membership and capability roles.
- Compact Yjs updates into validated server snapshots.
- Keep media transport outside CRDT updates.
- Add reconnect/rebase metrics and corrupt-update quarantine.

### Observability

- Structured logs share job, production, scene, target, and Agent session IDs.
- Trace every adapter with source/output fingerprint and duration.
- Expose audit, capture, provider, DCC, and media-worker health separately.

## Suggested implementation order by pull request

| PR  | Scope                                                     | Risk   |
| --- | --------------------------------------------------------- | ------ |
| 1   | Contract registry + frozen fixtures                       | Low    |
| 2   | Read-only ProductionGraph schema/projection/audit         | Low    |
| 3   | Optional graph IDs + migration + archive round-trip       | Medium |
| 4   | ProductionJob schema/repository/state machine             | Medium |
| 5   | Adapt existing video/image jobs behind the state machine  | High   |
| 6   | ArtifactVersion + promote/use operations                  | Medium |
| 7   | ImportPlan/Receipt framework, Director archive adapter    | Medium |
| 8   | OTIO/Fountain/glTF/USD adapters through plan/receipt      | Medium |
| 9   | Blender return package and atomic diff import             | High   |
| 10  | Unreal/OpenUSD package                                    | High   |
| 11  | Fingerprint-bound approvals                               | Medium |
| 12  | Worker/object-storage/collaboration operational hardening | High   |

Do not start with UI for these milestones. Land the versioned contract, pure
projection/state machine, fixtures, and failure tests first; the UI and Agent surface
should consume the same implementation.
