---
title: Characters
description: Add packaged Mixamo characters, direct motion, refine poses, and place IK targets safely.
---

Director characters are local, rigged assets. A character object keeps its real asset binding,
its transform, and a Mixamo rig state containing an optional motion clip, semantic pose controls,
and IK targets.

## Add a character

1. Open **Assets** and choose the character category.
2. Search for a character and inspect its thumbnail before adding it.
3. Drag the card into the Stage, or use its add control.
4. Confirm that the feet rest on the ground and that the expected model appears.
5. Use the character inspector for motion, pose controls, and IK.

The packaged **X Bot** is the default neutral production character:

| Property      | Value                                      |
| ------------- | ------------------------------------------ |
| Asset ID      | `mixamo:x-bot`                             |
| Model         | `/mixamo-characters/models/x-bot.glb`      |
| Preview       | `/mixamo-characters/thumbnails/x-bot.webp` |
| Target height | 1.78 m                                     |
| Rig           | Mixamo, 65 bones                           |

Do not identify a character only by its display name. The project stores the real binding in
`assetRefId`; for X Bot that value must be `mixamo:x-bot`.

## Character inspector

The Character inspector keeps the selected identity visible while switching tools. Its summary
shows the character or crowd name, selection type, and display color. The four compact tabs have
separate responsibilities:

| Tab            | Purpose                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| **Properties** | Name, XYZ transform, **Down 2 Earth**, uniform scale, and display color                |
| **Action**     | Packaged skeletal clip, loop, speed, weight, start frame, blends, and root-motion mode |
| **Pose**       | Named semantic pose presets plus bounded body controls                                 |
| **IK**         | Local hand/foot targets, poles, weights, and reach limits                              |

Transform labels are draggable numeric controls as well as text fields. A character crowd uses the
same panel, but name, transform, scale, color, pose, and supported rig operations apply to the
selected crowd instead of one member. The identity summary stays visible on every tab so a long
Pose or IK panel cannot lose the editing target.

### Blender-backed characters

Integrated mode keeps one character object and one Character inspector. It does not stack a second
Mesh editor or raw Rig inspector below the character controls. Open the top-level **Modeling** tab
when topology, modifiers, materials, or UVs need native editing. The raw Rig inspector remains
available for Blender-created armatures that are not Director characters.

`DirectorProject.characterRig` is the canonical semantic character state. After Blender
provisions the asset, Director inspects the armature once per native revision and verifies its
Mixamo bone roles. A compatible character receives revision-checked native operations:

- **Action** imports or reuses the packaged Mixamo action and samples the deterministic Director
  timeline frame through a per-armature `Director Motion` NLA track. Characters can use different
  clips, loop modes, speeds, and start frames without writing competing scene frames;
- **Pose** maps the same bounded semantic controls to bone quaternion offsets;
- a native state marker makes an unchanged Action/Pose state idempotent, so polling and preview
  export cannot repeatedly save the scene.

The shared Blender scene frame follows the Director playhead once; it is not owned by any individual
character. Native Action currently uses full weight. Once/repeat, speed, start frame, and in-place
motion are applied; ping-pong, blend weight, and blend-in/out controls remain browser-runtime
features and are hidden for a native character. Native IK adaptation is not shipped yet, so the IK
tab reports that boundary and does not write a result that only appears to work. Mesh preview exports
the current deformation without changing the authoritative armature pose.

## Packaged motion clips

