---
title: "ADR 0002: unified durable ProductionJob state machine"
---

- **Status:** Proposed
- **Decision owners:** Director gateway and pipeline maintainers
- **Related:** `PIPELINE_SYSTEM_DESIGN.md`, `PIPELINE_IMPLEMENTATION_ROADMAP.md`

## Context

Video generation, image generation, DCC export, proxy/transcode, waveform, and other
heavy work have the same operational needs: queueing, progress, cancellation,
idempotency, retry, reconciliation, logs, and immutable artifacts. Separate ad hoc
stores make unknown outcomes and refresh recovery inconsistent.

## Decision

Use one versioned `ProductionJob` state machine and repository for all external or
long-running work. Executors are pluggable and may run in the browser, local gateway,
or a remote worker. Only the job service changes durable state.

Canonical terminal states are `succeeded`, `failed`, and `cancelled`.
`outcome-unknown` is non-terminal and must enter `reconciling` before retry when a
provider may have accepted the request.

Each logical job has attempts. Each attempt freezes:

- input fingerprint and source revisions;
- executor/provider/model/configuration snapshot;
- idempotency key and external job ID;
- progress phases and timestamps;
- structured error/retryability;
- artifact IDs and hashes;
- usage/cost metadata when available.

## Consequences

### Positive

- Same recovery semantics across UI, Agent, HTTP, and MCP.
- Refresh and gateway restart do not erase job truth.
- Provider retries cannot silently create untracked duplicates.
- DCC, media, and generation progress share one observable contract.

### Costs

- Existing job implementations need adapters and migration.
- Browser-only tasks require a lease/heartbeat so another executor does not resume
  them concurrently.
- Repository cleanup and artifact retention become explicit system responsibilities.

## Rejected alternatives

1. **One state machine per provider.** Rejected because provider differences belong
   inside executors and capability snapshots, not user-visible recovery semantics.
2. **Promise lifetime equals job lifetime.** Rejected because browser refresh or
   gateway restart would destroy state.
3. **Retry every timeout.** Rejected because paid providers may have accepted the
   original request.

## Security

Job records store provider names and redacted configuration snapshots, never secrets.
Credential lookup happens inside the executor. Artifact paths are generated under
approved roots; callers do not supply arbitrary output paths.

## Acceptance

- State-transition property tests reject invalid transitions.
- Exact idempotent retries replay the receipt; changed reuse fails.
- Simulated process restart restores and reconciles running jobs.
- Cancel, failure, and unknown-outcome paths preserve logs and existing artifacts.
- UI and Agent see the same state and error codes.
