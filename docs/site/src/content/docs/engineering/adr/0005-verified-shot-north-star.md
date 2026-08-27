---
title: "ADR 0005: Verified shot north star"
---

- **Status:** Accepted (2026-08-27)
- **Decision owners:** Director maintainers
- **Related:** [Product Constitution](/concepts/product-constitution/),
  [Golden Journey](/concepts/golden-journey/),
  [Agent-native Production](/concepts/agent-native-production/),
  [Competitive Union](/research/competitive-union/)

## Context

The repository accumulated several strong narrative inputs — the competitive capability union,
the agent-native roadmap, research surveys, and the experimental game slice. Each is useful, but
read together they can be mistaken for competing product directions. Contributors and agents need
one sentence that decides scope questions, and research inputs need an explicit archival status so
a locked audit is never read as a backlog.

## Decision

Adopt the [Product Constitution](/concepts/product-constitution/) as Director's decision filter.
Its north star is the **verified shot factory**: one production line from directorial intent to a
delivered shot, where every step is typed, revision-bound, and verifiable. Every change answers
the constitution's three admission questions:

1. Which [golden-journey](/concepts/golden-journey/) step (J1–J6) does it strengthen?
2. Can an agent drive it end to end — discoverable, addressable, guarded, idempotent, observable?
3. What revision-bound evidence proves it — a receipt, an audit, a diff, or a clean capture?

Pull requests additionally carry a fixed layer label: **core** is the single intent-to-shot
production line; **adapter** maps external tools, formats, and models onto core contracts;
**experiment** is isolated, honestly labeled, and never a second pipeline. `director_game` is an
experiment, not a second film pipeline.

Research documents such as [Competitive Union](/research/competitive-union/) are archived
research inputs, not product roadmaps. They keep their content and provenance value, carry an
archival callout pointing here, and do not gate or order delivery work.

## Consequences

- `AGENTS.md` carries a North Star section and both READMEs carry the one-line philosophy, so
  humans and agents read the same sentence first.
- The pull request template requires the three admission questions, a layer label, evidence
  links, and a constitution checklist, so every merge re-states the constitution.
- Research pages that could read as roadmaps carry an archived callout pointing at this ADR.
- Scope disputes resolve against the constitution and the three questions instead of against any
  single research document.
