# @director/project-schema — Project Schema

> Languages: **English** · [中文](README.zh-CN.md)

Shared Zod schemas and type definitions for the Director project. Contains the DirectorProject document model, camera geometry, pose system, animation, frame rate/timeline, procedural gait, and trajectory math.

**Package:** `@director/project-schema` — `"main": "./src/index.ts"` — Depends: `zod`, `three`, `@director/protocol`

## Files

| Path | Purpose |
| --- | --- |
| `index.ts` | Barrel export for all schema modules |
| `directorProject.ts` | DirectorProject type definitions: exports all types for objects, cameras, lights, animation, materials, storyboard, world |
| `directorProjectSchema.ts` | Zod schema for DirectorProject: full parsing, constant enums (body types, asset kinds, placement modes, etc.), ~1137 lines |
| `directorProjectRevision.ts` | Project revision control: SHA-256 canonicalization for optimistic concurrency and idempotency |
| `directorProjectOptions.json` | Project options data |
| `cameraGeometry.ts` | Camera geometry: viewport parameters, FOV computation, sensor formats, focal length conversion, view snapshot |
| `directorProduction.ts` | Production data: performance takes, coverage sequences, defaults, issue detection |
| `directorAnimation.ts` | Animation system: keyframe interpolation, camera action targets, transform blending |
| `animationEasing.ts` | Easing functions: CSS cubic-bezier curve evaluation (linear, easeIn, easeOut, easeInOut) |
| `frameRate.ts` | Frame rate system: rational frame rates, common rate constants (23.976, 24, 25, 29.97, 30, 59.94, 60), timebase |
| `frameTime.ts` | Frame time: frame range limits, FPS normalization, frame-to-second conversion |
| `poseSchema.ts` | Pose protocol: PosePresetId, CharacterPoseControlKey enum and control value limits |
| `poseProtocol.json` | Pose control keys and preset IDs data |
| `mannequinPosePresets.ts` | Mannequin pose presets: A-pose, T-pose, walking, sitting, fighting, etc. |
| `mannequinPosePresets.json` | Mannequin pose preset data |
| `proceduralGait.ts` | Procedural gait: trajectory motion detection, gait cycle activation |
| `trajectoryMath.ts` | Trajectory math: waypoint evaluation, Bezier curves, arcs, circular trajectories for frame-authoritative transform computation |

## Build

Type-checked as part of the root `npm run build` as an npm workspace.