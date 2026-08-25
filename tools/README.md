# Tooling

> Languages: **English** · [中文](README.zh-CN.md)

Vite, Vitest, ESLint, TypeScript, and PostCSS/Tailwind configs live here so the repository root
stays limited to npm workspace files (`package.json`, `package-lock.json`). Those two must remain
at the root: npm workspaces resolve from there.

`npm run …` scripts pass `--config` / `-p` explicitly. Bare `npx vite`, `npx vitest`, `npx eslint`,
or `npx playwright test` from the repository root will not discover these files.

## Config files

| Path | Purpose | Invoked by |
| --- | --- | --- |
| `vite.config.ts` | Director UI dev server and production bundle. `root` is `frontend/director/`; output is repo-root `dist/`. `css.postcss` points at this directory. | `npm run dev:ui`, `npm run build`, `npm run preview` |
| `vitest.config.ts` | jsdom Vitest runner. `root` is the repository so frontend, gateway, and package tests collect together. Excludes `tools/e2e/`, `.external/`, `.runtime/`, and `vendor/`. | `npm test`, `npm run test:core`, `npm run test:agent`, `npm run test:comprehensive` |
| `vitest.setup.ts` | jest-dom matchers and an in-memory `localStorage` shim (Node 25's built-in shim is incomplete). | loaded by `vitest.config.ts` |
| `eslint.config.js` | Typed ESLint plus frontend / gateway / protocol import boundaries. `basePath` is the repository root. | `npm run lint` |
| `tsconfig.json` | Canonical `tsc --noEmit` project. Source trees keep a one-line `extends` so the IDE finds this file when walking upward: `frontend/director/tsconfig.json`, `backend/gateway/tsconfig.json`, `packages/tsconfig.json`. | `npm run build` |
| `postcss.config.js` | Tailwind + Autoprefixer for the Director UI. | Vite (`css.postcss` → this directory) |
| `tailwind.config.js` | Tailwind content scan over `frontend/director/`. Referenced by `postcss.config.js`, not discovered from the repo root. | PostCSS |

The documentation site has its own empty `docs/site/postcss.config.mjs` so it does not inherit this Tailwind pipeline.

## Sibling directories

| Path | Purpose |
| --- | --- |
| [`scripts/`](./scripts/README.md) | Repository automation, local launchers, checks, and reproducible tools |
| [`e2e/`](./e2e/README.md) | Playwright end-to-end tests (`npm run test:e2e`; config is `e2e/playwright.config.ts`) |
| [`evals/`](./evals/README.md) | Agent golden-task evals (`npm run eval`) |

## Scoped commands

Prefer the `npm run …` scripts. When you need a one-off from the repository root:

```bash
npx vite --config tools/vite.config.ts
npx vitest run --config tools/vitest.config.ts <path>
npx eslint --config tools/eslint.config.js <path>
npx tsc --noEmit -p tools/tsconfig.json
npx playwright test --config tools/e2e/playwright.config.ts
```
