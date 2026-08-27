---
title: Golden Journey
description: The six steps that carry one shot from intent to verified delivery, and the definition of a verified shot.
---

The golden journey is the workflow Director optimizes for: one shot, from a sentence of intent
to revision-bound visual evidence. Every feature must strengthen one of these steps — that is
the first admission question in the [Product Constitution](/concepts/product-constitution/).

## The six steps

| Step | Name     | What happens                                                                             | Done when                                                      |
| ---- | -------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| J1   | Intend   | Capture the shot brief on Canvas: what the shot must say, references, and lineage        | The intent exists as an addressable node, not a chat message   |
| J2   | Stage    | Build the metric white-box: instance real catalog, Blender, or generated-3D assets       | Layout and scale read correctly in clay                        |
| J3   | Frame    | Add physical cameras and takes: lens, sensor, coverage of the performance                | The framing holds on a 35–65 mm clean capture                  |
| J4   | Verify   | Audit, correct, and deliver: bind audit, clean capture, and package hashes to a revision | A delivery receipt — the shot is a **verified shot**           |
| J5   | Generate | Condition video generation on the verified framing and passes; track jobs to receipts    | A generation artifact with a real job receipt lands in Gallery |
| J6   | Assemble | Cut picture and audio in the Video Editor; review, export, or hand off to a DCC/engine   | The cut references verified shots and exports with receipts    |

The journey is a loop, not a waterfall: a failed audit returns to J2 or J3, a rejected
generation returns to J4 with a new revision, and notes on a cut reopen J1. What never changes
is the direction of evidence — each step consumes the receipts of the one before it.

## What a verified shot is

A **verified shot** is a delivery receipt, not a feeling. It requires, all bound to one accepted
project revision:

- `ready:true`, `status:"delivered"`, and `capture_verified:true`;
- a passing `audit` — references, grounding, overlap, and framing;
- a clean capture with every editor helper removed, plus the requested render passes;
- the expected revision and package fingerprint;
- human or critic inspection of the clean frame — `audit.ready` alone is never acceptance.

To produce one yourself, follow the
[End-to-end Verified Shot tutorial](/tutorials/verified-shot/); it walks J2–J4 with real
commands.

## The control loop

Each journey step is driven by the same agent loop:

```text
capabilities/catalog → observe → author one intent → observe/diff → audit/correct → deliver
```

Discovery prevents invented vocabulary, observation supplies real IDs and the revision guard,
one atomic batch commits the intent, and delivery binds the evidence. The full contract —
targets, guards, idempotency, and failure recovery — is defined in
[Agent-native Production](/concepts/agent-native-production/).
