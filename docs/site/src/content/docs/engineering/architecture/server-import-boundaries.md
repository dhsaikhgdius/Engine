---
title: Server import boundaries
---

`backend/gateway/**` is the control plane. It may depend on Node libraries and official workspace packages (`@director/protocol`, `@director/agent-engine`, `@director/project-schema`, `@director/stage-protocol`, `@director/dcc-protocol`, `@director/dcc-interchange`, `@director/model-provider`, `@director/di`).

It must not import React, React Three Fiber, Zustand, Xterm, UI components, editor panels/canvas/workspaces, browser stores, or browser globals such as `window`, `document`, `localStorage`, and `indexedDB`. Frontend behavior crosses this boundary through validated HTTP/WebSocket contracts.

`npm run lint` enforces the rule twice: ESLint rejects known browser packages, runtime folders, and globals; the repository boundary checker applies an allowlist to every static, exported, dynamic, and `require` import in `backend/gateway/**/*.ts`.

There are no temporary frontend import exceptions. Stage execution, authoring, and session schemas enter the Gateway through `@director/agent-engine` and the other workspace packages.
