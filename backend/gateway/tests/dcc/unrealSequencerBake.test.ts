import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  directorTransformToCanonicalDcc,
  directorUnrealSequencerBakeSchema,
  type DirectorUnrealSequencerBake,
} from "@director/dcc-protocol";
import {
  getFocalLengthFromVerticalFov,
  type DirectorCameraShot,
  type DirectorObject,
  type DirectorProject,
} from "@director/project-schema";
import { buildUnrealSequencerBake, writeUnrealSequencerBake } from "../../dcc/unrealSequencerBake";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";

const REVISION = `director-project-revision:v1:sha256:${"d".repeat(64)}`;

function withTimeline(
  project: DirectorProject,
  frameStart: number,
  frameEnd: number,
  timebase?: NonNullable<NonNullable<DirectorProject["scene"]["timeline"]>["timebase"]>,
): DirectorProject {
  return {
    ...project,
    scene: {
      ...project.scene,
      timeline: {
        version: 1,
        fps: 24,
        ...(timebase ? { timebase } : {}),
        frameStart,
        frameEnd,
        currentFrame: frameStart,
        loop: false,
      },
    },
  };
}

function staticBox(id = "box-static"): DirectorObject {
  return {
    id,
    name: "Static Box",
    kind: "prop",
    visible: true,
    locked: false,
    transform: { position: [1, 0, -2], rotation: [0, 0, 0], scale: [1, 1, 1] },
  };
}

