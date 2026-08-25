---
title: Architecture decision records
---

ADRs record decisions that affect more than one Director workspace or external
contract. A document with status **Proposed** is a reviewable direction, not shipped
behavior.

| ADR                                                                               | Status   | Decision                                                                     |
| --------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------- |
| [ADR 0001: ProductionGraph](/engineering/adr/0001-production-graph/)              | Accepted | Add an identity/lineage graph above existing editor models.                  |
| [ADR 0002: durable ProductionJob](/engineering/adr/0002-durable-production-jobs/) | Proposed | Use one durable job state machine for external and heavy work.               |
| [ADR 0003: import/export receipts](/engineering/adr/0003-import-export-receipts/) | Proposed | Split interchange into reviewable plans/manifests and commit/write receipts. |

## ADR lifecycle

`Proposed → Accepted → Superseded` or `Rejected`.

Before an ADR becomes Accepted it needs:

- owner and implementation milestone;
- final schema names and version policy;
- migration/compatibility plan;
- security and failure analysis;
- fixture and acceptance-test plan.
