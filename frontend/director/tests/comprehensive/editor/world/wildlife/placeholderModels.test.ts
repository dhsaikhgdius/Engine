import { describe, expect, it } from "vitest";
import {
  WORLD_WILDLIFE_SPECIES,
  type WorldWildlifeSpecies,
} from "../../../../../../../packages/protocol/src/worldSystemsProtocol";
import {
  buildWildlifeGeometry,
  buildWildlifeModel,
  WILDLIFE_PART_AXIS_ATTRIBUTE,
  WILDLIFE_PART_ID_ATTRIBUTE,
  WILDLIFE_PART_PIVOT_ATTRIBUTE,
  WILDLIFE_PART_SLOTS,
  WILDLIFE_RENDER_PROFILES,
  type WildlifePartName,
} from "../../../../../src/comprehensive/editor/world/wildlife/placeholderModels";

const HERD_SPECIES = ["deer", "rabbits", "wolves", "sheep"] as const;

const HERD_PART_NAMES: WildlifePartName[] = [
  "body",
  "head",
  "legFrontLeft",
  "legFrontRight",
  "legHindLeft",
  "legHindRight",
  "tail",
];

/**
 * Locked layout: 36 vertices per box; changing a silhouette must be
 * deliberate. Golden update (wildlife ecology track): birds gained a tail
 * fan (+2 tris) and fish gained dorsal + pectoral fins (+3 tris) so the two
 * species read correctly at silhouette distance instead of as darts.
 */
const EXPECTED_VERTEX_COUNTS: Record<WorldWildlifeSpecies, number> = {
  birds: 30, // 6 fuselage tris + 2 wing tris + 2 tail-fan tris
  butterflies: 30, // 6 fuselage tris + 4 wing tris
  fish: 36, // 8 body tris + 1 tail fin + 1 dorsal fin + 2 pectoral fins
  deer: 432, // 12 boxes: body, neck, head, 2×(antler beam + fork), tail, 4 legs
  rabbits: 360, // 10 boxes: body, haunches, head, 2 ears, tail, 4 legs
  wolves: 360, // 10 boxes: body, head, snout, 2 ears, tail, 4 legs
  sheep: 288, // 8 boxes: body, wool hump, head, tail, 4 legs
};

const EXPECTED_PART_COUNTS: Record<WorldWildlifeSpecies, number> = {
  birds: 1,
  butterflies: 1,
  fish: 1,
  deer: 7,
  rabbits: 7,
  wolves: 7,
  sheep: 7,
};

function attributeArray(species: WorldWildlifeSpecies, sizeScale: number, name: string): Float32Array {
  const { geometry } = buildWildlifeModel(species, sizeScale);
  const array = (geometry.getAttribute(name)?.array ?? new Float32Array()) as Float32Array;
  const copy = new Float32Array(array);
  geometry.dispose();
  return copy;
}

