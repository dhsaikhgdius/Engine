import { execFile, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { directorUnrealCleanFrameReceiptSchema } from "@director/dcc-protocol";

const execFileAsync = promisify(execFile);

/** The committed Unreal connector Python sources under test. */
const CONNECTOR_PYTHON_DIR = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "integrations",
  "unreal",
  "plugins",
  "DirectorBridge",
  "Content",
  "Python",
);

const pythonProbe = spawnSync("python3", ["--version"], { encoding: "utf8" });
const pythonAvailable = pythonProbe.status === 0;

interface PythonResult {
  code: number;
  output: Record<string, unknown>;
}

async function runModule(module: string, args: string[] = [], stdin?: string): Promise<PythonResult> {
  const child = execFileAsync("python3", [resolve(CONNECTOR_PYTHON_DIR, `${module}.py`), ...args], {
    timeout: 30_000,
  });
  if (stdin !== undefined) {
    child.child.stdin!.end(stdin);
  }
  const { stdout } = await child.catch((error: { stdout?: string; code?: number }) => ({
    stdout: error.stdout ?? "",
    code: error.code ?? 1,
  }));
  const lastLine = stdout.trim().split("\n").at(-1) ?? "{}";
  return { code: 0, output: JSON.parse(lastLine) as Record<string, unknown> };
}

async function runTimebaseOp(payload: Record<string, unknown>): Promise<unknown> {
  const { output } = await runModule("director_timebase", [], JSON.stringify(payload));
  expect(output.ok).toBe(true);
  return output.result;
}

const REVISION = `director-project-revision:v1:sha256:${"e".repeat(64)}`;

