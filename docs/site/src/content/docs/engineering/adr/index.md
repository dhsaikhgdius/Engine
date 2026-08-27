---
title: Architecture decision records
---

ADRs record decisions that affect more than one Director workspace or external
contract. A document with status **Proposed** is a reviewable direction, not shipped
behavior.

| ADR                                                                               | Status                                     | Decision                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| [ADR 0001: ProductionGraph](/engineering/adr/0001-production-graph/)              | Accepted                                   | Add an identity/lineage graph above existing editor models.                  |
| [ADR 0002: durable ProductionJob](/engineering/adr/0002-durable-production-jobs/) | Accepted (2026-08-25)                      | Use one durable job state machine for external and heavy work.               |
| [ADR 0003: import/export receipts](/engineering/adr/0003-import-export-receipts/) | Accepted for shipped adapters (2026-08-25) | Split interchange into reviewable plans/manifests and commit/write receipts. |
| [ADR 0004: A2A gateway spike](/engineering/adr/0004-a2a-gateway-spike/)           | Rejected                                   | No live A2A runtime; serve a discovery-only agent card that points at MCP and the HTTP tool manifest. |
| [ADR 0005: verified shot north star](/engineering/adr/0005-verified-shot-north-star/) | Accepted (2026-08-27)                  | Adopt the product constitution: one verified-shot production line, three admission questions, a core/adapter/experiment layer taxonomy, and archived research inputs. |

## ADR lifecycle

`Proposed → Accepted → Superseded` or `Rejected`.

Before an ADR becomes Accepted it needs:

- owner and implementation milestone;
- final schema names and version policy;
- migration/compatibility plan;
- security and failure analysis;
- fixture and acceptance-test plan.
