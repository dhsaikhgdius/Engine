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

| Step                                                                     | Setting                                                 |
| ------------------------------------------------------------------------ | ------------------------------------------------------- |
| Fixed gateway token (≥ 24 chars) so agents and browsers survive restarts | `DIRECTOR_GATEWAY_TOKEN`                                |
| Trusted browser origins for your deployed UI URL(s)                      | `DIRECTOR_ALLOWED_ORIGINS=https://director.example.com` |
| Durable data root on persistent storage (runs, jobs, media, snapshots)   | `DIRECTOR_DATA_DIRECTORY=/srv/director/data`            |

## 2. Enable collaboration room auth

Local trust mode (the default) admits every upgrade-authenticated socket as an editor — correct
for one machine, wrong for a team.

| Step                                                                                               | Setting                                      |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Require signed invite tokens on every room join                                                    | `DIRECTOR_COLLAB_ROOM_AUTH=required`         |
| Stable invite-signing secret (otherwise invites die with each restart)                             | `DIRECTOR_COLLAB_INVITE_SECRET`              |
| Persist Yjs room snapshots (compaction + corrupt-update quarantine) and the invite revocation list | `DIRECTOR_COLLAB_PERSISTENCE=1`              |
| Optional: keep an empty room's in-memory document alive for quick rejoins                          | `DIRECTOR_COLLAB_EMPTY_ROOM_TTL_SECONDS=300` |

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

A leaked invite is revoked with the same master token: `POST /api/collab/invites/revoke` with
`{"token":"…"}` kills that one invite (by its `jti`), and `{"room":"project-a/*"}` sets a cutoff
denying every invite for that scope minted no later than the revocation instant. Revoke responses
report durability honestly: `persistence_enabled` says whether a durable revocation file is
configured (`DIRECTOR_COLLAB_PERSISTENCE=1`) and `persisted` says whether this revocation reached
it. Without persistence a revocation is process-local and dies with the gateway — if
`DIRECTOR_COLLAB_INVITE_SECRET` is stable, the "revoked" invite works again after a restart, so
treat `persisted: false` as an action item, not a footnote. For day-2 operations,
`GET /api/collab/rooms` reports member counts, snapshot age, quarantine counts, the auth mode, and
whether revocations are durable (`invite_revocations.durable`);
`GET /api/collab/rooms/quarantine?room=…` lists a room's quarantined corrupt updates (entries are
re-validated on read); and `POST /api/collab/rooms/close` (optionally with `"archive": true`) kicks
every peer with a `room_closed` error and flushes — or archives — the durable history. The archive
outcome is typed: `archived: true` means the history was moved aside, `archived: false` with
`archive_reason: "no_durable_history"` means there was nothing to move, and a real filesystem
failure returns `500 archive_failed` (with the errno name) because the history is still in place.
In local trust mode a closed room can be recreated by any local client; combine close with invite
revocation when access must actually end.

## 3. Configure hosted multi-agent runs (optional)

Hosted production runs execute observe-only film roles against server-owned model profiles.

| Step                         | Setting                                                                   |
| ---------------------------- | ------------------------------------------------------------------------- |
| Server-owned hosted profiles | `DIRECTOR_AGENT_PROFILES_JSON` (+ `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) |
| Optional per-role routing    | `DIRECTOR_AGENT_ROLE_PROFILES_JSON`                                       |

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
# → {"ok":true,...,"collaboration":{"mode":"invite-required","persistence":true,...}}
curl -H "X-Director-Browser-Token: $DIRECTOR_GATEWAY_TOKEN" "$GATEWAY_URL/api/collab/auth"
# → {"mode":"invite-required"}
```

An unauthenticated `collab.join` must now receive `collab.error` with code `unauthorized`.
Confirm `collaboration.mode === "invite-required"` on `/health` when team auth is enabled; invite
capability tokens and self-asserted awareness identity are not per-user accounts.

## Explicitly out of scope

- Public internet exposure without your own reverse proxy, TLS, and network policy.
- Multi-node gateway clustering and pluggable object storage.
- Per-user accounts: invites are capability tokens, not an identity system.
