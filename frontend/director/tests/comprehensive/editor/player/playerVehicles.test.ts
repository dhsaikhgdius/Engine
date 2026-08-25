import { BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { createDefaultDirectorCarProfile } from "../../../../../../packages/protocol/src/vehicleProtocol";
import type { DirectorObject } from "../../../../src/comprehensive/editor/schema/directorProject";
import {
  areVehicleCandidateListsEquivalent,
  collectPlayerVehicleCandidates,
  createPlayerVehicleSessionEntries,
  disposePlayerVehicleEntries,
  ensurePlayerVehicleRuntime,
  measureVehicleChassisHalfExtents,
} from "../../../../src/comprehensive/editor/player/playerVehicles";

function projectObject(overrides: Partial<DirectorObject> & { id: string }): DirectorObject {
  return {
    name: "载具",
    kind: "prop",
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ...overrides,
  };
}

it("collects only visible objects whose vehicle profile is drivable", () => {
  const profile = createDefaultDirectorCarProfile();
  const objects: DirectorObject[] = [
    projectObject({ id: "car", vehicle: profile }),
    projectObject({ id: "parked-prop", vehicle: { ...profile, drivable: false } }),
    projectObject({ id: "hidden-car", vehicle: profile, visible: false }),
    projectObject({ id: "plain-prop" }),
  ];

  const candidates = collectPlayerVehicleCandidates(objects);
  expect(candidates.map((candidate) => candidate.id)).toEqual(["car"]);
  expect(candidates[0]!.profile).toBe(profile);
});

it("treats candidate lists as equivalent across unrelated store mutations", () => {
  const profile = createDefaultDirectorCarProfile();
  const first = collectPlayerVehicleCandidates([projectObject({ id: "car", vehicle: profile })]);
  const second = collectPlayerVehicleCandidates([projectObject({ id: "car", vehicle: profile })]);

  expect(areVehicleCandidateListsEquivalent(first, second)).toBe(true);
  expect(areVehicleCandidateListsEquivalent(first, collectPlayerVehicleCandidates([]))).toBe(false);
  // A replaced profile object is a real change (vehicle edited in place).
  expect(
    areVehicleCandidateListsEquivalent(
      first,
      collectPlayerVehicleCandidates([projectObject({ id: "car", vehicle: { ...profile } })]),
    ),
  ).toBe(false);
});

it("measures rendered half extents in object space scaled to world metres", () => {
  const group = new Group();
  const body = new Mesh(new BoxGeometry(4, 1.4, 2), new MeshBasicMaterial());
  body.position.set(0, 0.7, 0);
  group.add(body);
  group.scale.set(2, 1, 1);
  group.position.set(30, 0, -5);
  group.rotation.y = Math.PI / 3;
  group.updateMatrixWorld(true);

  const halfExtents = measureVehicleChassisHalfExtents(group, new Vector3());
  expect(halfExtents).not.toBeNull();
  // Local size 4x1.4x2 scaled by the group's world scale (2,1,1), halved. The
  // group yaw must not inflate the box: bounds are taken in the group frame.
  expect(halfExtents!.x).toBeCloseTo(4, 5);
  expect(halfExtents!.y).toBeCloseTo(0.7, 5);
  expect(halfExtents!.z).toBeCloseTo(1, 5);
});

it("returns null bounds while the vehicle's meshes have not mounted", () => {
  expect(measureVehicleChassisHalfExtents(new Group(), new Vector3())).toBeNull();
});

it("marks a vehicle failed (not enterable) and warns once when the runtime cannot build", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const profile = createDefaultDirectorCarProfile();
    const entries = createPlayerVehicleSessionEntries(
      collectPlayerVehicleCandidates([projectObject({ id: "car", vehicle: profile })]),
    );
    const entry = entries.get("car")!;
    const group = new Group();
    group.add(new Mesh(new BoxGeometry(4, 1.4, 2), new MeshBasicMaterial()));
    group.updateMatrixWorld(true);
    const binding = { rapier: {}, world: {} };

    // The runtime rejects this binding (empty duck-typed rapier namespace),
    // standing in for any creation failure — including the era when the
    // physics track was a stub. Creation must degrade to "failed" instead of
    // breaking player mode.
    expect(ensurePlayerVehicleRuntime(entry, group, binding)).toBe("failed");
    expect(entry.runtime).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);

    // Re-ensuring neither retries nor warns again.
    expect(ensurePlayerVehicleRuntime(entry, group, binding)).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    warn.mockRestore();
  }
});

it("stays pending until both the world binding and mounted meshes exist", () => {
  const profile = createDefaultDirectorCarProfile();
  const entries = createPlayerVehicleSessionEntries(
    collectPlayerVehicleCandidates([projectObject({ id: "car", vehicle: profile })]),
  );
  const entry = entries.get("car")!;
  const mountedGroup = new Group();
  mountedGroup.add(new Mesh(new BoxGeometry(4, 1.4, 2), new MeshBasicMaterial()));
  mountedGroup.updateMatrixWorld(true);

  expect(ensurePlayerVehicleRuntime(entry, null, { rapier: {}, world: {} })).toBe("pending");
  expect(ensurePlayerVehicleRuntime(entry, mountedGroup, null)).toBe("pending");
  expect(ensurePlayerVehicleRuntime(entry, new Group(), { rapier: {}, world: {} })).toBe("pending");
  expect(entry.status).toBe("pending");
});

it("dispose is safe on failed and pending entries and resets them for a new world", () => {
  const profile = createDefaultDirectorCarProfile();
  const entries = createPlayerVehicleSessionEntries(
    collectPlayerVehicleCandidates([
      projectObject({ id: "car-a", vehicle: profile }),
      projectObject({ id: "car-b", vehicle: profile }),
    ]),
  );
  const disposed: string[] = [];
  const runtimeDispose = vi.fn();
  const entryA = entries.get("car-a")!;
  entryA.status = "ready";
  entryA.runtime = {
    step: vi.fn(),
    readPose: vi.fn(),
    readTelemetry: vi.fn(() => ({ speedKph: 0, forwardSpeedMps: 0, onGroundWheelCount: 4 })),
    reset: vi.fn(),
    dispose: runtimeDispose,
  };
  entries.get("car-b")!.status = "failed";

  disposePlayerVehicleEntries(entries, (entry) => disposed.push(entry.candidate.id));

  expect(runtimeDispose).toHaveBeenCalledTimes(1);
  // Only entries that actually owned a runtime invoke the restore callback.
  expect(disposed).toEqual(["car-a"]);
  expect(entryA.runtime).toBeNull();
  expect(entries.get("car-a")!.status).toBe("pending");
  expect(entries.get("car-b")!.status).toBe("pending");
});
