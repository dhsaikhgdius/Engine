---
title: Configuration
description: Ports, environment variables, persistence keys, and build commands.
---

## Gateway

| Variable                   | Default                 | Purpose                                                    |
| -------------------------- | ----------------------- | ---------------------------------------------------------- |
| `STAGE_GATEWAY_HOST`       | `127.0.0.1`             | Gateway bind host                                          |
| `STAGE_GATEWAY_PORT`       | `8787`                  | Gateway port                                               |
| `STAGE_GATEWAY_URL`        | `http://127.0.0.1:8787` | URL used by CLI, MCP, and provider adapters                |
| `STAGE_AGENT_SESSION`      | `cli-default`           | CLI ref-session ID                                         |
| `DIRECTOR_MCP_SESSION_ID`  | generated               | Stable MCP ref-session ID                                  |
| `DIRECTOR_GATEWAY_TOKEN`   | random per process      | Optional fixed local gateway token (minimum 24 characters) |
| `DIRECTOR_ALLOWED_ORIGINS` | loopback Director URLs  | Additional comma-separated trusted browser origins         |
| `DIRECTOR_DATA_DIRECTORY`  | `data`                  | Mutable gateway and native-project data root               |

The gateway refuses non-loopback binding. Native CLI/MCP clients bootstrap the process token
automatically; raw HTTP clients obtain it from `/te-man/director/agent/bootstrap` and send it in
`X-Director-Browser-Token`. This authentication token is separate from the exact workspace
`target_token` returned by observation.

## Collaboration rooms

