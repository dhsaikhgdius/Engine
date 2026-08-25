---
title: Troubleshooting
description: Diagnose installation, rendering, asset, Agent, and capture problems.
---

## UI does not load

1. Confirm Node.js and dependencies:

   ```bash
   node -v
   npm install
   ```

2. Start both services with `npm run dev`.
3. Check <http://127.0.0.1:8787/health>.
4. Check the browser console for a Vite overlay or WebGL error.

The UI uses strict port `5175`; another process on that port causes startup to fail instead of
silently choosing a different address.

## Gateway is unavailable

Run:

```bash
npm run dev:gateway
```

If a client uses a non-default address, set `STAGE_GATEWAY_URL` to the exact gateway URL.

## MCP tools are missing

1. Confirm `.mcp.json` points to the current checkout.
2. Run `npm run build:mcp-plugin`.
3. Run `npm run validate:agent-plugin`.
4. Restart or reload the MCP host.

## Agent provider is disabled

Run the provider command in a normal shell:

```bash
codex --version
claude --version
```

Configure an override command when the executable is not on `PATH`.

## Agent command targets the wrong project

Workbench and Creative writes are exact-target operations. Observe the intended visible tab and
retain its returned `target.token`. A missing token produces `target_required`; a closed tab or
changed scene/scope produces `target_unavailable`. Director deliberately does not fall back to a
different visible tab. Re-observe and rebuild the request against the new revision or fingerprint.

## Creative mutation reports conflict

- If the snapshot fingerprint changed, another human or Agent edited Canvas/Video after observe.
  Observe again and rebuild the operation with current IDs.
- If an idempotency key was used for different input, choose a new key for the new intent.
- Reuse the original key only for an exact network retry. A successful replay does not apply the
  mutation twice.
- A failed batch is already rolled back. Fix the failed step and resend the complete intent.

## Workbench mutation reports a stale revision

`stale_project_revision` means the live bound project changed after the Agent observed it. Observe
the same target again, reconcile the requested intent with current state, and build a new mutation
with the latest revision and a new idempotency key. Do not use `unconditional:true` simply to make
the error disappear; that would turn a detected conflict into an overwrite.

## Mutation result is unknown after a timeout

`outcome_unknown` means the browser may have committed the mutation before acknowledgement was
lost. It is different from `target_unavailable` and must not trigger a blind retry:

1. Stop sending mutations.
2. Observe the exact bound target again.
3. Use `diff`/`inspect`, or compare exact Canvas/Video entities, to decide whether the effect exists.
4. If it exists, continue from the new state without retrying.
5. If it is absent and the original revision/fingerprint still holds, resend the byte-equivalent
   payload with the same idempotency key.
6. If current state requires any changed payload or guard, re-plan it as a new intent with a new key.

`command_timeout` applies to cancelled reads and evidence requests. Keep the target visible,
refresh its revision/fingerprint if required, and retry; do not claim a preview or capture exists.

## Audit is ready but the result looks wrong

Structural audit does not replace visual review. Creative audit always requires Canvas layout or
Video preview inspection. Workbench delivery must include a helper-free clean frame and matching
revision. Do not report visual completion from `success:true` or `ready:true` alone.

For Canvas or Video Editor, call `director_creative` with `op:"preview"` and the fingerprint from
the final observation. A `stale_snapshot` response means the workspace changed during or before
rendering; observe and request a new preview instead of accepting stale pixels.

## Asset preview is empty

- Confirm the source file still exists and the URL is local/allowed.
- Check the browser console for loader or decoder errors.
- Try the focused preview dialog before loading many assets.
- Verify normals, materials, and model scale in another GLTF viewer.

## Dropped asset is underground

- Recompute or inspect its visual bounds.
- Confirm scene ground height and scene transform.
- Check that the asset does not contain hidden geometry far below the visible mesh.
- Inspect the model origin separately from the visual transform center.

## Prop is the wrong scale

Model assets are scaled to their real-world size in metres. Open the prop inspector and check
**Real size**: an empty field means the asset falls back to the legacy 2 m display normalization,
which is wrong for anything much smaller or larger than that. Type the real size in metres. Agents
find the same problem as the `asset_missing_real_world_size` audit warning.

The field is hidden for assets that keep their authored metric scale, such as promoted generated 3D
models and imported scene bundles; adjust the object transform for those instead.

## Transform gizmo is off-center

The gizmo should use the object's visual center in world space. Check nested transforms,
skinned-mesh bounds, group bounds, and stale cached bounds before changing the stored object
transform.

## Camera capture contains helpers

Confirm the capture uses the camera/viewport capture path rather than a normal screen
screenshot. Editor helpers must carry the capture-hidden flag and be restored after capture.

## Performance is unstable

Director keeps the Stage, quad view, viewport gizmo, and asset previews on the fixed
**High quality** profile. Legacy Auto or Fluid preferences are migrated to High quality and
measured frame-time samples never lower rendering resolution or disable shadows.

The report button becomes available after a stable sample window. Browser background tabs are
excluded from sampling.

## ComfyUI job stays prepared

`prepare` works without ComfyUI. Submission requires both:

```bash
COMFYUI_URL
COMFYUI_VIDEO_WORKFLOW_PATH
```

The workflow file must be API-format JSON inside the Director repository.

## Persisted project does not restore

Director rejects malformed project snapshots. Export a valid project when possible, inspect
the browser storage scope (`instanceId`), and check whether an older snapshot fails the current
schema or graph-integrity checks.
