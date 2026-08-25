---
title: "ADR 0003: plans, manifests, and receipts for interchange"
---

- **Status:** Accepted for the shipped adapters (verified 2026-08-25) — creative interchange
  `plan-import` → `import` and `plan-export` → `export` (Fountain, OTIO/OTIOZ, glTF/GLB, USD/USDZ;
  OBJ/STL export with SHA-256 file receipts) implement the plan/receipt runtime path
  (`frontend/director/src/agent/creativeWorkspaceSemanticOperations.ts` + import/export tests), and
  the Blender `.blend` import ships a server-persisted plan with guarded atomic apply. Adapter
  paths not listed here remain Proposed.
- **Decision owners:** Director interchange and DCC maintainers
- **Related:** `PIPELINE_SYSTEM_DESIGN.md`, `PIPELINE_IMPLEMENTATION_ROADMAP.md`

## Context

Director supports project JSON/archive, Fountain, OTIO/OTIOZ, glTF, USD/USDZ, and a
Blender package. The adapters validate formats, but the system needs one consistent
answer to four questions:

1. What will an import create, update, link, remap, or skip?
2. Against which source state is that plan safe to commit?
3. Which files did an export actually write and hash?
4. Which semantics were degraded or preserved only as metadata?

## Decision

Separate interchange into pure planning and effectful commit/write phases.

### Import

`probe → parse → normalize → ImportPlan → atomic commit → ImportReceipt`

An `ImportPlan` contains adapter/contract versions, source hash, target revision or
snapshot, creates/updates/links, ID remaps, media requirements, warnings, and blocking
conflicts. It is immutable and fingerprinted.

Commit rechecks the target guard and applies the complete plan as one undo unit. The
receipt records the before/after guards and changed IDs.

### Export

`validated state → ExportManifest → write → hash/verify → ExportReceipt`

The manifest declares intended artifacts and degradation warnings. The receipt lists
only files that were successfully written and verified.

## Consequences

### Positive

- UI and Agent can preview the same interchange operation.
- Stale imports fail before mutation.
- Partial binary writes cannot masquerade as successful exports.
- Round-trip loss is visible and fixture testable.
- DCC return packages reuse the normal import system.

### Costs

- Existing direct adapter functions need wrappers or refactoring.
- Import plans must be bounded to prevent huge UI/Agent payloads.
- Temporary files require cleanup when export verification fails.

## Rejected alternatives

1. **Mutate while parsing.** Rejected because errors leave partial state and cannot be
   reviewed.
2. **Warnings only in logs.** Rejected because callers and Agents need structured
   degradation data.
3. **A single generic JSON patch plan.** Rejected because media requirements,
   external IDs, and format-specific semantics need typed records.

## Acceptance

- Parsing is pure and cannot access editor stores.
- Every plan is schema validated, size limited, and target guarded.
- Commit is atomic and undoable where it mutates an editor.
- Export receipts contain source fingerprint, contract versions, paths, byte sizes,
  and hashes.
- Round-trip fixtures compare supported semantics and expected warnings.
