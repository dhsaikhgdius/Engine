---
title: Production Deployment Checklist
description: The shortest supported configuration path from a local Director gateway to a small-team deployment.
---

This page is the minimum checklist for running Director for a small team instead of a single
local operator. It only lists what is implemented and tested today; the
[Feature Status](/reference/feature-status/) page is the source of truth for boundaries, and the
[Configuration](/reference/configuration/) reference documents every variable in detail.

:::caution
Director's internet-facing hardening is still **Limited**. The gateway binds loopback only; a
production deployment must sit behind your own TLS-terminating reverse proxy, and you own network
access control. Do not expose the gateway port directly.
:::

## 1. Pin the gateway identity

| Step | Setting |
| ---- | ------- |
| Fixed gateway token (≥ 24 chars) so agents and browsers survive restarts | `DIRECTOR_GATEWAY_TOKEN` |
| Trusted browser origins for your deployed UI URL(s) | `DIRECTOR_ALLOWED_ORIGINS=https://director.example.com` |
| Durable data root on persistent storage (runs, jobs, media, snapshots) | `DIRECTOR_DATA_DIRECTORY=/srv/director/data` |

## 2. Enable collaboration room auth

Local trust mode (the default) admits every upgrade-authenticated socket as an editor — correct
for one machine, wrong for a team.

| Step | Setting |
| ---- | ------- |
| Require signed invite tokens on every room join | `DIRECTOR_COLLAB_ROOM_AUTH=required` |
| Stable invite-signing secret (otherwise invites die with each restart) | `DIRECTOR_COLLAB_INVITE_SECRET` |
| Persist Yjs room snapshots with compaction and corrupt-update quarantine | `DIRECTOR_COLLAB_PERSISTENCE=1` |

Mint invites with the master gateway token:

```bash
curl -X POST "$GATEWAY_URL/api/collab/invites" \
  -H "X-Director-Browser-Token: $DIRECTOR_GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"room":"project-a/*","role":"editor","ttl_seconds":86400}'
```

`role` is `editor` (read/write) or `viewer` (receive + awareness only). `room` accepts an exact
room id or a `prefix/*` capability. Hand the returned token to the browser via
`VITE_DIRECTOR_COLLAB_INVITE_TOKEN` or your own invite flow.

## 3. Configure hosted multi-agent runs (optional)

Hosted production runs execute observe-only film roles against server-owned model profiles.

| Step | Setting |
| ---- | ------- |
| Server-owned hosted profiles | `DIRECTOR_AGENT_PROFILES_JSON` (+ `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) |
| Optional per-role routing | `DIRECTOR_AGENT_ROLE_PROFILES_JSON` |

Runs accept either a serial `roles` list or an explicit `graph` of nodes and `dependsOn` edges;
independent branches execute in parallel waves, and `POST /api/agent/runs/:id/resume` with
`{"from_node_id":"…"}` re-runs from a durable checkpoint node.

## 4. Configure media and generation providers (as needed)

Each provider is optional and reports an explicit unconfigured state instead of crashing:
`DIRECTOR_FFMPEG_PATH`/`DIRECTOR_FFPROBE_PATH` for media transcode, `DIRECTOR_FILM_LLM_*` /
`DIRECTOR_FILM_IMAGE_*` / `DIRECTOR_FILM_VIDEO_*` for the film pipeline, and generation providers
per the [Configuration](/reference/configuration/) reference.

## 5. Verify before inviting the team

```bash
npm run build            # typecheck + chunk budget + portable MCP plugin
npm test                 # full vitest suite
curl "$GATEWAY_URL/health"
curl -H "X-Director-Browser-Token: $DIRECTOR_GATEWAY_TOKEN" "$GATEWAY_URL/api/collab/auth"
# → {"mode":"invite-required"}
```

An unauthenticated `collab.join` must now receive `collab.error` with code `unauthorized`.

## Explicitly out of scope

- Public internet exposure without your own reverse proxy, TLS, and network policy.
- Multi-node gateway clustering and pluggable object storage.
- Per-user accounts: invites are capability tokens, not an identity system.
