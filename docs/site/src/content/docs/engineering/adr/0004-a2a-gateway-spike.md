---
title: "ADR 0004: A2A gateway spike — no live A2A runtime"
---

- **Status:** Rejected (live A2A runtime; a discovery-only agent card ships instead)
- **Decision owners:** Director gateway and protocol maintainers
- **Related:** [Agent-Native Roadmap M7](/engineering/agent_native_roadmap/),
  [ADR 0003](/engineering/adr/0003-import-export-receipts/), [HTTP API](/reference/http-api/)

## Context

Roadmap Milestone 7 required a written go/no-go conclusion on wrapping the Director gateway
as a [Google A2A](https://a2a-protocol.org/) (agent-to-agent) agent: publish an Agent Card,
accept A2A JSON-RPC tasks, and let external agents drive Director as a remote peer.

The relevant surfaces already exist:

- **MCP stdio** (`backend/gateway/mcp-server.ts`) exposes `director_workbench`,
  `director_creative`, `director_dcc`, and the other typed tools to MCP hosts.
- **HTTP** `POST /api/tools/{tool-name}` executes the same tools with the same Zod schemas.
- **`GET /api/control-plane/tool-manifest`** publishes the machine-readable
  `director-tool-manifest-v1` catalog derived from those execution schemas.
- **Gateway auth is loopback by design**: the control plane refuses a non-loopback
  `STAGE_GATEWAY_HOST` bind, and every `/api/*` request carries the process-epoch
  `X-Director-Browser-Token`. Internet exposure is explicitly **Limited**; a network
  deployment requires an authenticated reverse proxy.
- Mutations are bound to **exact-target leases** (token + client + instance + scene + scope)
  with `expected_revision` / fingerprint guards, and **film-role policy** gates MCP, the local
  harness, and the hosted adapter (raw HTTP gating is remaining M3 work).

## Spike: mapping A2A onto Director

| A2A concept                                   | Director reality                                                                                                                                                    |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent Card `skills`                           | Maps cleanly onto the typed tools: `director_workbench` (Stage), `director_creative` (Canvas/Video), `blender_native` (DCC), `stage_video` (generation)              |
| Agent Card `url` (A2A JSON-RPC endpoint)      | Does not exist. Execution is MCP stdio plus loopback HTTP; there is no remote JSON-RPC service to point at                                                            |
| `message/send`, Task lifecycle, streaming     | Would be a **second execution protocol** beside the single gateway tool loop, with its own task store, streaming, and push-notification semantics                     |
| OAuth2/HTTPS `securitySchemes`                | Mismatch: the gateway uses a loopback process token and refuses non-loopback binds; there is no OAuth issuer, TLS termination, or per-peer identity                   |
| Free-form remote peers                        | Director's naive-caller boundary injects exact-target leases, revisions, and idempotency keys; A2A messages have no native slot for these guards without extensions   |

## Decision

**No-go** for implementing a live A2A server now. **Go** for a **discovery-only** agent card
that points A2A-aware clients at the surfaces Director actually executes — MCP and the HTTP
tool manifest — instead of standing up a second execution protocol.

The card is served by the gateway as `GET /api/control-plane/a2a-agent-card`
(`backend/gateway/controlPlane/a2aAgentCard.ts`) so it derives from the same tool manifest
builder and cannot drift from the registry. It is honest by construction:

- `discovery_only: true` and a `null` A2A JSON-RPC endpoint;
- `url` is the loopback gateway origin, never a public A2A service;
- skills mirror `director_workbench`, `director_creative`, `blender_native`, and `stage_video`
  from the live tool manifest;
- streaming, push notifications, and task history are all `false`;
- no secrets, tokens, or credential environment-variable names.

## Consequences

### Positive

- A2A-aware ecosystems can discover Director truthfully today without any new attack surface.
- No second task executor, session store, or streaming stack to keep consistent with the
  gateway tool loop.
- The loopback/process-token security model is unchanged.

### Costs

- Cross-app callers must speak MCP or Director HTTP; a pure A2A client cannot execute work.
- The card is one more discovery response to keep aligned with the manifest (mitigated by
  deriving both from the same builder).

## Rejected alternatives

1. **Full A2A runtime (JSON-RPC endpoint, task streaming, push notifications).** Rejected: it
   requires remote HTTPS + OAuth-style auth the loopback gateway intentionally does not have,
   duplicates the execution boundary, and has no concrete consumer. Deferred unless a partner
   product requires it.
2. **A static card file in-repo, not served.** Rejected because a hand-maintained JSON would
   drift from the live tool registry; the served card is built from `buildDirectorToolManifest()`.
3. **Advertising a remote A2A endpoint URL on the card anyway.** Rejected as a security
   regression: it would invite peers to a path that bypasses gateway auth or misrepresents the
   Limited internet-exposure posture.

## Security

The card must never advertise a remote A2A endpoint that bypasses gateway authentication. It
is served behind the same `X-Director-Browser-Token` auth as every other `/api/*` route,
returns only loopback URLs, and contains no secrets. Republishing it at a remote origin
without the authenticated reverse proxy documented in the control-plane architecture is not
supported.

## Milestone and revisit trigger

This closes the M7 A2A spike. Implementing the full A2A runtime stays deferred unless a
partner product concretely requires A2A task execution; that work would start with a new ADR
covering remote auth, task-to-lease mapping, and role policy at the A2A boundary.
