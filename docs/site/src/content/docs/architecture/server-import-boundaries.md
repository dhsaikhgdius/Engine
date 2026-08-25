---
title: Server Import Boundaries
description: Keep the TypeScript control plane independent from browser-only editor runtime code.
---

`backend/gateway/**` is the TypeScript control plane. It may use Node libraries and official workspace packages:
`@director/protocol`, `@director/agent-engine`, `@director/project-schema`, `@director/stage-protocol`,
`@director/dcc-protocol`, `@director/dcc-interchange`, `@director/model-provider`, and `@director/di`.

It must not import React, React Three Fiber, Zustand stores, Xterm, UI panels, editor canvases,
browser stores, or browser globals such as `window`, `document`, `localStorage`, and `indexedDB`.
Frontend behavior crosses the boundary through validated HTTP/WebSocket contracts.

The boundary checker is `tools/scripts/checkServerImportBoundaries.ts`; ESLint and the server boundary
test run it against every static, exported, dynamic, and `require` import. The Gateway has no temporary
frontend import exceptions.

```text
packages/*                       shared contracts and process-agnostic runtime
backend/gateway/                 Node control plane and external integrations
frontend/director/src/           browser editor, WebGL, stores, panels, and capture
vendor/                          official Python model sources spawned by the Gateway
```
