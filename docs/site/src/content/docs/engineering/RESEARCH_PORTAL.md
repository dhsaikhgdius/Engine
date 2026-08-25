---
title: Director Research Portal
---

The public research portal lives at `/research`; its in-browser documentation is at
`/research/docs`. The existing Director editor remains at `/`.

The portal is deliberately evidence-led. It documents capabilities that are present in
this repository and does not present unverified model rankings, fabricated task scores,
or an implied peer-review outcome.

## Intended use

Use the portal to orient a researcher, evaluator, or technical collaborator before
opening the production desk. It exposes four reviewable layers:

1. Scene state — versioned objects, groups, cameras, and environment settings.
2. Camera plan — lens, aspect, pose, target, and actions.
3. Temporal plan — tracks, keyframes, paths, and clips.
4. Agent trace — structured observe, author, audit, correction, and capture actions.

## Reproducibility baseline

```bash
npm install
npm run dev
npm run test
npm run build
```

Record the dependency lockfile hash, Node.js version, command output, browser version,
project or scene JSON, operation trace, audit result, and camera capture for an
evaluation run.

## Academic release policy

Do not publish model comparisons until the task definition, asset revision, system
prompt/tool version, evaluation budget, success conditions, reviewer protocol, and
result template are frozen and versioned. The portal calls this out explicitly so it is
not mistaken for a public leaderboard.
