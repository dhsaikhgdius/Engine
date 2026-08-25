---
title: Director documentation map
---

This section is for contributors and maintainers: ADRs, roadmaps, reuse ledgers, and
implementation contracts. New users should start at [Getting Started](/getting-started/)
instead. The pages stay public so schema and license decisions remain inspectable; they
are not the operator onboarding path.

This section contains the engineering and product contracts behind Director. It lives
inside the same documentation site as the operator-facing guides, while remaining the
canonical record for changes to schemas, pipelines, or external contracts.

## Status vocabulary

Every architecture document should distinguish these states explicitly:

- **Implemented** — present in source, covered by tests, and available through a
  user or Agent control surface.
- **Partial** — the core contract exists, but an important production or recovery
  path remains incomplete.
- **Proposed** — a design target, not a promise about the current runtime.

Do not describe a proposed integration as shipped merely because a file format or
UI control exists.

## Start here

| Document                                                                       | Purpose                                                                                                               |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| [Pipeline system design](/engineering/pipeline_system_design/)                 | Canonical end-to-end production pipeline, system boundaries, invariants, stage gates, and prioritized evolution plan. |
| [Implementation roadmap](/engineering/pipeline_implementation_roadmap/)        | Incremental milestones, module boundaries, migrations, acceptance checks, and suggested pull-request order.           |
| [Architecture decisions](/engineering/adr/)                                    | Architecture decisions for ProductionGraph, durable jobs, and interchange receipts.                                   |
| [Agent runtime kernel](/engineering/architecture/agent-runtime-kernel/)        | One event, inbox, run-ownership, and tool-execution kernel shared by every Agent provider.                            |
| [Creative production parity](/engineering/creative-production-parity/)         | Product-level completion gates and recovery journeys.                                                                 |
| [Agent-native operator guide](/engineering/agent_native_operator_guide/)       | Provider-neutral Agent operating loop, concurrency guards, retries, and evidence requirements.                        |
| [Agent-native roadmap](/engineering/agent_native_roadmap/)                     | Phased plan for UI/agent parity, unified governance, workspace, observability, and team readiness.                    |
| [Replication spec](/engineering/replication_spec/)                             | Compact Stage compatibility contract and runtime behavior.                                                            |
| [Competitive union architecture](/engineering/competitive_union_architecture/) | Capability union studied from related previs and filmmaking systems.                                                  |

## Pipeline references

| Document                                                                            | Scope                                                                                                                                   |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [Character assets & motion](/engineering/character_asset_motion_pipeline/)          | Character sourcing, normalization, rigs, retargeting, motion layers, and licensing.                                                     |
| [White-box to video](/engineering/video_gen_pipeline/)                              | Current white-box-to-video job contract and ComfyUI adapter.                                                                            |
| [Native Blender backend and file interchange](/engineering/blender_bridge/) | Bound live-scene ownership, Director root synchronization, native Mesh/Rig editing, plus optional `.blend` import and stable-ID return. |
| [Multi-DCC integration](/engineering/multi_dcc_integration/)                        | Canonical IR, provider capabilities, portable exchange, native adapter maturity, and rollout order.                                     |
| [Reference reuse ledger](/engineering/reference_reuse_ledger/)                      | Source reuse, license, revision, and clean-room decisions.                                                                              |

## Research and release evidence

| Document                                                 | Scope                                               |
| -------------------------------------------------------- | --------------------------------------------------- |
| [Research portal](/engineering/research_portal/)         | Public research portal behavior and release policy. |
| [Third-party notices](/engineering/third_party_notices/) | Third-party source and asset notices.               |

## Documentation rules

1. Describe the source of truth before describing a UI.
2. Name the versioned schema or contract carried across each boundary.
3. State units, coordinate system, timebase, identity, and binary-ownership rules.
4. Separate structural validation, semantic validation, visual review, and delivery.
5. Include failure and recovery behavior, not only the happy path.
6. Prefer links to tests and source modules over screenshots for engineering claims.
7. When a contract changes, update the canonical engineering document and the
   matching operator-facing page in the same change.