describe("placeholder geometry builders", () => {
  it("is deterministic: same input produces identical attribute buffers", () => {
    for (const species of WORLD_WILDLIFE_SPECIES) {
      const a = buildWildlifeModel(species, 1.5);
      const b = buildWildlifeModel(species, 1.5);
      const positionsA = a.geometry.getAttribute("position");
      expect(positionsA.count).toBe(EXPECTED_VERTEX_COUNTS[species]);
      expect(positionsA.count % 3).toBe(0);
      for (const name of [
        "position",
        WILDLIFE_PART_ID_ATTRIBUTE,
        WILDLIFE_PART_PIVOT_ATTRIBUTE,
        WILDLIFE_PART_AXIS_ATTRIBUTE,
      ]) {
        expect(Array.from(a.geometry.getAttribute(name).array as Float32Array)).toEqual(
          Array.from(b.geometry.getAttribute(name).array as Float32Array),
        );
      }
      expect(a.parts).toEqual(b.parts);
      a.geometry.dispose();
      b.geometry.dispose();
    }
  });

  it("locks the per-species part table", () => {
    for (const species of WORLD_WILDLIFE_SPECIES) {
      const { geometry, parts } = buildWildlifeModel(species, 1);
      expect(parts.length).toBe(EXPECTED_PART_COUNTS[species]);
      expect(parts[0].name).toBe("body");
      for (const part of parts) {
        expect(part.slot).toBe(WILDLIFE_PART_SLOTS[part.name]);
        const [ax, ay, az] = part.axis;
        expect(Math.hypot(ax, ay, az)).toBeCloseTo(1, 6); // unit rotation axis
      }
      geometry.dispose();
    }
    for (const species of HERD_SPECIES) {
      const { geometry, parts } = buildWildlifeModel(species, 1);
      expect(parts.map((part) => part.name).sort()).toEqual([...HERD_PART_NAMES].sort());
      geometry.dispose();
    }
  });

  it("tags every herd vertex with a valid part slot and matching pivot data", () => {
    for (const species of HERD_SPECIES) {
      const { geometry, parts } = buildWildlifeModel(species, 1);
      const ids = geometry.getAttribute(WILDLIFE_PART_ID_ATTRIBUTE).array as Float32Array;
      const pivots = geometry.getAttribute(WILDLIFE_PART_PIVOT_ATTRIBUTE).array as Float32Array;
      const axes = geometry.getAttribute(WILDLIFE_PART_AXIS_ATTRIBUTE).array as Float32Array;
      const bySlot = new Map(parts.map((part) => [part.slot, part]));
      const seenSlots = new Set<number>();
      for (let v = 0; v < ids.length; v += 1) {
        const part = bySlot.get(ids[v]);
        expect(part).toBeDefined();
        if (!part) continue;
        seenSlots.add(part.slot);
        // Attributes store float32; metadata keeps float64. Compare via fround.
        expect([pivots[v * 3], pivots[v * 3 + 1], pivots[v * 3 + 2]]).toEqual(part.pivot.map(Math.fround));
        expect([axes[v * 3], axes[v * 3 + 1], axes[v * 3 + 2]]).toEqual(part.axis.map(Math.fround));
      }
      expect(seenSlots.size).toBe(EXPECTED_PART_COUNTS[species]); // every part owns vertices
      geometry.dispose();
    }
    // Flock/school species carry inert all-body metadata.
    const birdIds = attributeArray("birds", 1, WILDLIFE_PART_ID_ATTRIBUTE);
    expect(new Set(birdIds)).toEqual(new Set([WILDLIFE_PART_SLOTS.body]));
  });

  it("places pivots anatomically: legs below the body, head ahead, tail behind", () => {
    for (const species of HERD_SPECIES) {
      const { geometry, parts } = buildWildlifeModel(species, 1);
      const byName = new Map(parts.map((part) => [part.name, part]));
      const head = byName.get("head");
      const tail = byName.get("tail");
      expect(head && head.pivot[2]).toBeGreaterThan(0); // ahead of the body center
      expect(tail && tail.pivot[2]).toBeLessThan(0); // behind it
      for (const legName of ["legFrontLeft", "legFrontRight", "legHindLeft", "legHindRight"] as const) {
        const leg = byName.get(legName);
        expect(leg).toBeDefined();
        if (!leg) continue;
        expect(leg.pivot[1]).toBeLessThan(0); // hip/shoulder below the body center
        const forward = legName.startsWith("legFront");
        expect(forward ? leg.pivot[2] : -leg.pivot[2]).toBeGreaterThan(0);
        const left = legName.endsWith("Left");
        expect(left ? -leg.pivot[0] : leg.pivot[0]).toBeGreaterThan(0); // mirrored pairs
      }
      geometry.dispose();
    }
  });

  it("reaches the ground exactly: lowest vertex == -bodyOffsetYM, scaled by sizeScale", () => {
    for (const species of HERD_SPECIES) {
      for (const sizeScale of [1, 2.5]) {
        const geometry = buildWildlifeGeometry(species, sizeScale);
        geometry.computeBoundingBox();
        const minY = geometry.boundingBox?.min.y ?? Number.NaN;
        expect(minY).toBeCloseTo(-WILDLIFE_RENDER_PROFILES[species].bodyOffsetYM * sizeScale, 3);
        geometry.dispose();
      }
    }
  });

  it("bakes sizeScale into pivots so instance matrices stay unit-scale", () => {
    const base = buildWildlifeModel("deer", 1);
    const scaled = buildWildlifeModel("deer", 2);
    const baseHead = base.parts.find((part) => part.name === "head");
    const scaledHead = scaled.parts.find((part) => part.name === "head");
    expect(baseHead && scaledHead && scaledHead.pivot[2]).toBeCloseTo((baseHead?.pivot[2] ?? 0) * 2, 6);
    expect(baseHead && scaledHead && scaledHead.axis).toEqual(baseHead?.axis); // axes stay unit
    base.geometry.dispose();
    scaled.geometry.dispose();
  });

  it("keeps species proportions: deer tall and antlered, wolf low, sheep wide, rabbit small", () => {
    const standing = new Map<string, number>();
    for (const species of HERD_SPECIES) {
      const geometry = buildWildlifeGeometry(species, 1);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      expect(box).not.toBeNull();
      if (box) standing.set(species, WILDLIFE_RENDER_PROFILES[species].bodyOffsetYM + box.max.y);
      geometry.dispose();
    }
    // Total standing height ordering (deer antler tip ≈ 1.6 m … rabbit ears ≈ 0.4 m).
    expect(standing.get("deer")).toBeGreaterThan(standing.get("wolves") ?? Number.POSITIVE_INFINITY);
    expect(standing.get("wolves")).toBeGreaterThan(standing.get("sheep") ?? Number.POSITIVE_INFINITY);
    expect(standing.get("sheep")).toBeGreaterThan(standing.get("rabbits") ?? Number.POSITIVE_INFINITY);
    expect(standing.get("rabbits")).toBeLessThan(0.5);

    // Deer: shoulder (body-part top) ≈ 1.0 m and antlers reach well above it.
    const deer = buildWildlifeModel("deer", 1);
    const ids = deer.geometry.getAttribute(WILDLIFE_PART_ID_ATTRIBUTE).array as Float32Array;
    const positions = deer.geometry.getAttribute("position").array as Float32Array;
    let bodyTop = Number.NEGATIVE_INFINITY;
    let headTop = Number.NEGATIVE_INFINITY;
    for (let v = 0; v < ids.length; v += 1) {
      const y = positions[v * 3 + 1];
      if (ids[v] === WILDLIFE_PART_SLOTS.body) bodyTop = Math.max(bodyTop, y);
      if (ids[v] === WILDLIFE_PART_SLOTS.head) headTop = Math.max(headTop, y);
    }
    expect(WILDLIFE_RENDER_PROFILES.deer.bodyOffsetYM + bodyTop).toBeCloseTo(1.0, 1); // shoulder height
    expect(headTop).toBeGreaterThan(0.7); // antler prongs above the raised head
    deer.geometry.computeBoundingBox();
    if (deer.geometry.boundingBox) {
      const size = deer.geometry.boundingBox.max.clone().sub(deer.geometry.boundingBox.min);
      expect(size.z).toBeGreaterThan(0.8); // body length dominates
      expect(size.z).toBeLessThan(1.6);
      expect(deer.geometry.boundingBox.max.y).toBeGreaterThan(deer.geometry.boundingBox.max.x); // slender, tall
    }
    deer.geometry.dispose();

    // Sheep read rounder/wider than deer; wolves stay below deer shoulder line.
    const sheep = buildWildlifeGeometry("sheep", 1);
    sheep.computeBoundingBox();
    const deerWidth = 0.26; // deer body box width
    expect(sheep.boundingBox && sheep.boundingBox.max.x - sheep.boundingBox.min.x).toBeGreaterThan(deerWidth);
    sheep.dispose();
  });

  it("keeps flock/school silhouettes unchanged and scaling linearly", () => {
    const bird = buildWildlifeGeometry("birds", 1);
    bird.computeBoundingBox();
    const birdBox = bird.boundingBox;
    expect(birdBox).not.toBeNull();
    if (birdBox) {
      expect(birdBox.max.x).toBeCloseTo(0.45, 5); // wing tip span
      expect(birdBox.min.x).toBeCloseTo(-0.45, 5);
      expect(birdBox.max.z).toBeGreaterThan(0.1); // nose forward +Z
      expect(birdBox.max.y - birdBox.min.y).toBeLessThan(0.5);
    }

    const scaled = buildWildlifeGeometry("birds", 2);
    scaled.computeBoundingBox();
    if (scaled.boundingBox && birdBox) {
      expect(scaled.boundingBox.max.x).toBeCloseTo(birdBox.max.x * 2, 5);
    }

    const fish = buildWildlifeGeometry("fish", 1);
    fish.computeBoundingBox();
    if (fish.boundingBox) {
      const size = fish.boundingBox.max.clone().sub(fish.boundingBox.min);
      expect(size.z).toBeGreaterThan(0.25); // teardrop length
      expect(size.x).toBeLessThan(size.y); // flattened profile
    }

    bird.dispose();
    scaled.dispose();
    fish.dispose();
  });
});
