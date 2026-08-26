import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { directorGodotAnimationBakeSchema } from "@director/dcc-protocol";
import type { DirectorProject } from "@director/project-schema";
import { buildGodotAnimationBake, writeGodotAnimationBake } from "../../dcc/godotAnimationBake";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";

const PACKAGE_ID = "7c1de5c8-4a70-4de4-9dc3-8f4f5f8b2ad1";
const REVISION = `director-project-revision:v1:sha256:${"b".repeat(64)}`;

function withTimeline(project: DirectorProject, frameEnd: number): DirectorProject {
  project.scene.timeline = {
    version: 1,
    fps: 23.976,
    timebase: {
      rate: { numerator: 24000, denominator: 1001 },
      dropFrame: false,
      startTimecode: "00:00:00:00",
    },
    frameStart: 0,
    frameEnd,
    currentFrame: 0,
    loop: false,
  };
  return project;
}

function animatedObject(id: string, endX: number) {
  return {
    id,
    name: `Prop ${id}`,
    kind: "prop" as const,
    visible: true,
    locked: false,
    transform: {
      position: [0, 0, 0] as [number, number, number],
      rotation: [0, 0, 0] as [number, number, number],
      scale: [1, 1, 1] as [number, number, number],
    },
    animation: {
      version: 1 as const,
      keyframes: [
        {
          frame: 0,
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
        {
          frame: 24,
          transform: {
            position: [endX, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
        },
      ],
    },
  };
}

describe("buildGodotAnimationBake", () => {
  it("samples animated objects on the rational timebase and skips static ones", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    project.objects = [
      animatedObject("obj-anim", 4),
      {
        id: "obj-static",
        name: "Static",
        kind: "prop",
        visible: true,
        locked: false,
        transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(directorGodotAnimationBakeSchema.parse(bake)).toEqual(bake);
    expect(bake.packageId).toBe(PACKAGE_ID);
    expect(bake.sourceRevision).toBe(REVISION);
    expect(bake.timebase.rate).toEqual({ numerator: 24000, denominator: 1001 });
    expect(bake.frameStride).toBe(1);
    expect(bake.entities.map(({ directorId }) => directorId)).toEqual(["obj-anim"]);

    const samples = bake.entities[0]!.transformSamples;
    expect(samples).toHaveLength(25);
    expect(samples[0]!.frame).toBe(0);
    expect(samples[0]!.transform.location).toEqual([0, 0, 0]);
    expect(samples.at(-1)!.frame).toBe(24);
    expect(samples.at(-1)!.transform.location[0]).toBeCloseTo(4, 6);
  });

  it("bakes camera fov keys and aims transforms with the camera look rotation", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    project.cameras = [
      {
        id: "cam-main",
        name: "Main",
        fov: 40,
        transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
        targetMode: "manual",
        target: [0, 1, 0],
        animation: {
          version: 1,
          keyframes: [
            { frame: 0, fov: 40 },
            { frame: 24, fov: 60 },
          ],
        },
      },
    ];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.entities.map(({ entityType }) => entityType)).toEqual(["camera"]);
    const camera = bake.entities[0]!;
    expect(camera.fovSamples![0]).toEqual({ frame: 0, fovDeg: 40 });
    expect(camera.fovSamples!.at(-1)).toEqual({ frame: 24, fovDeg: 60 });
    // The look rotation pitches the camera down towards the target below it,
    // so the sampled quaternion cannot be identity.
    const quaternion = camera.transformSamples[0]!.transform.rotationQuaternion;
    expect(Math.abs(quaternion[3]!)).toBeLessThan(1 - 1e-6);
  });

  it("composes the Director scene transform into canonical world samples", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    project.scene.scale = 2;
    project.scene.position = [10, 0, 0];
    project.objects = [animatedObject("obj-anim", 4)];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    const samples = bake.entities[0]!.transformSamples;
    expect(samples[0]!.transform.location).toEqual([10, 0, 0]);
    expect(samples.at(-1)!.transform.location[0]).toBeCloseTo(18, 6);
    expect(samples[0]!.transform.scale).toEqual([2, 2, 2]);
  });

  it("warns and omits rig pose channels instead of silently flattening them", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    const object = animatedObject("obj-posed", 4);
    object.animation.keyframes[0] = {
      ...object.animation.keyframes[0]!,
      poseValues: { arm_l: 0.5 },
    } as (typeof object.animation.keyframes)[number];
    project.objects = [object];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.entities[0]!.omittedChannels).toEqual(["pose_values"]);
    expect(bake.entities[0]!.warnings.join("\n")).toMatch(/warn-and-omit/);
  });

  it("carries structured omitted detail for pose controls and motion clips", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    const object = animatedObject("obj-rigged", 4);
    object.animation.keyframes[0] = {
      ...object.animation.keyframes[0]!,
      poseValues: { arm_l: 0.5, head: 0.2 },
    } as (typeof object.animation.keyframes)[number];
    object.animation.keyframes[1] = {
      ...object.animation.keyframes[1]!,
      poseValues: { arm_r: 1 },
    } as (typeof object.animation.keyframes)[number];
    (object.animation as { motionBlocks?: unknown[] }).motionBlocks = [
      {
        id: "clip-walk",
        clipId: "mixamo-walk",
        enabled: true,
        loop: "repeat",
        speed: 1,
        weight: 1,
        blendInS: 0.2,
        blendOutS: 0.2,
        rootMotion: "in-place",
        frameStart: 0,
        frameEnd: 20,
      },
    ];
    project.objects = [object];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    const entity = bake.entities[0]!;
    expect(entity.omittedChannels).toEqual(["pose_values", "motion_blocks"]);
    expect(entity.omittedDetail).toEqual({
      poseControlCount: 3,
      poseControls: ["arm_l", "arm_r", "head"],
      motionClipCount: 1,
      motionClips: [{ id: "clip-walk", frameStart: 0, frameEnd: 20 }],
    });
    const warningText = entity.warnings.join("\n");
    expect(warningText).toMatch(/warn-and-omit code: pose_values/);
    expect(warningText).toMatch(/warn-and-omit code: motion_blocks/);
    // Motion clips are in-place; the honest claim is that the root path is baked.
    expect(warningText).toMatch(/root path is baked/);
    expect(warningText).toMatch(/3 pose controls affected/);
  });

  it("bakes storyboard shot ranges sorted, clamped, and warn-and-omitted honestly", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    project.objects = [animatedObject("obj-anim", 4)];
    project.cameras = [
      {
        id: "cam-main",
        name: "Main",
        fov: 40,
        transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
        targetMode: "manual",
        target: [0, 1, 0],
      },
    ];
    project.storyboard = {
      version: 1,
      title: "Board",
      logline: "Fixture",
      shots: [
        {
          id: "shot-late",
          title: "Late",
          cameraId: "cam-main",
          frameStart: 12,
          frameEnd: 40,
          shotSize: "medium",
          movement: "static",
          action: "Clamped into the window.",
        },
        {
          id: "shot-early",
          title: "Early",
          cameraId: "cam-missing",
          frameStart: 0,
          frameEnd: 10,
          shotSize: "wide",
          movement: "static",
          action: "Unknown camera warns.",
        },
        {
          id: "shot-out",
          title: "Outside",
          cameraId: "cam-main",
          frameStart: 90,
          frameEnd: 120,
          shotSize: "insert",
          movement: "static",
          action: "Fully outside the window.",
        },
        {
          id: "shot-early",
          title: "Duplicate",
          cameraId: "cam-main",
          frameStart: 5,
          frameEnd: 6,
          shotSize: "wide",
          movement: "static",
          action: "Duplicate id is skipped.",
        },
      ],
    };
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.shots).toEqual([
      { shotId: "shot-early", title: "Early", cameraDirectorId: "cam-missing", frameStart: 0, frameEnd: 10 },
      { shotId: "shot-late", title: "Late", cameraDirectorId: "cam-main", frameStart: 12, frameEnd: 24 },
    ]);
    // Every shot omission/adjustment carries its structured code, never prose alone.
    const warningText = bake.warnings.join("\n");
    expect(warningText).toMatch(/shot-late was clamped/);
    expect(warningText).toMatch(/code: shot_clamped_to_playback/);
    expect(warningText).toMatch(/shot_outside_playback/);
    expect(warningText).toMatch(/shot_camera_not_imported/);
    expect(warningText).toMatch(/shot-early appears more than once/);
    expect(warningText).toMatch(/warn-and-omit code: shot_duplicate_id/);
  });

  it("omits the shots block entirely when the storyboard is empty", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    project.objects = [animatedObject("obj-anim", 4)];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.shots).toBeUndefined();
  });

  it("widens the frame stride with a warning instead of blowing the sample budget", () => {
    const project = withTimeline(createTestDirectorProject(), 1201);
    project.objects = [
      animatedObject("obj-anim", 4),
      ...Array.from({ length: 99 }, (_, index) => ({
        id: `obj-static-${index}`,
        name: `Static ${index}`,
        kind: "prop" as const,
        visible: true,
        locked: false,
        transform: {
          position: [index, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          scale: [1, 1, 1] as [number, number, number],
        },
      })),
    ];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.frameStride).toBeGreaterThan(1);
    expect(bake.warnings.join("\n")).toMatch(/downsampled/);
    // The final frame is always sampled so the end pose is exact.
    expect(bake.entities[0]!.transformSamples.at(-1)!.frame).toBe(1201);
  });

  it("covers authored keyframes when the project has no timeline", () => {
    const project = createTestDirectorProject();
    project.objects = [animatedObject("obj-anim", 4)];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.playback).toEqual({ frameStart: 0, frameEnd: 24 });
    expect(bake.entities[0]!.transformSamples.at(-1)!.frame).toBe(24);
  });

  it("handles a negative playback start on the rational timebase without losing the window edges", () => {
    const project = withTimeline(createTestDirectorProject(), 12);
    project.scene.timeline!.frameStart = -12;
    project.objects = [animatedObject("obj-anim", 4)];
    project.cameras = [
      {
        id: "cam-main",
        name: "Main",
        fov: 40,
        transform: { position: [0, 2, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
        targetMode: "manual",
        target: [0, 1, 0],
      },
    ];
    project.storyboard = {
      version: 1,
      title: "Negative board",
      logline: "Pre-roll cut",
      shots: [
        {
          id: "shot-preroll",
          title: "Preroll",
          cameraId: "cam-main",
          frameStart: -30,
          frameEnd: -4,
          shotSize: "wide",
          movement: "static",
          action: "Clamps into the negative window edge.",
        },
      ],
    };
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.playback).toEqual({ frameStart: -12, frameEnd: 12 });
    const samples = bake.entities[0]!.transformSamples;
    expect(samples[0]!.frame).toBe(-12);
    expect(samples.at(-1)!.frame).toBe(12);
    // Frames stay strictly increasing across the sign boundary.
    for (let index = 1; index < samples.length; index += 1) {
      expect(samples[index]!.frame).toBeGreaterThan(samples[index - 1]!.frame);
    }
    expect(bake.shots).toEqual([
      { shotId: "shot-preroll", title: "Preroll", cameraDirectorId: "cam-main", frameStart: -12, frameEnd: -4 },
    ]);
    expect(bake.warnings.join("\n")).toMatch(/code: shot_clamped_to_playback/);
  });

  it("carries a drop-frame rational timebase untouched (29.97 DF never becomes a rounded float)", () => {
    const project = createTestDirectorProject();
    project.scene.timeline = {
      version: 1,
      fps: 29.97,
      timebase: {
        rate: { numerator: 30000, denominator: 1001 },
        dropFrame: true,
        startTimecode: "00:59:59;28",
      },
      frameStart: 0,
      frameEnd: 30,
      currentFrame: 0,
      loop: false,
    };
    project.objects = [animatedObject("obj-anim", 4)];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    expect(bake.timebase).toEqual({
      rate: { numerator: 30000, denominator: 1001 },
      dropFrame: true,
      startTimecode: "00:59:59;28",
    });
    expect(directorGodotAnimationBakeSchema.parse(bake)).toEqual(bake);
  });

  it("caps omittedDetail samples at 32 while the counts stay authoritative", () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    const object = animatedObject("obj-crowded", 4);
    const poseValues = Object.fromEntries(
      // 0..39 zero-padded so the sorted sample keeps a deterministic prefix.
      Array.from({ length: 40 }, (_, index) => [`ctrl_${String(index).padStart(2, "0")}`, index / 40]),
    );
    object.animation.keyframes[0] = {
      ...object.animation.keyframes[0]!,
      poseValues,
    } as (typeof object.animation.keyframes)[number];
    (object.animation as { motionBlocks?: unknown[] }).motionBlocks = Array.from({ length: 40 }, (_, index) => ({
      id: `clip-${String(index).padStart(2, "0")}`,
      clipId: "mixamo-walk",
      enabled: true,
      loop: "repeat",
      speed: 1,
      weight: 1,
      blendInS: 0.1,
      blendOutS: 0.1,
      rootMotion: "in-place",
      frameStart: index,
      frameEnd: index + 1,
    }));
    project.objects = [object];
    const bake = buildGodotAnimationBake(project, PACKAGE_ID, REVISION);
    const detail = bake.entities[0]!.omittedDetail!;
    expect(detail.poseControlCount).toBe(40);
    expect(detail.poseControls).toHaveLength(32);
    expect(detail.poseControls[0]).toBe("ctrl_00");
    expect(detail.poseControls.at(-1)).toBe("ctrl_31");
    expect(detail.motionClipCount).toBe(40);
    expect(detail.motionClips).toHaveLength(32);
    expect(detail.motionClips.at(-1)).toEqual({ id: "clip-31", frameStart: 31, frameEnd: 32 });
    // The capped detail still validates against the wire schema.
    expect(directorGodotAnimationBakeSchema.parse(bake)).toEqual(bake);
    const warningText = bake.entities[0]!.warnings.join("\n");
    expect(warningText).toMatch(/40 pose controls affected/);
    expect(warningText).toMatch(/40 clips affected/);
  });
});

describe("writeGodotAnimationBake", () => {
  it("writes animation.json whose SHA-256 pins the exact bytes on disk", async () => {
    const project = withTimeline(createTestDirectorProject(), 24);
    project.objects = [animatedObject("obj-anim", 4)];
    const jobDirectory = await mkdtemp(resolve(tmpdir(), "director-godot-bake-"));
    const written = await writeGodotAnimationBake(project, PACKAGE_ID, REVISION, jobDirectory);
    expect(written.bakePath).toBe(resolve(jobDirectory, "animation.json"));
    const bytes = await readFile(written.bakePath);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(written.bakeSha256);
    const reparsed = directorGodotAnimationBakeSchema.parse(JSON.parse(bytes.toString("utf8")));
    expect(reparsed).toEqual(written.bake);
  });
});
