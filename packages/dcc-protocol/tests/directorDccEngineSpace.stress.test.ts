import { describe, expect, it } from "vitest";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import {
  DIRECTOR_DCC_ENGINE_SPACES,
  canonicalDccTransformToDirector,
  directorDirectionToEngine,
  directorPointToEngine,
  directorTransformToCanonicalDcc,
  directorTransformToEngine,
  engineCameraForward,
  engineDirectionToDirector,
  enginePointToDirector,
  engineTransformToDirector,
  type DirectorDccEngineId,
} from "../src/directorDccEngineSpace";
import {
  directorDccCapabilitySchema,
  directorDccConfiguredProviderSchema,
  directorDccProviderDescriptorSchema,
  getDirectorDccProviderDescriptor,
} from "../src/directorDccProviderContract";
import { directorDccTransformSchema, directorDccVec3Schema } from "../src/directorDccSharedContract";
import type { DirectorTransform } from "../../../frontend/director/src/comprehensive/editor/schema/directorProject";

const ENGINES: DirectorDccEngineId[] = ["unreal", "unity", "godot"];

/** Deterministic 32-bit LCG so fuzz failures reproduce byte-for-byte. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function expectVectorClose(actual: readonly number[], expected: readonly number[], precision = 8) {
  expect(actual.length).toBe(expected.length);
  actual.forEach((value, index) => expect(value).toBeCloseTo(expected[index]!, precision));
}

/** Apply a Director TRS transform to a probe point without three.js decompose. */
function applyDirectorTransform(transform: DirectorTransform, point: [number, number, number]): [number, number, number] {
  const result = new Vector3(point[0] * transform.scale[0], point[1] * transform.scale[1], point[2] * transform.scale[2])
    .applyQuaternion(new Quaternion().setFromEuler(new Euler(...transform.rotation, "XYZ")))
    .add(new Vector3(...transform.position));
  return [result.x, result.y, result.z];
}

/**
 * Compare two Director transforms by the map they induce on probe points, which
 * is robust to decompose redistributing mirroring between axes and rotation.
 */
function expectSameRigidMap(actual: DirectorTransform, expected: DirectorTransform, precision = 6) {
  const probes: Array<[number, number, number]> = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [0.5, -1.5, 2.5],
  ];
  for (const probe of probes) {
    expectVectorClose(applyDirectorTransform(actual, probe), applyDirectorTransform(expected, probe), precision);
  }
}

describe("engine space stress: basis integrity goldens", () => {
  it("keeps every engine permutation an orthogonal signed permutation whose determinant matches handedness", () => {
    for (const engine of ENGINES) {
      const basisColumns = (["x", "y", "z"] as const).map((axis) => {
        const unit: [number, number, number] = [axis === "x" ? 1 : 0, axis === "y" ? 1 : 0, axis === "z" ? 1 : 0];
        return directorDirectionToEngine(engine, unit);
      });
      // Signed permutation: each column has exactly one ±1 entry.
      for (const column of basisColumns) {
        const magnitudes = column.map(Math.abs).sort();
        expectVectorClose(magnitudes, [0, 0, 1], 12);
      }
      const matrix = new Matrix4().set(
        basisColumns[0]![0], basisColumns[1]![0], basisColumns[2]![0], 0,
        basisColumns[0]![1], basisColumns[1]![1], basisColumns[2]![1], 0,
        basisColumns[0]![2], basisColumns[1]![2], basisColumns[2]![2], 0,
        0, 0, 0, 1,
      );
      const expectedDeterminant = DIRECTOR_DCC_ENGINE_SPACES[engine].handedness === "left" ? -1 : 1;
      expect(matrix.determinant()).toBeCloseTo(expectedDeterminant, 12);
    }
  });

  it("scales point lengths by exactly unitsPerMeter while directions stay unit length", () => {
    const random = createRandom(0xd1c3);
    for (const engine of ENGINES) {
      const { unitsPerMeter } = DIRECTOR_DCC_ENGINE_SPACES[engine];
      for (let index = 0; index < 32; index += 1) {
        const point: [number, number, number] = [
          (random() - 0.5) * 2_000,
          (random() - 0.5) * 2_000,
          (random() - 0.5) * 2_000,
        ];
        const mapped = directorPointToEngine(engine, point);
        expect(Math.hypot(...mapped)).toBeCloseTo(Math.hypot(...point) * unitsPerMeter, 6);
        const direction = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
        const mappedDirection = directorDirectionToEngine(engine, [direction.x, direction.y, direction.z]);
        expect(Math.hypot(...mappedDirection)).toBeCloseTo(1, 10);
      }
    }
  });

  it("agrees across engines: Director → A → Director → B equals Director → B", () => {
    const random = createRandom(0xac01);
    for (let index = 0; index < 16; index += 1) {
      const point: [number, number, number] = [
        (random() - 0.5) * 200,
        (random() - 0.5) * 200,
        (random() - 0.5) * 200,
      ];
      for (const engineA of ENGINES) {
        const recovered = enginePointToDirector(engineA, directorPointToEngine(engineA, point));
        for (const engineB of ENGINES) {
          expectVectorClose(directorPointToEngine(engineB, recovered), directorPointToEngine(engineB, point), 6);
        }
      }
    }
  });
});

