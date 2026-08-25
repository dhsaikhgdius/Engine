---
title: Evaluation Protocol
description: Record reproducible evidence for human and Agent 3D authoring experiments.
---

This section is research and evaluation material for contributors. It is not the
getting-started path; start at [Getting Started](/getting-started/) if you want to run
Director.

Director's research surface is evidence-led. It does not claim a frozen benchmark,
peer-reviewed result, or public model leaderboard.

## Goal

Evaluate whether a user or Agent can author a requested 3D production result while leaving an
inspectable and reproducible evidence trail.

## Task record

Each task should define:

- required scene, asset, object, camera, and timeline outcome;
- allowed control surface;
- initial project or scene revision;
- asset and runtime versions;
- budget in turns, calls, time, or all three;
- deterministic acceptance checks;
- human-review rubric where needed;
- required state, trace, audit, and capture artifacts.

## Evidence cycle

1. **Observe** the initial state through the declared interface.
2. **Author** through recorded UI or structured operations.
3. **Validate** schemas and cross-entity references.
4. **Audit** spatial, temporal, structural, and camera-space conditions.
5. **Capture** a revision-bound image or export a project artifact.
6. **Report** automatic and human judgements separately.

## Reproducibility baseline

```bash
npm install
npm run dev
npm test
npm run build
```

Record:

- git revision or source snapshot;
- lockfile hash;
- Node.js and browser versions;
- task definition and input assets;
- system prompt, tool version, and provider;
- operation trace and budget;
- final project or scene JSON;
- validation and audit output;
- camera capture and artifact hashes.

## Reporting table

| Field               | Record                                          |
| ------------------- | ----------------------------------------------- |
| Task ID and version | Immutable task definition                       |
| System version      | Source revision, lockfile, runtime              |
| Control surface     | UI, MCP, HTTP, CLI, browser, or declared hybrid |
| Budget              | Calls, turns, wall time, and retries            |
| Final state         | Project or scene artifact hash                  |
| Validation          | Pass/fail and detailed errors                   |
| Audit               | Structured issue list and applied fixes         |
| Capture             | Camera ID, frame, output path/hash              |
| Review              | Separate automatic and human judgement          |

## Publication boundary

Do not publish model comparisons until the task set, assets, prompts/tools, evaluation budget,
success criteria, reviewer protocol, and reporting template are frozen and versioned.
