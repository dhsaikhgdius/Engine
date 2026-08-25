# WorldEngine Synthetic Data Engine

## What This Is

WorldEngine is evolving from an Agent-native 3D/video production system into a synthetic-first data engine for training interactive video world models in the direction of LingBot-World, 4D video generation, and agentic video generation. It will turn controllable 3D worlds into versioned, reproducible, action-conditioned 4D episodes containing synchronized video, camera motion, entity actions, explicit state, and privileged geometric supervision.

The first release serves the internal model team while keeping its contracts and outputs suitable for external researchers and teams. It targets a formal 10–100 hour dataset release across diverse interactive worlds rather than an industrial-scale generation fleet.

## Core Value

Turn controllable 3D worlds into reproducible, training-ready action-conditioned 4D datasets with explicit state and trustworthy provenance.

## Requirements

### Validated

- ✓ Structured scenes, cameras, characters, animation, storyboards, and timelines are represented by versioned `DirectorProject` and `StageScene` documents — existing
- ✓ Agents can inspect and mutate scenes through typed MCP, HTTP, CLI, and browser contracts with revision and idempotency guards — existing
- ✓ The browser can render clean visual evidence and privileged passes including depth, normals, object IDs, and masks — existing
- ✓ Production runs, generation jobs, artifacts, hashes, approvals, and revision-bound receipts have durable control-plane representations — existing
- ✓ LTX-2.3 preprocessing, captioning, latent encoding, inference, and fine-tuning components are available as an isolated Python/CUDA subsystem — existing
- ✓ Assets have catalogs, checksums, source/license metadata, and a version-pinned restoration contract — existing
- ✓ Blender interchange and provider-neutral video generation boundaries already exist — existing

### Active

- [ ] Define a canonical, versioned dataset schema for action-conditioned 4D episodes, frames, sensors, actions, state, annotations, provenance, and quality results
- [ ] Parameterize interactive worlds and generate deterministic rollouts covering both camera control and entity interaction
- [ ] Capture synchronized RGB, camera, action, state, depth, normals, optical flow, segmentation, object IDs, skeletons, and event annotations where supported
- [ ] Introduce a renderer capability contract with Three.js/WebGL as the complete reference backend and adapters for Blender and external game engines
- [ ] Build a recoverable generation pipeline from scenario sampling through rollout, capture, validation, sharding, and publication
- [ ] Version datasets immutably with lineage, checksums, deterministic splits, manifests, asset/license provenance, and reproducible generation configuration
- [ ] Add automated quality gates for corruption, temporal synchronization, annotation consistency, duplicate content, distribution coverage, and train/validation leakage
- [ ] Publish the first 10–100 hour multi-style interactive-world dataset with a loader SDK and quality report
- [ ] Provide operator workflows for generation progress, failed-episode diagnosis, dataset inspection, filtering, and release approval

### Out of Scope

- Training or publishing an action-conditioned world model in V1 — the first milestone proves dataset production and consumption contracts, not model quality
- Large-scale ingestion and curation of real-world video or robotics corpora — the product is synthetic-first
- Full feature parity across Three.js, Blender, and external game engines in V1 — backends share contracts but declare capabilities
- Immediate 10,000+ hour industrial production — V1 validates a 10–100 hour release before distributed scale-out
- A general-purpose enterprise data lake unrelated to world-model episodes — infrastructure must serve the core dataset contract

## Context

The existing repository is a three-plane system: a React/Three.js browser execution plane, a Node.js control plane, and isolated Python inference/training workers. The browser is authoritative for interactive rendering and clean capture; the control plane provides typed Agent tools, durable production state, orchestration, artifacts, and receipts; Python owns heavyweight model execution.

This is a strong basis for synthetic data generation because scenes, camera trajectories, entity identities, animation, and visual passes are already structured rather than inferred from pixels. However, the repository currently behaves as a local single-operator production application. It does not yet have a canonical dataset/episode abstraction, data lineage catalog, scalable processing DAG, dataset-level quality system, deterministic train splits, sharded publishing format, or a backend-neutral simulation contract.

Reference systems in the target category learn long-horizon video dynamics conditioned on camera poses, semantic actions, and explicit state. Useful datasets therefore need causal alignment between observations, actions, and world transitions—not merely attractive MP4 output. Privileged signals such as depth, optical flow, segmentation, skeletons, object transforms, and event state should remain synchronized and traceable to the exact scene, assets, seed, renderer, and code version that produced them.

The first release should emphasize diverse interactive worlds: indoor and outdoor exploration, camera navigation, entity interaction, combat-like actions, and scripted events across multiple visual styles. Internal use comes first, while public schemas, manifests, loaders, and quality reports keep the result externalizable.

## Constraints

- **Initial scale**: 10–100 generated hours — enough to validate schema and release quality without prematurely building a 10,000-hour fleet
- **Backend strategy**: One shared capability contract; Three.js/WebGL is the complete reference implementation, while Blender and game engines begin as adapters
- **Training boundary**: Dataset, SDK, and quality report are V1 deliverables; model training is excluded
- **Compatibility**: Preserve the existing browser/control-plane/Python separation and keep `DirectorProject` authoritative
- **Reproducibility**: Every released episode must bind scene revision, seed, actions, assets, licenses, renderer version, generation code, and output checksums
- **Synchronization**: Observation, action, state, and privileged modalities must share explicit clocks and frame/sample indices
- **Licensing**: Only assets and generated outputs with documented rights may enter a releasable dataset
- **Local-first evolution**: Existing single-machine workflows must remain usable while generation contracts are designed for later worker-pool execution

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Build a synthetic-first data engine | Existing structured scenes and privileged rendering passes provide a differentiated advantage over generic video curation | — Pending |
| Target interactive/action-conditioned video world models | LingBot-World/4D/agentic generation require causal observation-action-state episodes rather than isolated clips | — Pending |
| Treat camera control and entity interaction as one action system | Both are required for interactive world simulation and should share timing, validation, and lineage | — Pending |
| Serve internal users first while keeping contracts externalizable | Enables fast iteration without locking the dataset format to one private model stack | — Pending |
| Release 10–100 hours in V1 | Validates data quality and operational workflow before industrial scale-out | — Pending |
| Use a backend capability contract with Three.js as reference | Avoids forcing premature parity while preserving Blender and game-engine extensibility | — Pending |
| Exclude model training from V1 | Keeps success measurable as a versioned, consumable dataset release | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition:**
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone:**
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-08-03 after initialization*