describe("engine space stress: fuzzed transform round trips", () => {
  it("round-trips 150 seeded random transforms per engine as identical point maps", () => {
    const random = createRandom(0xf422);
    for (let index = 0; index < 150; index += 1) {
      const flipAxis = Math.floor(random() * 4); // 3 = no mirror
      const transform: DirectorTransform = {
        position: [(random() - 0.5) * 2_000, (random() - 0.5) * 2_000, (random() - 0.5) * 2_000],
        rotation: [(random() - 0.5) * 2 * Math.PI, (random() - 0.5) * 2 * Math.PI, (random() - 0.5) * 2 * Math.PI],
        scale: [0.01 + random() * 50, 0.01 + random() * 50, 0.01 + random() * 50],
      };
      if (flipAxis < 3) transform.scale[flipAxis] = -transform.scale[flipAxis]!;
      for (const engine of ENGINES) {
        const engineTransform = directorTransformToEngine(engine, transform);
        expect(engineTransform.location.every(Number.isFinite)).toBe(true);
        expect(Math.hypot(...engineTransform.rotationQuaternion)).toBeCloseTo(1, 8);
        expectSameRigidMap(engineTransformToDirector(engine, engineTransform), transform, 4);
      }
    }
  });

  it("survives gimbal-lock pitches of exactly ±π/2 with arbitrary yaw and roll", () => {
    const random = createRandom(0x91b1);
    for (let index = 0; index < 40; index += 1) {
      const transform: DirectorTransform = {
        position: [(random() - 0.5) * 20, (random() - 0.5) * 20, (random() - 0.5) * 20],
        rotation: [
          (index % 2 === 0 ? 1 : -1) * (Math.PI / 2),
          (random() - 0.5) * 2 * Math.PI,
          (random() - 0.5) * 2 * Math.PI,
        ],
        scale: [1, 1, 1],
      };
      for (const engine of ENGINES) {
        expectSameRigidMap(engineTransformToDirector(engine, directorTransformToEngine(engine, transform)), transform, 6);
      }
    }
  });

  it("handles extreme magnitudes: kilometre-scale sets and near-zero (but legal) scales", () => {
    const extremes: DirectorTransform[] = [
      { position: [1e6, -1e6, 1e6], rotation: [0.1, 0.2, 0.3], scale: [1, 1, 1] },
      { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1e-6, 1e-6, 1e-6] },
      { position: [-5e5, 2e5, -9e5], rotation: [Math.PI, -Math.PI, Math.PI], scale: [1e4, 1e-4, 1] },
    ];
    for (const transform of extremes) {
      for (const engine of ENGINES) {
        const engineTransform = directorTransformToEngine(engine, transform);
        expect(engineTransform.location.every(Number.isFinite)).toBe(true);
        expect(engineTransform.scale.every(Number.isFinite)).toBe(true);
        const recovered = engineTransformToDirector(engine, engineTransform);
        expectVectorClose(recovered.position, transform.position, 1);
        expectVectorClose(
          recovered.scale.map((value) => Math.abs(value)),
          transform.scale.map((value) => Math.abs(value)),
          6,
        );
      }
    }
  });

  it("treats non-normalized wire quaternions identically to their normalized form", () => {
    const base: DirectorTransform = { position: [1, 2, 3], rotation: [0.4, -0.8, 1.6], scale: [1, 2, 0.5] };
    for (const engine of ENGINES) {
      const wire = directorTransformToEngine(engine, base);
      for (const factor of [1e-6, 1e6]) {
        const scaledQuaternion = wire.rotationQuaternion.map((value) => value * factor) as [
          number,
          number,
          number,
          number,
        ];
        expectSameRigidMap(
          engineTransformToDirector(engine, { ...wire, rotationQuaternion: scaledQuaternion }),
          engineTransformToDirector(engine, wire),
          6,
        );
      }
    }
  });

  it("round-trips fuzzed transforms through the canonical wire space with a mirrored scene transform", () => {
    const random = createRandom(0xca11);
    const sceneTransform: DirectorTransform = {
      position: [12, -3, 8],
      rotation: [0, Math.PI / 3, 0],
      scale: [-2, 2, 2],
    };
    for (let index = 0; index < 40; index += 1) {
      const transform: DirectorTransform = {
        position: [(random() - 0.5) * 100, (random() - 0.5) * 100, (random() - 0.5) * 100],
        rotation: [(random() - 0.5) * 2 * Math.PI, (random() - 0.5) * 2 * Math.PI, (random() - 0.5) * 2 * Math.PI],
        scale: [0.1 + random() * 5, 0.1 + random() * 5, 0.1 + random() * 5],
      };
      const wire = directorTransformToCanonicalDcc(transform, sceneTransform);
      expect(Math.hypot(...wire.rotationQuaternion)).toBeCloseTo(1, 8);
      expectSameRigidMap(canonicalDccTransformToDirector(wire, sceneTransform), transform, 4);
    }
  });
});