| Variable                                 | Default                | Purpose                                                                                                                            |
| ---------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DIRECTOR_COLLAB_ROOM_AUTH`              | unset (local trust)    | Set to `required` to reject room joins without a valid invite capability token                                                     |
| `DIRECTOR_COLLAB_INVITE_SECRET`          | process gateway secret | Stable HMAC secret for invite tokens; set it so invites survive gateway restarts                                                   |
| `DIRECTOR_COLLAB_PERSISTENCE`            | unset (in-memory)      | Set to `1` to persist Yjs room snapshots (compaction + corrupt-update quarantine) on disk, plus the invite revocation list         |
| `DIRECTOR_COLLAB_EMPTY_ROOM_TTL_SECONDS` | unset (0)              | Grace period keeping an empty room's in-memory document alive after the last peer leaves (clamped to 24 h; 0 destroys immediately) |
| `DIRECTOR_COLLAB_INVITE_RATE_LIMIT_PER_MINUTE` | unset (0 / off)  | Optional sliding-window cap on invite mint+revoke HTTP calls per client key; when exceeded returns `invite_rate_limited` with `Retry-After` |
| `VITE_DIRECTOR_COLLAB_INVITE_TOKEN`      | unset                  | Frontend build/env-provided invite token the browser transport attaches to `collab.join`                                           |

In local trust mode (default) every upgrade-authenticated socket joins as an editor, matching the
pre-auth behavior. With `DIRECTOR_COLLAB_ROOM_AUTH=required`, operators mint invites through
`POST /api/collab/invites` (`{room, role, ttl_seconds}` — `role` is `editor` or `viewer`, and `room`
may be a prefix capability such as `project-a/*`; the response includes a unique `jti` invite id).
`GET /api/collab/auth` reports the active mode. Viewer invites receive documents and share awareness
but cannot write.

Invites can be revoked through `POST /api/collab/invites/revoke` with exactly one of `token`
(revokes that invite by its `jti`) or `room` (a scope cutoff: every invite for that scope minted
no later than the revocation instant is denied, including legacy invites without a `jti`).
A revocation also ends live sessions: peers already joined with the revoked invite are ejected
with a permanent `unauthorized` error, and the response reports `disconnected_peers` and
`disconnected_rooms`. Revocations persist across restarts only when `DIRECTOR_COLLAB_PERSISTENCE=1`.

Room lifecycle and operations (all behind the master gateway token, returning counts, hashes, and
timestamps only — never document content, invite tokens, or filesystem paths):

- `GET /api/collab/rooms` — merged live + durable room status: peer/editor/viewer counts,
  snapshot bytes and age, pending updates, quarantine counts, auth mode, empty-room TTL,
  invite rate-limit policy, and revocation counters.
  Unauthenticated `GET /health` also exposes a redacted `collaboration` stanza (`mode`,
  `persistence`, `empty_room_ttl_seconds`, `invite_rate_limit_per_minute`, `active_rooms`,
  `retained_rooms`) so operators can confirm team-mode flags without calling authenticated
  collab routes.
- `GET /api/collab/rooms/quarantine?room=<id>` — the bounded corrupt-update quarantine index for
  one room (ids, SHA-256 hashes, sizes, reasons).
- `POST /api/collab/rooms/close` — `{room, archive?}`: peers receive a `room_closed` error and the
  in-memory document is destroyed after pending updates flush into the snapshot. With
  `archive: true` the durable history is also moved aside so future joins start empty.

When the last peer leaves a room, pending durable updates are flushed into the canonical snapshot;
snapshots are retained until an operator archives the room. Collaboration HTTP responses carry
`Cache-Control: no-store` and `Referrer-Policy: no-referrer` because they transport capability
tokens.

## Provider commands

| Variable             | Default  |
| -------------------- | -------- |
| `CODEX_CLI_COMMAND`  | `codex`  |
| `CLAUDE_CLI_COMMAND` | `claude` |

## Hosted Agent APIs

The Agent workspace **Configure API** panel writes providers to `agent-api-providers.json` in the
data directory and hot-reloads them into the model picker.
`DIRECTOR_AGENT_PROFILES_JSON` is a strict JSON array of server-owned profiles. Each entry uses
`driver: "openai"`, `"anthropic"`, or `"openai-compatible"`, plus `id`, `label`, `model`, and an
optional `baseUrl`, `apiKeyEnv`, `maxToolRounds`, or capability override. The default credential
variables are `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `DIRECTOR_AGENT_API_KEY`, respectively.

| Variable                            | Purpose                                              |
| ----------------------------------- | ---------------------------------------------------- |
| `DIRECTOR_AGENT_PROFILES_JSON`      | Strict multi-profile hosted Agent configuration      |
| `DIRECTOR_AGENT_ROLE_PROFILES_JSON` | Partial FilmRole-to-Profile routing object           |
| `OPENAI_API_KEY`                    | Server-only credential for native OpenAI profiles    |
| `OPENAI_BASE_URL`                   | Optional OpenAI API root override                    |
| `ANTHROPIC_API_KEY`                 | Server-only credential for native Anthropic profiles |
| `ANTHROPIC_BASE_URL`                | Optional Anthropic Messages API root override        |

Legacy OpenAI-compatible settings still create the `api-default` profile:

| Variable                             | Purpose                                      |
| ------------------------------------ | -------------------------------------------- |
| `DIRECTOR_AGENT_API_BASE_URL`        | OpenAI-compatible API root                   |
| `DIRECTOR_AGENT_API_KEY`             | Server-only bearer credential                |
| `DIRECTOR_AGENT_API_MODEL`           | Model ID sent to `/chat/completions`         |
| `DIRECTOR_AGENT_API_LABEL`           | Public profile label                         |
| `DIRECTOR_AGENT_API_MAX_TOOL_ROUNDS` | Maximum bounded tool loop, from 1 through 48 |

API keys and their environment-variable names are never exposed by discovery routes, events, or
durable session JSON. Conversation v2 stores canonical messages instead of provider wire formats;
captured image bytes are only attached to the current model request.

## Agent workspace (SQL-backed instructions / skills / memory)

The in-product agent workspace persists instructions, learnings, skill references, and memory
entries (with TTL) in `agent-workspace.sqlite` under the data directory, edited through
**Settings → Agent Workspace** and `/api/agent/workspace/*`. The harness merges instruction
layers lowest-precedence-first: **repo skills → DB workspace (org → user) → session override**.

| Variable                        | Purpose                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------ |
| `DIRECTOR_SESSION_INSTRUCTIONS` | Ephemeral per-session instruction override (highest precedence, not persisted)                   |
| `DIRECTOR_WORKSPACE_REFRESH_MS` | Workspace prompt refresh cadence in the DSH plugin; `0` disables, clamped 5s–10min (default 30s) |

Merge strategy with `DIRECTOR_AGENT_PROFILES_JSON`: the two are separate axes and are not
migrated into each other. Model/provider profiles — including every credential — stay on the
profile axis: `DIRECTOR_AGENT_PROFILES_JSON` (environment) merged with `agent-api-providers.json`
(user), environment first, user overlays on id collision, and reserved ids
(`api-default`, local CLIs) always environment-owned. The workspace stores only prose
instructions, learnings, skill references, and memory; its export bundle is structurally unable
to carry provider credentials. Workspace prompt text passes the same redaction rules as harness
diagnostics, and memory entries are user-controlled untrusted data that are never injected
automatically into any prompt.

`web_search` and `web_fetch` are DeepSeek Harness tools. When you run the harness with
`npm run dsh`, they come from the pinned official DSH release (`vendor/deepseek-harness`) and are
configured through the harness's own settings. The Gateway no longer ships an in-tree copy of
these tools or an `agent-plugin-settings.json` store; the Director-specific Stage / Canvas /
Video / Blender tools reach DSH through `packages/dsh-plugin-workbench`. Director's film role
policy (`backend/gateway/agents/filmRoleToolPolicy.ts`) continues to hide web tools from film
roles, and hosted film-pipeline profiles run structured single completions without a tool loop.

Role routing uses the same IDs declared by `DIRECTOR_AGENT_PROFILES_JSON`:

```bash
export DIRECTOR_AGENT_ROLE_PROFILES_JSON='{
  "stage-director":"openai-director",
  "cinematographer":"claude-camera",
  "visual-critic":"openai-critic",
  "repair-operator":"claude-repair"
}'
```

The object is strict: unknown film roles and empty Profile IDs fail startup. It is intentionally
partial; unmapped roles fall back to the production run's selected Profile and then `api-default`.
Availability, tool support, and Critic vision capability are checked before a run starts. The
resolved Profile is pinned into every durable node, including retries after resume.

## LTX-2.3

The provider is currently **Experimental**. Gateway spawn tests pass; until a real GPU run produces
a stored artifact receipt, configuration success must not be reported as inference success. See
[Feature Status](/reference/feature-status/).

Naming: **LTX-2.3** is the product and provider id (`DIRECTOR_VIDEO_PROVIDER=ltx-2.3`). **LTX2**
in `DIRECTOR_ACCEPT_LTX2_LICENSE`, `npm run setup:ltx2`, and the `vendor/ltx-2` submodule is the
upstream LTX-2 family / license name for the same integration — not a second video model.

| Variable                                                | Purpose                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `DIRECTOR_VIDEO_PROVIDER`                               | Default: `ltx-2.3`, `comfyui`, or `minimax-h3`                   |
| `DIRECTOR_ACCEPT_LTX2_LICENSE`                          | Must be `1` after reviewing the LTX-2 Community License          |
| `DIRECTOR_LTX2_SOURCE_DIR`                              | Override the `vendor/ltx-2` checkout                             |
| `DIRECTOR_LTX23_MODEL`                                  | Model label retained in the production manifest                  |
| `LTX23_DISTILLED_CHECKPOINT_PATH`                       | Official distilled checkpoint                                    |
| `LTX23_SPATIAL_UPSAMPLER_PATH`                          | Official spatial upsampler                                       |
| `LTX23_GEMMA_ROOT`                                      | Local Gemma encoder root                                         |
| `LTX23_DEVICE` / `LTX23_QUANTIZATION` / `LTX23_OFFLOAD` | Optional DistilledPipeline policy                                |
| `DIRECTOR_MINIMAX_API_KEY`                              | MiniMax platform API key (enables the `minimax-h3` provider)     |
| `DIRECTOR_MINIMAX_BASE_URL`                             | `https://api.minimax.io` (default) or `https://api.minimaxi.com` |
| `DIRECTOR_MINIMAX_VIDEO_MODEL`                          | Hosted model name, default `MiniMax-H3`                          |

## Pinned Hunyuan3D, TRELLIS, and ARDY sources

These Git submodules are clone-on-demand. CI does not initialize them. Weights stay
outside the source repository.

| Variable / command                                                                           | Purpose                                                                            |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `DIRECTOR_ACCEPT_HUNYUAN3D_LICENSE=1` then `npm run setup:hunyuan3d`                         | Pin Hunyuan3D-2 after reviewing the community license                              |
| `npm run setup:trellis`                                                                      | Pin Microsoft TRELLIS (MIT source; some render/mesh deps differ)                   |
| `npm run setup:ardy`                                                                         | Pin NVIDIA ARDY; Gateway then defaults `DIRECTOR_ARDY_REPO` to that checkout       |
| `DIRECTOR_HUNYUAN3D_SOURCE_DIR` / `DIRECTOR_TRELLIS_SOURCE_DIR` / `DIRECTOR_ARDY_SOURCE_DIR` | Override a checkout that already lives on a GPU host                               |
| `DIRECTOR_ARDY_REPO`                                                                         | Explicit ARDY path; required together with `DIRECTOR_ARDY_SSH_HOST` for remote GPU |

See `vendor/` (`ltx-2`, `hunyuan3d`, `trellis`, `ardy`, and their `*.lock.json` pins).

## Optional ComfyUI generation runtime

| Variable                         | Purpose                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- |
| `COMFYUI_URL`                    | Single-node fallback ComfyUI URL                                        |
| `COMFYUI_NODES_JSON`             | Strict node array: id, label, baseUrl, enabled, and maxConcurrent       |
| `COMFYUI_IMAGE_WORKFLOW_PATH`    | Optional configured API-format image workflow inside Director           |
| `COMFYUI_VIDEO_WORKFLOW_PATH`    | Optional configured API-format video workflow inside Director           |
| `DIRECTOR_GENERATION_POLL_MS`    | History polling interval, clamped to 100–10,000 ms; default `750`       |
| `DIRECTOR_GENERATION_TIMEOUT_MS` | Per-attempt timeout, clamped to 10 seconds–24 hours; default 30 minutes |

Runtime-imported workflows and node definitions are atomically stored in `data/comfy-workflows/`
and `data/comfy-nodes.json`. Provider outputs and generation receipts live in attempt-specific
directories under `data/production-jobs/`; browser clients retrieve them through authenticated
artifact routes.

## Blender native backend

| Variable                                        | Default                                                        | Purpose                                                                |
| ----------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `BLENDER_BIN`                                   | standard local install, then leftover `.runtime/blender-build` | Explicit Blender executable.                                           |
| `WORLDENGINE_SESSION_PORT`                      | `8791`                                                         | Native scene session port                                              |
| `DIRECTOR_BLENDER_PROJECT_FILE`                 | `<data root>/blender/director-native.blend`                    | Bound native project file.                                             |
| `DIRECTOR_BLENDER_URL` / `TOKEN` / `TIMEOUT_MS` | `http://127.0.0.1:8791`                                        | Gateway → native session (per HTTP poll; native jobs wait up to 280s). |
| `SKETCHFAB_API_TOKEN`                           | unset                                                          | Blender-side token for `sketchfab_search` / `sketchfab_import`.        |

The native launcher sets `BLENDER_USER_SCRIPTS` to `integrations/blender/live` and
disables Python bytecode output. Keep the project file under the configured
data root unless a production explicitly owns another path.

## Engine connectors (Unreal / Unity / Godot)

| Variable                     | Default                                     | Purpose                                                              |
| ---------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `DIRECTOR_UNREAL_EDITOR_BIN` | common install paths, then `PATH` discovery | `UnrealEditor-Cmd` executable for headless Unreal handoff            |
| `DIRECTOR_UNREAL_PROJECT`    | unset                                       | `.uproject` file hosting the installed `DirectorBridge` plugin       |
| `DIRECTOR_UNITY_BIN`         | common install paths, then `PATH` discovery | Unity editor executable for `-batchmode` handoff                     |
| `DIRECTOR_UNITY_PROJECT`     | unset                                       | Unity project directory containing the `com.director.bridge` package |
| `DIRECTOR_GODOT_BIN`         | `godot`/`godot4` on `PATH`, common paths    | Godot 4 executable for `--headless` handoff                          |
| `DIRECTOR_GODOT_PROJECT`     | unset                                       | Godot project directory with the `director_bridge` addon enabled     |

Detecting an executable makes a provider `installed`, never `nativeReady`. Native
engine operations require the full health check (connector files, versioned
executable, configured project, and installed in-project connector) to pass. Godot
additionally requires the addon to be enabled in `project.godot`
(`[editor_plugins]`) and a valid fixed-entry `--mode health` JSON line whose
connector version matches the workspace; the probe covers macOS, Linux
(including Flatpak and Snap), and Windows install locations, and accepts Godot
4.x only. Engine job artifacts live under `data/dcc-jobs/<provider>/`.

## Application commands

| Command                            | Purpose                                               |
| ---------------------------------- | ----------------------------------------------------- |
| `npm run dev`                      | UI and gateway in watch mode                          |
| `npm run dev:ui`                   | Vite UI only                                          |
| `npm run dev:gateway`              | gateway only, watch mode                              |
| `npm run gateway`                  | gateway without watch mode                            |
| `npm run blender`                  | integrated native Director product                    |
| `npm run blender:test`             | run the native Blender smoke suite                    |
| `npm run mcp`                      | source MCP server                                     |
| `npm run stage -- <tool> '<json>'` | CLI tool call (`--help`; prefer `director_workbench`) |
| `npm test`                         | all Vitest suites                                     |
| `npm run test:comprehensive`       | editor tests                                          |
| `npm run test:agent`               | Agent and Stage tests                                 |
| `npm run lint`                     | ESLint                                                |
| `npm run format:check`             | Prettier check                                        |
| `npm run build`                    | typecheck, UI build, bundled MCP build                |
| `npm run docs:dev`                 | documentation dev server                              |
| `npm run docs:build`               | static documentation build                            |

The docs site uses `http://127.0.0.1:4321` for local canonical URLs and sitemap output. A hosted
deployment should set `DIRECTOR_DOCS_SITE_URL` to its public HTTPS origin when running the docs build.

## Vite

The application uses port `5175` with `strictPort: true` (`tools/vite.config.ts`). Model assets include FBX, OBJ, GLB,
and GLTF. Vendor chunks separate Three.js core, R3F, React, Agent, terminal, and icon code for
more predictable caching. Tooling configs (Vite, Vitest, ESLint, TypeScript, PostCSS/Tailwind)
live under `tools/`; `package.json` stays at the repository root. Prefer `npm run …` scripts —
they pass `--config` / `-p` explicitly.