The current local motion catalog contains the fourteen verified Mixamo clips listed on
[Feature Status](/reference/feature-status/#catalog-counts):

| Clip ID      | Display name         |    Duration | Frames | Default loop |
| ------------ | -------------------- | ----------: | -----: | ------------ |
| `idle`       | Standard Idle        |     3.000 s |     91 | Repeat       |
| `walk`       | Walk Forward         |  1.366667 s |     42 | Repeat       |
| `walk-back`  | Walk Backward        |     1.300 s |     40 | Repeat       |
| `walk-left`  | Walk Left            |     1.200 s |     37 | Repeat       |
| `walk-right` | Walk Right           |     1.200 s |     37 | Repeat       |
| `run`        | Unarmed Run Forward  |     0.800 s |     25 | Repeat       |
| `run-back`   | Unarmed Run Backward |  0.766667 s |     24 | Repeat       |
| `run-left`   | Run Left             |  0.766667 s |     24 | Repeat       |
| `run-right`  | Run Right            |  0.766667 s |     24 | Repeat       |
| `wave`       | Wave                 |  0.533333 s |     17 | Once         |
| `clap`       | Standing Clap        |  4.766667 s |    144 | Once         |
| `sit-idle`   | Sitting Idle         | 10.866667 s |    327 | Repeat       |
| `jump`       | Standing Jump        |  2.433333 s |     74 | Once         |
| `talk`       | Standing Talk        |  5.166667 s |    156 | Repeat       |

All fourteen currently recommend **in-place** root motion. In-place motion animates the skeleton
without moving the character object across the Stage. Use object animation, a path, or runtime
locomotion for travel. Select authored root motion only when the clip is intended to carry planar
translation.

Browser-runtime motion controls include loop mode, speed, weight, start frame, blend-in, blend-out,
and root-motion mode. A Blender-backed character exposes the native subset documented above.
Avoid changing several parameters at once when diagnosing a bad walk or run; first verify the
unmodified catalog clip at speed `1` and weight `1`.

## How rig layers combine

Director evaluates character deformation in this order:

```text
Packaged skeletal motion
  → semantic pose controls
  → IK effectors
```

This order is intentional. A pose control can refine a sampled animation, and IK can finally pin a
hand or foot to a local target. Clearing motion does not clear pose controls or IK. Assigning motion
clears the named pose preset but retains explicit controls and IK.

## Pose presets and controls

Available presets are:

`stand`, `t-pose`, `walk`, `run`, `sit`, `crouch`, `kneel-one`, `kneel-two`,
`hands-on-hips`, `lean`, `bow`, `think`, `fight`, `kick`, `throw`, `push`, `wave`,
`reach`, `cross-arms`, `phone`, `punch`, and `block`.

Pose controls use portable names such as `head.yaw`, `torso.pitch`,
`leftShoulder.pitch`, and `rightKnee.bend`. `body.offsetY` is measured in meters; other controls
are measured in degrees.

Joint limits are control-specific:

- `body.offsetY`: -1 to 1 m;
- elbow and knee bend: 0 to 150 degrees;
- shoulder and hip pitch: -120 to 120 degrees;
- other angular controls: -90 to 90 degrees.

Child and chibi body types use narrower angular limits. Let the inspector clamp values rather than
forcing extreme joints.

## IK targets

The supported effectors are `leftHand`, `rightHand`, `leftFoot`, and `rightFoot`. Each target and
pole is expressed in **character-local meters**, not world coordinates. Weight is 0–1 and reach
clamp is 0.05–1. The solver is a two-bone, no-stretch solver, so an unreachable target remains at
the permitted reach instead of lengthening the limb.

Use IK after the base motion and pose look correct. For a planted foot or a hand touching a prop:

1. Place the character and prop.
2. Set the base motion or pose.
3. Add one effector with a conservative reach clamp.
4. Inspect the elbow or knee direction controlled by the pole.
5. Add remaining effectors one at a time.

This solver currently drives browser-rendered characters. A provisioned Blender character
keeps the same project IK data but does not apply it to the native armature until the native
two-bone adapter is implemented.

## Attach an Agent

Every character can be attached to an Agent; once attached, that Agent drives the character's
walking, motion, pose, and movement in possess mode.

1. Select a single character and open the **Properties** tab.
2. In the **Bind Agent** block, pick an Agent Profile or enter the Agent Session ID that drives
   the character (for example `dsh-abc123`).
3. Click **Bind**. The summary shows an **Agent possessed** badge indicating the character is
   taken over by an Agent.
4. Click **Unbind** to take back control. Crowd selections cannot bind yet; select a single
   character.

The binding is also visible in the Stage viewport: a possessed character shows an **Agent**
badge next to its name label. The badge shares the same pointer-transparent screen-space label
as the name, so it never blocks selection or the transform gizmo; it disappears as soon as the
binding is removed, and unbound character labels are unchanged.

The binding is stored in the project JSON as the `agentBinding` field (only character objects may
carry one) and goes through the same revision guard as other character writes; locked characters
require `force` to bind or unbind. Several characters can attach to the same Agent, but each
character carries at most one binding at a time and a rebind simply replaces it.

On the Agent side, use the semantic `director_workbench` author actions:

```bash
npm run stage -- director_workbench '{"op":"author","idempotency_key":"bind-actor-v1","actions":[{"action":"bind_character_agent","object_id":"actor-xbot","session_id":"dsh-abc123"}]}'
npm run stage -- director_workbench '{"op":"author","idempotency_key":"unbind-actor-v1","actions":[{"action":"unbind_character_agent","object_id":"actor-xbot"}]}'
```

Once attached, the session keeps driving the character with the existing actions:
`set_character_motion`, `set_character_pose_controls`, `set_character_ik`, `update_object`
transforms, and `set_animation`. The observe character summary echoes `agent_binding`.

Possess mode also scopes the session's writes: a session that possesses characters may only
mutate those characters. Deleting other objects, editing someone else's character, `start_scene`,
and `replace_project` are rejected by the gateway with a readable error (HTTP 403, code
`possession_scope_violation`). Sessions that possess no character keep full stage-wide authoring.
All character actions still require an explicit `object_id`.

The complete loop — place a character, bind an Agent, drive it with motion/pose, verify the
echoed `agent_binding`, then unbind — is covered by the golden eval task
`tools/evals/tasks/08-character-agent-possession.json`, run through `npm run eval`
(see `tools/evals/README.md` in the repository).

## Quick CLI check

With Director running through `npm run dev`, the following commands inspect the catalog and add a
real X Bot. The CLI observes and binds the exact browser target before the guarded write.

```bash
export STAGE_AGENT_SESSION=character-guide
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_assets","asset_id":"mixamo:x-bot","limit":1}'
npm run stage -- director_workbench '{"op":"catalog","catalog":"character_motions","query":"walk","limit":10}'
npm run stage -- director_workbench '{"op":"observe","fields":["assets","characters","timeline"]}'
npm run stage -- director_workbench '{"op":"author","idempotency_key":"character-guide-xbot-v1","actions":[{"action":"add_object","id":"actor-xbot","name":"X Bot","kind":"character","asset_id":"mixamo:x-bot","transform":{"position":[0,0,0],"rotation":[0,0,0],"scale":[1,1,1]}}]}'
```

If `actor-xbot` already exists, inspect it instead of replaying the creation with a changed payload.
Use a new object ID and idempotency key only for a genuinely new character.

## Acceptance checklist

- The intended local model and its thumbnail load without a fallback placeholder.
- The character object reports `character_source: "asset"` and the expected `asset_id`.
- Feet are on the ground at the sampled frame; the pelvis does not jump when walk/run loops.
- Motion speed and direction match the object trajectory or runtime movement.
- Pose controls refine rather than replace the sampled clip unexpectedly.
- A native Action/Pose change advances Blender once and then remains stable while idle.
- IK limbs do not stretch, flip, or use world-space targets by mistake.
- A helper-free clean camera frame shows the same character, grounding, silhouette, and occlusion.