describe("engine space stress: vertical and orthographic-style camera boundaries", () => {
  it("keeps straight-down and straight-up cameras (orthographic top/bottom framing) consistent per engine", () => {
    const verticalCameras: Array<{ rotation: [number, number, number]; directorForward: [number, number, number] }> = [
      { rotation: [-Math.PI / 2, 0, 0], directorForward: [0, -1, 0] }, // top view looks straight down
      { rotation: [Math.PI / 2, 0, 0], directorForward: [0, 1, 0] }, // bottom view looks straight up
    ];
    for (const { rotation, directorForward } of verticalCameras) {
      const camera: DirectorTransform = { position: [0, 50, 0], rotation, scale: [1, 1, 1] };
      for (const engine of ENGINES) {
        const engineTransform = directorTransformToEngine(engine, camera);
        expectVectorClose(
          engineCameraForward(engine, engineTransform),
          directorDirectionToEngine(engine, directorForward),
          8,
        );
      }
    }
  });

  it("keeps rolled vertical cameras pointing along the same world ray", () => {
    // Rolling a straight-down camera about its own forward axis must never
    // change the world-space forward ray, only the up vector.
    for (const roll of [Math.PI / 4, Math.PI / 2, Math.PI]) {
      const camera: DirectorTransform = { position: [3, 40, -2], rotation: [-Math.PI / 2, 0, roll], scale: [1, 1, 1] };
      for (const engine of ENGINES) {
        const engineTransform = directorTransformToEngine(engine, camera);
        expectVectorClose(
          engineCameraForward(engine, engineTransform),
          directorDirectionToEngine(engine, [0, -1, 0]),
          8,
        );
      }
    }
  });

  it("preserves the forward ray for 128 fuzzed camera orientations across every engine", () => {
    const random = createRandom(0xcafe);
    for (let index = 0; index < 128; index += 1) {
      const camera: DirectorTransform = {
        position: [(random() - 0.5) * 100, random() * 50, (random() - 0.5) * 100],
        rotation: [(random() - 0.5) * 2 * Math.PI, (random() - 0.5) * 2 * Math.PI, (random() - 0.5) * 2 * Math.PI],
        scale: [1, 1, 1],
      };
      const directorForward = new Vector3(0, 0, -1)
        .applyQuaternion(new Quaternion().setFromEuler(new Euler(...camera.rotation, "XYZ")))
        .normalize();
      for (const engine of ENGINES) {
        expectVectorClose(
          engineCameraForward(engine, directorTransformToEngine(engine, camera)),
          directorDirectionToEngine(engine, [directorForward.x, directorForward.y, directorForward.z]),
          6,
        );
      }
    }
  });
});

