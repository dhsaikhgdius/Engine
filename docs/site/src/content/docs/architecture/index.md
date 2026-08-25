---
title: Architecture
description: Understand Director's UI, data, validation, gateway, and integration layers.
---

Director separates production state, rendering, protocol compatibility, and external Agent
transport.

## Layers

```text
React application and DOM editor chrome
  └─ React Three Fiber viewport and preview canvases
      ├─ Zustand Director runtime store
      │   └─ DirectorProject v1 + Zod validation
      │       ├─ Director workbench executor
      │       └─ Stage adapter → StageScene v5 → shared Stage command engine
      ├─ Blender scene layer
      │   └─ shared transient native snapshot → preview, selection, inspectors, camera, collision
      └─ scene-scoped Creative workspace + persistent media library
          └─ Canvas / Video executor + snapshot fingerprint + production audit

Local Agent gateway
  ├─ exact-target HTTP and WebSocket routes
  ├─ MCP stdio proxy
  ├─ production manifest and scene persistence
  ├─ capture coordination
  ├─ Codex / Claude provider adapters
  └─ SQLite Agent-session store

Blender native runtime
  ├─ one bound authoritative scene + revisioned live protocol
  ├─ root projection and Director transaction bridge
  └─ native mesh, material, UV, modifier, armature, action, and NLA ownership
```

## UI and rendering

The complete Director editor lives under `frontend/director/src/comprehensive`. DOM panels own normal application UI;
React Three Fiber owns 3D composition, cameras, helpers, and capture. High-frequency frame
updates remain inside the scene runtime instead of forcing broad React application updates.

## Native scene backend

The native backend is a bound headless Blender 4.2+ scene in the same Director workflow.
`DirectorProject.nativeScene` binds the production to one authoritative native scene; Director
persists production semantics and root projections, while Blender persists native child data. One
scene layer polls the native runtime and publishes a shared transient snapshot, so Stage and the
inspectors do not create parallel scene copies or independent refresh loops. Compatible Director
characters use a narrow capability adapter that maps canonical Action/Pose semantics to the native
armature and rejects unsupported IK instead of maintaining a second character model. See
[Data Models](/architecture/data-models/#native-blender-binding) and
[Native Blender Backend](/engineering/blender_bridge/).

## Validation

Zod schemas validate untrusted boundaries:

- Stage scene JSON;
- Director project import and checkpoint replacement;
- production manifests and mutations;
- assistant plan/apply payloads;
- terminal and workbench messages;
- Creative workspace requests and operation batches;
- Agent session records.

Structural validation is separate from semantic validation. A well-shaped operation can still
fail if an object ID does not exist or a storyboard camera reference is broken.

## Gateway

`backend/gateway/agent-gateway.ts` owns service startup and shared resources. Route modules split
production, assistant, session, and Stage endpoints. Tool execution stays local and writes only
validated state. A browser target token binds Workbench and Creative traffic to one exact tab,
instance, scene, and creative scope; stale targets fail closed instead of choosing another client.

## Provider neutrality

Provider adapters normalize different session and streaming protocols into the shared
`AgentSession` and `AgentEvent` contracts. Scene authoring remains on the same Director tools,
so provider-specific text protocols do not become a second scene model.

Read the detailed [control-plane and Python worker architecture](/architecture/control-plane/) and
the [server import-boundary contract](/architecture/server-import-boundaries/) before adding a new
provider, editor integration, or model runtime.