function directorYawQuaternion(degrees: number): [number, number, number, number] {
  const half = (degrees * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function bakeSidecar(entities: unknown[], packageId: string): string {
  return `${JSON.stringify(
    {
      contract: "director-unreal-sequencer-bake-v1",
      schemaVersion: 1,
      packageId,
      provider: "unreal",
      sourceRevision: REVISION,
      coordinateSystem: {
        source: "right-handed-y-up-negative-z-forward",
        destination: "right-handed-y-up-negative-z-forward",
        unit: "meter",
        linearMap: "identity",
      },
      timebase: { rate: { numerator: 24, denominator: 1 }, dropFrame: false, startTimecode: "00:00:00:00" },
      playback: { frameStart: 0, frameEnd: 72 },
      frameStride: 1,
      entities,
      warnings: [],
    },
    null,
    2,
  )}\n`;
}

async function writeSidecar(body: string): Promise<{ path: string; sha256: string }> {
  const directory = await mkdtemp(resolve(tmpdir(), "director-unreal-sidecar-"));
  const path = resolve(directory, "animation.json");
  await writeFile(path, body, "utf8");
  return { path, sha256: createHash("sha256").update(body).digest("hex") };
}

function glbBuffer(document: Record<string, unknown>): Buffer {
  const json = Buffer.from(JSON.stringify(document), "utf8");
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // "glTF"
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(padded.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // "JSON"
  return Buffer.concat([header, chunkHeader, padded]);
}

function srgbToLinear(component: number): number {
  return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
}

describe.skipIf(!pythonAvailable)(
  "Unreal connector Python modules (host-free, skipped when python3 is not on PATH)",
  () => {
    it("passes the committed self-tests for space, timebase, and bake math", async () => {
      for (const module of ["director_space", "director_timebase", "director_bake"]) {
        const { output } = await runModule(module, ["--self-test"]);
        expect(output, `${module} --self-test`).toMatchObject({ ok: true });
      }
    });

    it("compiles every connector module, including the host-only ones that import unreal", async () => {
      // director_headless / director_sequencer / director_host_materials need the
      // in-editor `unreal` module to run, but their syntax is still verified here.
      const modules = [
        "director_headless",
        "director_package",
        "director_space",
        "director_timebase",
        "director_bake",
        "director_materials",
        "director_host_materials",
        "director_gltf",
        "director_lights",
        "director_livelink",
        "director_sequencer",
      ];
      await execFileAsync("python3", [
        "-m",
        "py_compile",
        ...modules.map((module) => resolve(CONNECTOR_PYTHON_DIR, `${module}.py`)),
      ]);
    });

    describe("director_timebase golden fixtures (23.976 / 24 / 25 / 29.97 DF / 30)", () => {
      it.each([
        [23.976, [24_000, 1_001]],
        [24, [24, 1]],
        [25, [25, 1]],
        [29.97, [30_000, 1_001]],
        [30, [30, 1]],
        ["30000/1001", [30_000, 1_001]],
      ])("normalizes %s to a reduced rational rate", async (input, expected) => {
        await expect(runTimebaseOp({ op: "normalize_rate", rate: input })).resolves.toEqual(expected);
      });

      it.each([
        // 23.976, 24, 25, and 30 divide Unreal's default 24000-tick second.
        [
          [24_000, 1_001],
          [24_000, 1],
        ],
        [
          [24, 1],
          [24_000, 1],
        ],
        [
          [25, 1],
          [24_000, 1],
        ],
        [
          [30, 1],
          [24_000, 1],
        ],
        // NTSC 29.97 does not; the connector pins numerator/1 for integer ticks.
        [
          [30_000, 1_001],
          [30_000, 1],
        ],
      ])("derives the Sequencer tick resolution for rate %j", async (rate, expected) => {
        await expect(runTimebaseOp({ op: "tick_resolution", rate })).resolves.toEqual(expected);
      });

      it.each([
        // One NDF hour counts at the nominal integer rate.
        ["01:00:00:00", [24, 1], false, 86_400],
        ["01:00:00:00", [24_000, 1_001], false, 86_400],
        ["10:01:30:20", [25, 1], false, 902_270],
        ["00:00:59:29", [30, 1], false, 1_799],
        // 29.97 DF skips frame numbers 0 and 1 every minute except each tenth.
        ["00:01:00;02", [30_000, 1_001], true, 1_800],
        ["00:10:00;00", [30_000, 1_001], true, 17_982],
        ["01:00:00;00", [30_000, 1_001], true, 107_892],
      ])("round-trips SMPTE timecode %s", async (timecode, rate, dropFrame, frame) => {
        await expect(runTimebaseOp({ op: "parse_timecode", timecode, rate, dropFrame })).resolves.toBe(frame);
        await expect(runTimebaseOp({ op: "format_timecode", frame, rate, dropFrame })).resolves.toBe(timecode);
      });

      it("rejects dropped frame numbers and drop-frame syntax on non-NTSC rates", async () => {
        await expect(
          runTimebaseOp({ op: "parse_timecode", timecode: "00:01:00;00", rate: [30_000, 1_001], dropFrame: true }),
        ).resolves.toBeNull();
        await expect(
          runTimebaseOp({ op: "parse_timecode", timecode: "00:01:00;02", rate: [24, 1] }),
        ).resolves.toBeNull();
      });

      it("resolves manifest timebases with legacy-fps fallback and start-timecode validation", async () => {
        await expect(
          runTimebaseOp({
            op: "timebase_from_manifest",
            timeline: { fps: 29.97, timebase: { dropFrame: true, startTimecode: "01:00:00;02" } },
          }),
        ).resolves.toEqual({
          rate: { numerator: 30_000, denominator: 1_001 },
          dropFrame: true,
          startTimecode: "01:00:00;02",
        });
        // A start timecode naming a dropped frame falls back to zero.
        await expect(
          runTimebaseOp({
            op: "timebase_from_manifest",
            timeline: {
              timebase: {
                rate: { numerator: 30_000, denominator: 1_001 },
                dropFrame: true,
                startTimecode: "00:01:00;00",
              },
            },
          }),
        ).resolves.toMatchObject({ startTimecode: "00:00:00;00" });
        await expect(runTimebaseOp({ op: "timebase_from_manifest", timeline: null })).resolves.toEqual({
          rate: { numerator: 24, denominator: 1 },
          dropFrame: false,
          startTimecode: "00:00:00:00",
        });
      });
    });

    describe("director_bake sidecar verification and key conversion", () => {
      it("converts canonical samples to Unreal keys with the pinned basis change", async () => {
        const packageId = randomUUID();
        const sidecar = await writeSidecar(
          bakeSidecar(
            [
              {
                directorId: "obj-1",
                entityType: "object",
                name: "Golden Object",
                transformSamples: [
                  {
                    frame: 0,
                    transform: {
                      location: [1, 2, 3],
                      rotationQuaternion: directorYawQuaternion(90),
                      scale: [2, 3, 4],
                    },
                  },
                ],
                warnings: [],
              },
              {
                directorId: "cam-1",
                entityType: "camera",
                name: "Golden Camera",
                transformSamples: [
                  { frame: 0, transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] } },
                ],
                focalLengthSamples: [{ frame: 0, focalLengthMm: 35.5 }],
                filmback: { sensorWidthMm: 36, sensorHeightMm: 20.25 },
                warnings: [],
              },
            ],
            packageId,
          ),
        );
        const { output } = await runModule("director_bake", [
          "--load",
          sidecar.path,
          "--sha256",
          sidecar.sha256,
          "--package-id",
          packageId,
          "--source-revision",
          REVISION,
        ]);
        expect(output.ok).toBe(true);
        // 2 transform samples x 9 double channels + 1 focal key.
        expect(output.keyCount).toBe(19);

        const keys = output.keys as Record<
          string,
          {
            transform: Array<{ frame: number; location: number[]; rotation: number[]; scale: number[] }>;
            focalLength: Array<{ frame: number; focalLengthMm: number }>;
          }
        >;
        const objectKey = keys["obj-1"]!.transform[0]!;
        // Director metres (x,y,z) -> Unreal centimetres (-z, x, y).
        expect(objectKey.location).toEqual([-300, 100, 200]);
        // +90 degree Director yaw (about Y-up) is a -90 degree Unreal yaw.
        expect(objectKey.rotation[0]).toBeCloseTo(0, 6);
        expect(objectKey.rotation[1]).toBeCloseTo(0, 6);
        expect(objectKey.rotation[2]).toBeCloseTo(-90, 6);
        // Scale permutes onto Unreal axes: (x,y,z) -> (z,x,y).
        expect(objectKey.scale).toEqual([4, 2, 3]);

        const cameraKeys = keys["cam-1"]!;
        expect(cameraKeys.transform[0]!.rotation.map((value) => Math.round(value) || 0)).toEqual([0, 0, 0]);
        expect(cameraKeys.focalLength).toEqual([{ frame: 0, focalLengthMm: 35.5 }]);
      });

      it("unwraps dense rotation keys continuously instead of spinning through +/-180", async () => {
        const packageId = randomUUID();
        const sidecar = await writeSidecar(
          bakeSidecar(
            [
              {
                directorId: "spinner",
                entityType: "object",
                name: "Spinner",
                transformSamples: [0, 150, 300, 450].map((degrees, index) => ({
                  frame: index * 24,
                  transform: {
                    location: [0, 0, 0],
                    rotationQuaternion: directorYawQuaternion(degrees),
                    scale: [1, 1, 1],
                  },
                })),
                warnings: [],
              },
            ],
            packageId,
          ),
        );
        const { output } = await runModule("director_bake", [
          "--load",
          sidecar.path,
          "--sha256",
          sidecar.sha256,
          "--package-id",
          packageId,
          "--source-revision",
          REVISION,
        ]);
        expect(output.ok).toBe(true);
        const keys = output.keys as Record<string, { transform: Array<{ rotation: number[] }> }>;
        const yawKeys = keys.spinner!.transform.map((key) => key.rotation[2]!);
        expect(yawKeys.map((value) => Math.round(value))).toEqual([0, -150, -300, -450]);
      });

      it.each([
        ["a tampered byte", (body: string) => body.replace('"frameEnd": 72', '"frameEnd": 96'), /SHA-256 mismatch/],
        ["a mismatched package id", null, /packageId does not match/],
      ] as const)("refuses %s", async (_label, tamper, expectedError) => {
        const packageId = randomUUID();
        const body = bakeSidecar([], packageId);
        const sha256 = createHash("sha256").update(body).digest("hex");
        const written = await writeSidecar(tamper ? tamper(body) : body);
        const { output } = await runModule("director_bake", [
          "--load",
          written.path,
          "--sha256",
          sha256,
          "--package-id",
          tamper ? packageId : randomUUID(),
          "--source-revision",
          REVISION,
        ]);
        expect(output.ok).toBe(false);
        expect(String(output.error)).toMatch(expectedError);
      });

      it("refuses non-increasing sample frames", async () => {
        const packageId = randomUUID();
        const sidecar = await writeSidecar(
          bakeSidecar(
            [
              {
                directorId: "bad-frames",
                entityType: "object",
                name: "Bad Frames",
                transformSamples: [10, 10].map((frame) => ({
                  frame,
                  transform: { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
                })),
                warnings: [],
              },
            ],
            packageId,
          ),
        );
        const { output } = await runModule("director_bake", [
          "--load",
          sidecar.path,
          "--sha256",
          sidecar.sha256,
          "--package-id",
          packageId,
          "--source-revision",
          REVISION,
        ]);
        expect(output.ok).toBe(false);
        expect(String(output.error)).toMatch(/strictly increasing/);
      });
    });

    describe("director_materials PBR mapping", () => {
      it("maps Director PBR parameters onto the parent material slots in linear color", async () => {
        const { output } = await runModule(
          "director_materials",
          [],
          JSON.stringify({
            name: "Crate",
            material: {
              baseColor: "#ff0000",
              metalness: 0.25,
              roughness: 0.5,
              emissiveColor: "#808080",
              emissiveIntensity: 2,
              side: "double",
            },
          }),
        );
        expect(output.ok).toBe(true);
        const result = output.result as {
          parent: string;
          scalars: Record<string, number>;
          vectors: Record<string, number[]>;
          twoSided: boolean;
          omitted: string[];
          warnings: string[];
        };
        expect(result.parent).toBe("opaque");
        expect(result.twoSided).toBe(true);
        expect(result.omitted).toEqual([]);
        expect(result.scalars).toMatchObject({ Metallic: 0.25, Roughness: 0.5, EmissiveIntensity: 2 });
        expect(result.vectors.BaseColor).toEqual([1, 0, 0, 1]);
        const gray = srgbToLinear(128 / 255);
        for (const channel of [0, 1, 2]) {
          expect(result.vectors.EmissiveColor![channel]).toBeCloseTo(gray, 8);
        }
      });

      it("selects the translucent parent for partial opacity and warn-and-omits unsupported channels", async () => {
        const { output } = await runModule(
          "director_materials",
          [],
          JSON.stringify({
            name: "Window",
            material: {
              baseColor: "rgb(0, 128, 255)",
              opacity: 0.5,
              transmission: 0.8,
              clearcoat: 1,
              textures: { map: "textures/glass.png" },
            },
          }),
        );
        const result = (
          output as {
            result: { parent: string; scalars: Record<string, number>; omitted: string[]; warnings: string[] };
          }
        ).result;
        expect(result.parent).toBe("translucent");
        expect(result.scalars.Opacity).toBe(0.5);
        expect(result.omitted).toEqual(expect.arrayContaining(["transmission", "clearcoat", "textures.map"]));
        expect(result.warnings.join("\n")).toMatch(/warn-and-omit/);
        expect(result.warnings.join("\n")).toMatch(/Window/);
      });

      it("warn-and-omits unparseable color syntax instead of guessing", async () => {
        const { output } = await runModule(
          "director_materials",
          [],
          JSON.stringify({ name: "Odd", material: { baseColor: "hsl(120, 50%, 50%)" } }),
        );
        const result = (output as { result: { omitted: string[]; vectors: Record<string, number[]> } }).result;
        expect(result.omitted).toEqual(["baseColor"]);
        expect(result.vectors.BaseColor).toBeUndefined();
      });

      it("binds bundled texture slots to the parent texture parameters and omits unbundled ones", async () => {
        const { output } = await runModule(
          "director_materials",
          [],
          JSON.stringify({
            name: "Crate",
            material: {
              baseColor: "#ffffff",
              textures: {
                baseColorMapAssetId: "asset-albedo",
                normalMapAssetId: "asset-normal",
                roughnessMapAssetId: "asset-rough",
                metalnessMapAssetId: "asset-metal",
                aoMapAssetId: "asset-ao",
                emissiveMapAssetId: "asset-glow",
                alphaMapAssetId: "asset-alpha",
              },
            },
            textureFiles: {
              "asset-albedo": "assets/001-albedo.png",
              "asset-normal": "assets/002-normal.png",
              "asset-rough": "assets/003-rough.png",
              "asset-metal": "assets/004-metal.png",
              "asset-ao": "assets/005-ao.png",
              "asset-glow": "assets/006-glow.png",
              // asset-alpha is intentionally bundled too: it must still omit
              // on an opaque material because the opaque parent has no
              // opacity input.
              "asset-alpha": "assets/007-alpha.png",
            },
          }),
        );
        expect(output.ok).toBe(true);
        const result = output.result as {
          textures: Record<string, string>;
          scalars: Record<string, number>;
          vectors: Record<string, number[]>;
          omitted: string[];
        };
        expect(result.textures).toEqual({
          BaseColorMap: "asset-albedo",
          NormalMap: "asset-normal",
          RoughnessMap: "asset-rough",
          MetalnessMap: "asset-metal",
          AoMap: "asset-ao",
          EmissiveMap: "asset-glow",
        });
        expect(result.omitted).toEqual(["textures.alphaMapAssetId"]);
        // An emissive map forces a visible emissive product by default.
        expect(result.scalars.EmissiveIntensity).toBe(1);
        expect(result.vectors.EmissiveColor).toEqual([1, 1, 1, 1]);
      });

      it("maps the alpha texture on translucent materials and omits unbundled references", async () => {
        const { output } = await runModule(
          "director_materials",
          [],
          JSON.stringify({
            name: "Window",
            material: {
              opacity: 0.5,
              textures: { alphaMapAssetId: "asset-alpha", baseColorMapAssetId: "asset-unbundled" },
            },
            textureFiles: { "asset-alpha": "assets/001-alpha.png" },
          }),
        );
        const result = (output as { result: { parent: string; textures: Record<string, string>; omitted: string[] } })
          .result;
        expect(result.parent).toBe("translucent");
        expect(result.textures).toEqual({ OpacityMap: "asset-alpha" });
        // Referenced but not bundled: structured omit, never a silent drop.
        expect(result.omitted).toEqual(["textures.baseColorMapAssetId"]);
      });
    });

    describe("director_lights golden fixtures (supported subset + structured omits)", () => {
      const scene = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
      const baseLight = { visible: true, locked: false, color: "#ffffff", intensity: 1 };

      async function mapLights(lights: unknown[], sceneOverride: unknown = scene) {
        const { output } = await runModule("director_lights", [], JSON.stringify({ scene: sceneOverride, lights }));
        expect(output.ok).toBe(true);
        return output.result as {
          lights: Array<Record<string, unknown>>;
          omitted: Array<Record<string, unknown>>;
          warnings: string[];
        };
      }

      it("maps directional, point, spot, and rect-area lights onto Unreal light classes", async () => {
        const result = await mapLights([
          {
            ...baseLight,
            id: "sun",
            name: "Sun",
            type: "directional",
            intensity: 1.2,
            position: [0, 5, 0],
            target: [0, 0, 0],
            castShadow: true,
          },
          { ...baseLight, id: "bulb", name: "Bulb", type: "point", intensity: 2, position: [0, 3, 0], distance: 12 },
          {
            ...baseLight,
            id: "beam",
            name: "Beam",
            type: "spot",
            position: [3, 5, 3],
            target: [0, 0, 0],
            angle: Math.PI / 6,
            penumbra: 0.25,
          },
          {
            ...baseLight,
            id: "panel",
            name: "Panel",
            type: "rect-area",
            intensity: 3,
            position: [0, 4, 2],
            target: [0, 1, 0],
            width: 2,
            height: 0.5,
          },
        ]);
        expect(result.omitted).toEqual([]);
        const byId = Object.fromEntries(result.lights.map((light) => [light.directorId as string, light]));

        expect(byId.sun).toMatchObject({
          unrealClass: "DirectionalLight",
          intensityUnit: "lux",
          intensity: 12,
          castShadow: true,
          colorLinear: [1, 1, 1],
        });
        // Straight-down aim: the canonical rotation carries local -Z onto (0,-1,0),
        // which the pinned basis change turns into the Unreal +X light forward.
        const sunTransform = byId.sun!.transform as { location: number[]; rotationQuaternion: number[] };
        expect(sunTransform.location).toEqual([0, 5, 0]);
        const [qx, qy, qz, qw] = sunTransform.rotationQuaternion as [number, number, number, number];
        // Rotate (0,0,-1) by the quaternion and expect (0,-1,0).
        const forward = [
          2 * (qx * qz + qw * qy) * -1,
          2 * (qy * qz - qw * qx) * -1,
          (1 - 2 * (qx * qx + qy * qy)) * -1,
        ];
        expect(forward[0]).toBeCloseTo(0, 6);
        expect(forward[1]).toBeCloseTo(-1, 6);
        expect(forward[2]).toBeCloseTo(0, 6);

        expect(byId.bulb).toMatchObject({
          unrealClass: "PointLight",
          intensityUnit: "candela",
          intensity: 16,
          attenuationRadiusCm: 1_200,
          castShadow: false,
        });
        expect(byId.beam).toMatchObject({ unrealClass: "SpotLight", intensityUnit: "candela" });
        expect(byId.beam!.outerConeAngleDeg as number).toBeCloseTo(30, 4);
        expect(byId.beam!.innerConeAngleDeg as number).toBeCloseTo(22.5, 4);
        expect(byId.panel).toMatchObject({
          unrealClass: "RectLight",
          intensityUnit: "nits",
          intensity: 30,
          sourceWidthCm: 200,
          sourceHeightCm: 50,
        });
        // Honesty marker: the intensity conversion is documented as approximate.
        expect(result.warnings.join("\n")).toMatch(/approximate photometric/i);
      });

      it("emits structured omit records for ambient and hemisphere lights", async () => {
        const result = await mapLights([
          { ...baseLight, id: "amb", name: "Ambient", type: "ambient", intensity: 1.15 },
          { ...baseLight, id: "hemi", name: "Hemi", type: "hemisphere", groundColor: "#303744", position: [0, 5, 0] },
        ]);
        expect(result.lights).toEqual([]);
        expect(result.omitted).toEqual([
          { directorId: "amb", lightType: "ambient", reason: expect.stringMatching(/warn-and-omit/) },
          { directorId: "hemi", lightType: "hemisphere", reason: expect.stringMatching(/warn-and-omit/) },
        ]);
      });

      it("composes the scene transform and keeps unsupported colors and hidden flags honest", async () => {
        const result = await mapLights(
          [
            {
              ...baseLight,
              id: "moved",
              name: "Moved",
              type: "point",
              position: [1, 2, 3],
              color: "hsl(1,2%,3%)",
              visible: false,
            },
          ],
          { position: [10, 0, 0], rotation: [0, 0, 0], scale: 2 },
        );
        const [light] = result.lights;
        expect((light!.transform as { location: number[] }).location).toEqual([12, 4, 6]);
        expect(light!.hidden).toBe(true);
        expect(light!.colorLinear).toBeUndefined();
        expect(result.warnings.join("\n")).toMatch(/unsupported syntax/);
      });
    });

    describe("director_sequencer shot classification (typed warn-and-omit)", () => {
      async function classifyShots(payload: Record<string, unknown>) {
        const { output } = await runModule("director_sequencer", [], JSON.stringify(payload));
        expect(output.ok).toBe(true);
        return output.result as {
          shots: Array<Record<string, unknown>>;
          omitted: Array<Record<string, unknown>>;
          warnings: string[];
        };
      }

      it("keeps mappable shots and stamps the shared shot omit vocabulary for the rest", async () => {
        const result = await classifyShots({
          storyboard: {
            shots: [
              { id: "shot-hero", cameraId: "cam-a", frameStart: 0, frameEnd: 24 },
              { id: "shot-orphan", cameraId: null, frameStart: 24, frameEnd: 48 },
              { id: "shot-prop", cameraId: "prop-1", frameStart: 48, frameEnd: 72 },
              { id: "shot-ghost", cameraId: "cam-ghost", frameStart: 72, frameEnd: 96 },
            ],
          },
          spawnedIds: ["prop-1"],
          cameraIds: ["cam-a"],
        });
        expect(result.shots).toEqual([expect.objectContaining({ id: "shot-hero", cameraId: "cam-a" })]);
        expect(result.omitted).toEqual([
          { shotId: "shot-orphan", code: "shot_no_camera_binding", cameraDirectorId: null, reason: expect.any(String) },
          {
            shotId: "shot-prop",
            code: "shot_target_not_camera",
            cameraDirectorId: "prop-1",
            reason: expect.any(String),
          },
          {
            shotId: "shot-ghost",
            code: "shot_camera_not_imported",
            cameraDirectorId: "cam-ghost",
            reason: expect.any(String),
          },
        ]);
        // Every typed record pairs with a free-text warning carrying the code.
        expect(result.warnings).toHaveLength(3);
        for (const record of result.omitted) {
          expect(result.warnings.join("\n")).toContain(`warn-and-omit code: ${record.code as string}`);
        }
      });

      it("returns empty classifications for missing storyboards instead of failing", async () => {
        const result = await classifyShots({ storyboard: null, spawnedIds: [], cameraIds: [] });
        expect(result).toEqual({ shots: [], omitted: [], warnings: [] });
      });
    });

    describe("director_gltf GLB inspection", () => {
      it("detects skinned GLB payloads from the JSON chunk alone", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "director-unreal-glb-"));
        const skinnedPath = resolve(directory, "skinned.glb");
        await writeFile(
          skinnedPath,
          glbBuffer({
            asset: { version: "2.0", generator: "Director fixture" },
            nodes: [{ name: "root" }, { name: "joint" }],
            meshes: [{ primitives: [] }],
            skins: [{ joints: [1] }],
            animations: [{ channels: [], samplers: [] }],
            materials: [{ name: "skin" }],
          }),
        );
        const { output } = await runModule("director_gltf", [skinnedPath]);
        expect(output).toMatchObject({
          ok: true,
          result: {
            skinned: true,
            skinCount: 1,
            jointCount: 1,
            meshCount: 1,
            animationCount: 1,
            materialCount: 1,
            nodeCount: 2,
            generator: "Director fixture",
          },
        });

        const staticPath = resolve(directory, "static.glb");
        await writeFile(staticPath, glbBuffer({ asset: { version: "2.0" }, meshes: [{ primitives: [] }] }));
        const staticResult = await runModule("director_gltf", [staticPath]);
        expect(staticResult.output).toMatchObject({ ok: true, result: { skinned: false, skinCount: 0 } });
      });

      it("rejects malformed containers without touching the binary chunk", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "director-unreal-glb-bad-"));
        const notGlb = resolve(directory, "not-a.glb");
        await writeFile(notGlb, Buffer.from("this is not a glb container"));
        const badMagic = await runModule("director_gltf", [notGlb]);
        expect(badMagic.output.ok).toBe(false);
        expect(String(badMagic.output.error)).toMatch(/bad magic/i);

        const truncatedPath = resolve(directory, "truncated.glb");
        await writeFile(truncatedPath, glbBuffer({ asset: { version: "2.0" } }).subarray(0, 24));
        const truncated = await runModule("director_gltf", [truncatedPath]);
        expect(truncated.output.ok).toBe(false);
        expect(String(truncated.output.error)).toMatch(/truncated/i);
      });
    });

    describe("director_package clean-frame receipt writer (host-free)", () => {
      it("writes rendered and skipped receipts that pass the Gateway schema", async () => {
        const directory = await mkdtemp(resolve(tmpdir(), "director-unreal-clean-receipt-"));
        const renderedPath = resolve(directory, "rendered.json");
        const skippedPath = resolve(directory, "skipped.json");
        const revision = `director-project-revision:v1:sha256:${"d".repeat(64)}`;
        const script = [
          "import sys",
          `sys.path.insert(0, ${JSON.stringify(CONNECTOR_PYTHON_DIR)})`,
          "import director_package as dpkg",
          "dpkg.write_clean_frame_receipt(",
          `    ${JSON.stringify(renderedPath)},`,
          '    package_id="pkg-fixture-1",',
          `    source_revision=${JSON.stringify(revision)},`,
          '    level_path="/Game/Director/Levels/Director_fixture",',
          '    camera_director_id="main-camera",',
          "    frame=12,",
          "    width=1920,",
          "    height=1080,",
          '    image_path="clean-frame.png",',
          `    image_sha256="${"a".repeat(64)}",`,
          '    host_version="Unreal Engine 5.6.1",',
          '    warnings=["fixture warning"],',
          ")",
          `dpkg.write_clean_frame_receipt(${JSON.stringify(skippedPath)}, skip_reason="No RHI is available.")`,
        ].join("\n");
        await execFileAsync("python3", ["-c", script]);

        const rendered = directorUnrealCleanFrameReceiptSchema.parse(JSON.parse(await readFile(renderedPath, "utf8")));
        expect(rendered).toMatchObject({
          status: "rendered",
          cameraDirectorId: "main-camera",
          frame: 12,
          method: "offscreen_high_res_screenshot",
          warnings: ["fixture warning"],
        });

        const skipped = directorUnrealCleanFrameReceiptSchema.parse(JSON.parse(await readFile(skippedPath, "utf8")));
        expect(skipped).toMatchObject({ status: "skipped", skipReason: "No RHI is available." });
      });
    });

    describe("director_livelink preview session (reorder, disconnect, token)", () => {
      it("authenticates, applies in-order frames, drops reordered ones, and detects disconnects", async () => {
        const token = "fixture-preview-token";
        const frame = (
          seq: number,
          transform = { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        ) => JSON.stringify({ type: "camera_frame", seq, transform });
        const { output } = await runModule(
          "director_livelink",
          [],
          JSON.stringify({
            token,
            staleTimeoutMs: 1_000,
            events: [
              {
                atMs: 0,
                line: JSON.stringify({ type: "hello", protocol: "director-unreal-live-preview-v1", token: "wrong" }),
              },
              { atMs: 5, line: frame(1) },
              { atMs: 10, line: JSON.stringify({ type: "hello", protocol: "director-unreal-live-preview-v1", token }) },
              { atMs: 20, line: frame(1) },
              { atMs: 30, line: frame(1) },
              { atMs: 40, line: frame(3) },
              { atMs: 50, line: frame(2) },
              { atMs: 60, line: JSON.stringify({ type: "camera_frame", seq: 4, transform: { location: [0, 0] } }) },
              { atMs: 70, line: JSON.stringify({ type: "telemetry" }) },
              { atMs: 500, checkStale: true },
              { atMs: 1_500, checkStale: true },
              { atMs: 1_600, line: JSON.stringify({ type: "bye" }) },
              { atMs: 1_700, line: frame(5) },
            ],
          }),
        );
        expect(output.ok).toBe(true);
        const decisions = output.decisions as Array<Record<string, unknown>>;
        expect(decisions[0]).toMatchObject({ verb: "error", reason: expect.stringMatching(/token/i) });
        // Frames before authentication are rejected outright.
        expect(decisions[1]).toMatchObject({ verb: "error" });
        expect(decisions[2]).toMatchObject({ verb: "hello_ok" });
        expect(decisions[3]).toMatchObject({ verb: "apply", payload: expect.objectContaining({ seq: 1 }) });
        expect(decisions[4]).toMatchObject({ verb: "drop", reason: expect.stringMatching(/stale sequence/i) });
        expect(decisions[5]).toMatchObject({ verb: "apply", payload: expect.objectContaining({ seq: 3 }) });
        expect(decisions[6]).toMatchObject({ verb: "drop", reason: expect.stringMatching(/stale sequence/i) });
        expect(decisions[7]).toMatchObject({ verb: "drop", reason: expect.stringMatching(/malformed/i) });
        expect(decisions[8]).toMatchObject({ verb: "drop", reason: expect.stringMatching(/unknown message type/i) });
        expect(decisions[9]).toEqual({ stale: false });
        expect(decisions[10]).toEqual({ stale: true });
        expect(decisions[11]).toMatchObject({ verb: "closed" });
        expect(decisions[12]).toMatchObject({ verb: "error", reason: expect.stringMatching(/closed/i) });
        expect(output.applied).toBe(2);
        expect(output.dropped).toBe(3);
        expect(output.closed).toBe(true);
      });

      it("keeps optics preview data on the applied payload and validates it", async () => {
        const token = "fixture-preview-token";
        const { output } = await runModule(
          "director_livelink",
          [],
          JSON.stringify({
            token,
            events: [
              { atMs: 0, line: JSON.stringify({ type: "hello", protocol: "director-unreal-live-preview-v1", token }) },
              {
                atMs: 10,
                line: JSON.stringify({
                  type: "camera_frame",
                  seq: 1,
                  transform: { location: [1, 2, 3], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
                  focalLengthMm: 50,
                }),
              },
              {
                atMs: 20,
                line: JSON.stringify({
                  type: "camera_frame",
                  seq: 2,
                  transform: { location: [1, 2, 3], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
                  focalLengthMm: -1,
                }),
              },
            ],
          }),
        );
        const decisions = output.decisions as Array<Record<string, unknown>>;
        expect(decisions[1]).toMatchObject({ verb: "apply", payload: expect.objectContaining({ focalLengthMm: 50 }) });
        expect(decisions[2]).toMatchObject({ verb: "drop", reason: expect.stringMatching(/focalLengthMm/) });
      });
    });
  },
);