function slidingBox(id = "box-sliding"): DirectorObject {
  return {
    ...staticBox(id),
    name: "Sliding Box",
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    animation: {
      version: 1,
      keyframes: [
        {
          frame: 0,
          interpolation: "linear",
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
        {
          frame: 24,
          interpolation: "linear",
          transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        },
      ],
    },
  };
}

function zoomingCamera(id = "cam-zoom"): DirectorCameraShot {
  return {
    id,
    name: "Zooming Camera",
    fov: 40,
    transform: { position: [0, 1.6, 5], rotation: [0, 0, 0], scale: [1, 1, 1] },
    targetMode: "manual",
    target: [0, 1, 0],
    animation: {
      version: 1,
      keyframes: [
        { frame: 0, interpolation: "linear", fov: 40 },
        { frame: 24, interpolation: "linear", fov: 60 },
      ],
    },
  };
}

describe("buildUnrealSequencerBake", () => {
  it("produces an empty, schema-valid bake for a fully static project", () => {
    const project = createTestDirectorProject();
    project.objects = [staticBox()];
    project.cameras = [
      {
        id: "cam-static",
        name: "Static Camera",
        fov: 50,
        transform: { position: [0, 2, 6], rotation: [0, 0, 0], scale: [1, 1, 1] },
        targetMode: "manual",
        target: [0, 0, 0],
      },
    ];
    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    expect(directorUnrealSequencerBakeSchema.parse(bake)).toEqual(bake);
    expect(bake.entities).toEqual([]);
    expect(bake.frameStride).toBe(1);
    // Default timebase: 24 fps NDF starting at zero.
    expect(bake.timebase).toEqual({
      rate: { numerator: 24, denominator: 1 },
      dropFrame: false,
      startTimecode: "00:00:00:00",
    });
  });

  it("bakes object keyframes into per-frame canonical-space world samples", () => {
    const project = withTimeline(createTestDirectorProject(), 0, 24);
    project.objects = [staticBox(), slidingBox()];
    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    expect(directorUnrealSequencerBakeSchema.parse(bake)).toEqual(bake);

    // The static object contributes no track; the animated one is dense-sampled.
    expect(bake.entities.map(({ directorId }) => directorId)).toEqual(["box-sliding"]);
    const [entity] = bake.entities;
    expect(entity!.entityType).toBe("object");
    expect(entity!.transformSamples).toHaveLength(25);
    expect(entity!.transformSamples.map(({ frame }) => frame)).toEqual(Array.from({ length: 25 }, (_, index) => index));
    // Linear interpolation endpoints and midpoint in canonical metres.
    expect(entity!.transformSamples[0]!.transform.location).toEqual([0, 0, 0]);
    expect(entity!.transformSamples[12]!.transform.location[0]).toBeCloseTo(1, 6);
    expect(entity!.transformSamples[24]!.transform.location).toEqual([2, 0, 0]);
    // Transforms are canonical Director-space: the connector owns the basis change.
    expect(bake.coordinateSystem).toMatchObject({ unit: "meter", linearMap: "identity" });
  });

  it("composes the scene transform exactly like the static exchange package", () => {
    const project = withTimeline(createTestDirectorProject(), 0, 4);
    project.scene.position = [3, 0, -1];
    project.scene.scale = 2;
    project.objects = [slidingBox()];
    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    const lastSample = bake.entities[0]!.transformSamples.at(-1)!;
    const expected = directorTransformToCanonicalDcc(
      { position: [2 * (4 / 24), 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      { position: [3, 0, -1], rotation: [0, 0, 0], scale: [2, 2, 2] },
    );
    for (let axis = 0; axis < 3; axis += 1) {
      expect(lastSample.transform.location[axis]).toBeCloseTo(expected.location[axis]!, 6);
      expect(lastSample.transform.scale[axis]).toBeCloseTo(expected.scale[axis]!, 6);
    }
  });

  it("derives camera focal-length tracks from vertical fov keys against the filmback", () => {
    const project = withTimeline(createTestDirectorProject(), 0, 24);
    project.cameras = [zoomingCamera()];
    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    expect(directorUnrealSequencerBakeSchema.parse(bake)).toEqual(bake);

    const [camera] = bake.entities;
    expect(camera!.entityType).toBe("camera");
    expect(camera!.filmback!.sensorWidthMm).toBeGreaterThan(0);
    expect(camera!.filmback!.sensorHeightMm).toBeGreaterThan(0);
    expect(camera!.focalLengthSamples).toHaveLength(25);
    // Focal length must match Director's own fov->lens conversion at both ends,
    // and a widening fov must shorten the lens monotonically.
    expect(camera!.focalLengthSamples![0]!.focalLengthMm).toBeCloseTo(getFocalLengthFromVerticalFov(40), 6);
    expect(camera!.focalLengthSamples![24]!.focalLengthMm).toBeCloseTo(getFocalLengthFromVerticalFov(60), 6);
    for (let index = 1; index < camera!.focalLengthSamples!.length; index += 1) {
      expect(camera!.focalLengthSamples![index]!.focalLengthMm).toBeLessThan(
        camera!.focalLengthSamples![index - 1]!.focalLengthMm,
      );
    }
  });

  it("warn-and-omits rig pose keys and character rig state instead of inventing bone tracks", () => {
    const project = withTimeline(createTestDirectorProject(), 0, 8);
    const rigged = slidingBox("walker-1");
    rigged.kind = "character";
    rigged.characterRig = { rigType: "mannequin", posePresetId: null, controls: {} };
    rigged.animation!.keyframes[1]!.poseValues = { "arm.L": 0.5 };
    project.objects = [rigged];

    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    const [entity] = bake.entities;
    expect(entity!.omittedChannels).toEqual(expect.arrayContaining(["pose_values", "character_rig"]));
    expect(entity!.warnings.join("\n")).toMatch(/warn-and-omit/);
    // World transforms are still baked even when rig channels are omitted.
    expect(entity!.transformSamples.length).toBeGreaterThan(1);
  });

  it("names the omitted controls and clips in structured per-channel details", () => {
    const project = withTimeline(createTestDirectorProject(), 0, 8);
    const rigged = slidingBox("walker-2");
    rigged.kind = "character";
    rigged.characterRig = { rigType: "mannequin", posePresetId: null, controls: { "spine.bend": 0.25, "head.nod": 0 } };
    rigged.animation!.keyframes[0]!.poseValues = { "arm.L": 0.5, "arm.R": 0.25 };
    rigged.animation!.keyframes[1]!.poseValues = { "arm.L": 1 };
    rigged.animation!.motionBlocks = [
      {
        id: "block-1",
        clipId: "walk-cycle",
        enabled: true,
        loop: "repeat",
        speed: 1,
        weight: 1,
        blendInS: 0,
        blendOutS: 0,
        rootMotion: "in-place",
        frameStart: 0,
        frameEnd: 8,
      },
    ];
    project.objects = [rigged];

    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    expect(directorUnrealSequencerBakeSchema.parse(bake)).toEqual(bake);
    const [entity] = bake.entities;
    const details = Object.fromEntries(entity!.omittedChannelDetails!.map((detail) => [detail.channel, detail]));
    // Every detail channel is also listed in omittedChannels (schema-enforced),
    // and control/clip names are deduplicated and sorted for stable receipts.
    expect(Object.keys(details).sort()).toEqual(["character_rig", "motion_blocks", "pose_values"]);
    expect(details.pose_values!.controls).toEqual(["arm.L", "arm.R"]);
    expect(details.pose_values!.reason).toMatch(/Control Rig transfer is planned/);
    expect(details.motion_blocks!.controls).toEqual(["walk-cycle"]);
    expect(details.character_rig!.controls).toEqual(["head.nod", "spine.bend"]);
  });

  it("caps the listed control names and says how many overflowed", () => {
    const project = withTimeline(createTestDirectorProject(), 0, 4);
    const rigged = slidingBox("walker-3");
    rigged.animation!.keyframes[0]!.poseValues = Object.fromEntries(
      Array.from({ length: 80 }, (_, index) => [`control.${String(index).padStart(3, "0")}`, 0.5]),
    );
    project.objects = [rigged];

    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    expect(directorUnrealSequencerBakeSchema.parse(bake)).toEqual(bake);
    const detail = bake.entities[0]!.omittedChannelDetails!.find((entry) => entry.channel === "pose_values")!;
    expect(detail.controls).toHaveLength(64);
    expect(detail.reason).toMatch(/16 more not listed/);
  });

  it.each([
    ["23.976 NDF", { numerator: 24_000, denominator: 1_001 }, false, "00:59:56:16", false],
    ["24 NDF", { numerator: 24, denominator: 1 }, false, "01:00:00:00", false],
    ["25 NDF", { numerator: 25, denominator: 1 }, false, "10:00:00:00", false],
    ["29.97 DF", { numerator: 30_000, denominator: 1_001 }, true, "01:00:00;02", true],
    ["30 NDF", { numerator: 30, denominator: 1 }, false, "00:00:30:00", false],
  ] as const)(
    "carries the %s broadcast timebase through to the bake",
    (_label, rate, requestedDropFrame, startTimecode, expectedDropFrame) => {
      const project = withTimeline(createTestDirectorProject(), 0, 48, {
        rate,
        dropFrame: requestedDropFrame,
        startTimecode,
      });
      project.objects = [slidingBox()];
      const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
      expect(directorUnrealSequencerBakeSchema.parse(bake)).toEqual(bake);
      expect(bake.timebase).toEqual({ rate, dropFrame: expectedDropFrame, startTimecode });
      expect(bake.playback).toEqual({ frameStart: 0, frameEnd: 48 });
    },
  );

  it("rejects a drop-frame request on rates without the SMPTE convention", () => {
    const project = withTimeline(createTestDirectorProject(), 0, 8, {
      rate: { numerator: 24, denominator: 1 },
      dropFrame: true,
      startTimecode: "00:00:00:00",
    });
    project.objects = [slidingBox()];
    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    expect(bake.timebase.dropFrame).toBe(false);
  });

  it("downsamples past the sample budget with a warning and always keys the final frame", () => {
    const frameEnd = 120_000;
    const project = withTimeline(createTestDirectorProject(), 0, frameEnd);
    const first = slidingBox("budget-a");
    const second = slidingBox("budget-b");
    first.animation!.keyframes[1]!.frame = frameEnd;
    second.animation!.keyframes[1]!.frame = frameEnd;
    project.objects = [first, second];

    const bake = buildUnrealSequencerBake(project, randomUUID(), REVISION);
    expect(bake.frameStride).toBeGreaterThan(1);
    expect(bake.warnings.join("\n")).toMatch(/downsampled/i);
    for (const entity of bake.entities) {
      expect(entity.transformSamples.at(-1)!.frame).toBe(frameEnd);
      expect(entity.transformSamples.length).toBeLessThanOrEqual(Math.ceil(frameEnd / bake.frameStride) + 1);
    }
    expect(directorUnrealSequencerBakeSchema.parse(bake)).toEqual(bake);
  });
});

describe("writeUnrealSequencerBake", () => {
  it("writes animation.json whose pinned SHA-256 covers the exact bytes on disk", async () => {
    const jobDirectory = await mkdtemp(resolve(tmpdir(), "director-unreal-bake-"));
    const project = withTimeline(createTestDirectorProject(), 0, 12);
    project.objects = [slidingBox()];
    const packageId = randomUUID();

    const written = await writeUnrealSequencerBake(project, packageId, REVISION, jobDirectory);
    expect(written.bakePath).toBe(resolve(jobDirectory, "animation.json"));

    const body = await readFile(written.bakePath);
    expect(createHash("sha256").update(body).digest("hex")).toBe(written.bakeSha256);
    expect(body.toString("utf8").endsWith("\n")).toBe(true);

    const parsed = directorUnrealSequencerBakeSchema.parse(
      JSON.parse(body.toString("utf8")),
    ) satisfies DirectorUnrealSequencerBake;
    expect(parsed).toEqual(written.bake);
    expect(parsed.packageId).toBe(packageId);
    expect(parsed.sourceRevision).toBe(REVISION);
  });
});