describe("shared contract stress: schema bombs and hostile wire transforms", () => {
  const validWire = { location: [0, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] };

  it("rejects NaN, Infinity, and 1e999-smuggled components everywhere in the wire transform", () => {
    for (const poison of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      for (const field of ["location", "rotationQuaternion", "scale"] as const) {
        const candidate = structuredClone(validWire) as Record<string, number[]>;
        candidate[field]![0] = poison;
        expect(directorDccTransformSchema.safeParse(candidate).success).toBe(false);
      }
    }
    // JSON.parse turns 1e999 into Infinity; the finite gate must still hold.
    const smuggled = JSON.parse('{"location":[1e999,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}');
    expect(directorDccTransformSchema.safeParse(smuggled).success).toBe(false);
  });

  it("rejects degenerate quaternions, zero scales, wrong arity, extra fields, and type smuggling", () => {
    expect(
      directorDccTransformSchema.safeParse({ ...validWire, rotationQuaternion: [0, 0, 0, 0] }).success,
    ).toBe(false);
    expect(directorDccTransformSchema.safeParse({ ...validWire, scale: [1, 0, 1] }).success).toBe(false);
    expect(directorDccTransformSchema.safeParse({ ...validWire, scale: [1, 1e-12, 1] }).success).toBe(false);
    expect(directorDccTransformSchema.safeParse({ ...validWire, location: [1, 2] }).success).toBe(false);
    expect(directorDccTransformSchema.safeParse({ ...validWire, location: [1, 2, 3, 4] }).success).toBe(false);
    expect(directorDccTransformSchema.safeParse({ ...validWire, smuggled: true }).success).toBe(false);
    expect(directorDccTransformSchema.safeParse({ ...validWire, location: ["1", "2", "3"] }).success).toBe(false);
    expect(directorDccTransformSchema.safeParse(null).success).toBe(false);
    expect(directorDccTransformSchema.safeParse([]).success).toBe(false);
  });

  it("fails fast on deeply nested JSON bombs instead of recursing", () => {
    let bomb: unknown = 1;
    for (let depth = 0; depth < 20_000; depth += 1) bomb = [bomb];
    const started = Date.now();
    expect(directorDccVec3Schema.safeParse(bomb).success).toBe(false);
    expect(directorDccTransformSchema.safeParse({ ...validWire, location: bomb }).success).toBe(false);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("makes the conversion entry points throw on hostile wire transforms instead of emitting garbage", () => {
    const hostiles: unknown[] = [
      { ...validWire, location: [Number.NaN, 0, 0] },
      { ...validWire, rotationQuaternion: [0, 0, 0, 0] },
      { ...validWire, scale: [0, 1, 1] },
      { location: [0, 0, 0] },
      "not a transform",
    ];
    for (const hostile of hostiles) {
      for (const engine of ENGINES) {
        expect(() => engineTransformToDirector(engine, hostile as never)).toThrow();
        expect(() => engineCameraForward(engine, hostile as never)).toThrow();
      }
      expect(() => canonicalDccTransformToDirector(hostile as never)).toThrow();
    }
  });
});

describe("shared contract stress: capability honesty is enforced at the schema layer", () => {
  it("rejects capabilities that name portable formats without the exchange-format layer", () => {
    expect(
      directorDccCapabilitySchema.safeParse({ id: "animation", level: "planned", layer: "connector", formats: ["glb"] })
        .success,
    ).toBe(false);
    expect(
      directorDccCapabilitySchema.safeParse({ id: "scene", level: "native", layer: "connector", formats: ["glb"] })
        .success,
    ).toBe(false);
  });

  it("rejects layer/level combinations that would fake maturity", () => {
    // exchange-format capabilities must stay at the exchange level.
    expect(
      directorDccCapabilitySchema.safeParse({ id: "scene", level: "native", layer: "exchange-format", formats: ["glb"] })
        .success,
    ).toBe(false);
    // connector capabilities are native or planned, never exchange.
    expect(
      directorDccCapabilitySchema.safeParse({ id: "roundtrip", level: "exchange", layer: "connector" }).success,
    ).toBe(false);
    // the Director manifest layer only supplies stable_ids.
    expect(
      directorDccCapabilitySchema.safeParse({ id: "animation", level: "native", layer: "director-manifest" }).success,
    ).toBe(false);
  });

  it("keeps third-party provider configs structurally unable to claim native capabilities", () => {
    const config = {
      id: "houdini",
      label: "Houdini",
      category: "dcc",
      integration: "exchange-package",
      preferredFormat: "glb",
      exchangeFormats: ["glb"],
      capabilities: [{ id: "scene", level: "native" }],
    };
    expect(directorDccConfiguredProviderSchema.safeParse(config).success).toBe(false);
    expect(
      directorDccConfiguredProviderSchema.safeParse({
        ...config,
        capabilities: [{ id: "scene", level: "exchange" }],
      }).success,
    ).toBe(true);
  });

  it("rejects descriptors whose preferredFormat is not an offered exchange format", () => {
    const descriptor = structuredClone(getDirectorDccProviderDescriptor("godot")) as Record<string, unknown>;
    descriptor.preferredFormat = "usda";
    expect(directorDccProviderDescriptorSchema.safeParse(descriptor).success).toBe(false);
  });

  it("keeps every built-in descriptor valid under its own schema", () => {
    for (const provider of ["blender", "unreal", "unity", "godot"] as const) {
      expect(directorDccProviderDescriptorSchema.safeParse(getDirectorDccProviderDescriptor(provider)).success).toBe(
        true,
      );
    }
  });
});
