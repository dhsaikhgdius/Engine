---
title: Development
description: Set up Director development, respect runtime boundaries, select tests, and prepare a reviewable change.
---

## Supported toolchain

- **Node.js 22** is the repository and CI baseline.
- **npm 10+** installs and runs the TypeScript/React workspace.
- A WebGL 2 browser is required for interactive Stage verification.
- Python, CUDA, model weights, and Blender are optional and belong to their isolated integrations.

Use the lockfile for reproducible installs:

```bash
npm ci
npm --prefix docs/site ci
```

## Daily commands

| Command                | Purpose                                                                        |
| ---------------------- | ------------------------------------------------------------------------------ |
| `npm run dev`          | Start the Vite UI and TypeScript gateway.                                      |
| `npm run dev:ui`       | Start only the browser UI.                                                     |
| `npm run dev:gateway`  | Start only the gateway in watch mode.                                          |
| `npm run docs:dev`     | Start the Starlight documentation site.                                        |
| `npm run lint`         | Run ESLint and the server import-boundary audit.                               |
| `npm run format:check` | Check repository formatting without rewriting files.                           |
| `npm run build`        | Type-check, build the UI, enforce the chunk budget, and bundle the MCP server. |
| `npm test`             | Run the complete Vitest suite.                                                 |
| `npm run docs:build`   | Build both documentation locales and validate routes and Markdown/MDX.         |

The CI workflow in `.github/workflows/ci.yml` runs on Node 22 with `npm ci --ignore-scripts`,
then lint, format check, build, and the complete test suite. Run `npm run docs:build` locally for
every documentation change; it should be added to CI if documentation becomes a required merge gate.

## Runtime boundaries

Director has three runtime planes:

```text
Browser execution (React/R3F, editor state, WebGL capture)
  → TypeScript control plane (gateway, Agent sessions, jobs, DCC coordination)
  → Python inference workers (model residency and GPU execution)
```

Rules enforced by `tools/scripts/checkServerImportBoundaries.ts`:

- `backend/gateway/**` must not import React, React Three Fiber, Zustand, Xterm, editor runtime modules,
  or browser globals.
- Shared wire contracts belong under `packages/protocol/src/**`; pure Stage/Agent contracts and editor
  schema modules are allowed only through the audited allowlist.
- Python workers do not mutate browser or gateway state directly. They receive validated jobs
  and return immutable result descriptors.
- The audit currently has exactly **4 temporary migration exceptions**. Do not broaden or copy
  them. A change touching one must narrow or remove it when practical and update its reason and test.

## Choosing tests

Start with the smallest test that proves the behavior, then expand according to the changed boundary.

Vite, Vitest, ESLint, TypeScript, and PostCSS configs live under `tools/`. Prefer `npm run …`
scripts; they pass `--config` explicitly.

```bash
# One file while iterating
npx vitest run --config tools/vitest.config.ts path/to/file.test.ts

# Agent and compact Stage contracts
npm run test:agent

# Comprehensive editor, workspaces, runtime, and media
npm run test:comprehensive

# Full repository before handoff
npm test
```

Use integration tests when a change crosses browser/gateway, MCP/HTTP, persistence, archive,
interchange, DCC, or provider boundaries. Visual or R3F behavior also needs a rendered/browser
check; a state-only unit test does not prove the pixels.

For optional LTX-2.3, Gateway spawn tests live with the TypeScript suite. Do not make the default Node test suite download
weights or require a GPU.

## Documentation contract

- Change the English and Chinese page in the same pull request.
- Keep headings, tables, status labels, commands, versions, counts, and support boundaries aligned.
- Use [Feature Status](/reference/feature-status/) as the single status vocabulary; guides and
  engineering records must not invent a fifth status or independently promote a feature.
- Add operator steps under `getting-started`, `editor`, `agents`, or `pipelines`; keep schemas,
  ADRs, provenance, and implementation reasoning under `engineering`.
- Run Prettier on changed Markdown and finish with `npm run docs:build`.

## Pull request checklist

- [ ] Scope and affected runtime plane are explicit.
- [ ] No unrelated user changes or generated artifacts are included.
- [ ] Runtime validation and types still come from the same contract.
- [ ] New external input has boundary validation and failure tests.
- [ ] Persistence, undo, revision/fingerprint, and idempotency behavior are covered when relevant.
- [ ] Agent-visible behavior is discoverable and verifiable without DOM coordinates.
- [ ] Focused tests pass; cross-boundary integration tests were added where required.
- [ ] `npm run lint`, `npm run format:check`, `npm run build`, and `npm test` pass.
- [ ] English and Chinese docs are synchronized and `npm run docs:build` passes.
- [ ] [Feature Status](/reference/feature-status/) and third-party notices were updated when capability or provenance changed.
