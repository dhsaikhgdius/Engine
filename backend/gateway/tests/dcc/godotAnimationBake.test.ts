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
      version: 1,
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
