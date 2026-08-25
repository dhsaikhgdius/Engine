import type { DirectorShotIr } from "../shot/shotIr";

/** One annotated instance in a frame, with pixel coverage, bounds, and semantic category. */
export interface DirectorInstanceAnnotation {
  objectId: string;
  name?: string;
  kind?: string;
  semanticCategory?: "character" | "prop" | "environment";
  rgb: [number, number, number];
  visiblePixels: number;
  frameCoverage: number;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

/** The complete instance annotations for a single frame. */
export interface DirectorInstanceAnnotations {
  schemaVersion: 1;
  contract: "director-instance-annotations-v1";
  frame: number;
  raster: { width: number; height: number; origin: "top-left" };
  instances: DirectorInstanceAnnotation[];
}

interface BuildDirectorInstanceAnnotationsInput {
  frame: number;
  width: number;
  height: number;
  rgba: Uint8Array;
  objectIdToRgb: Record<string, [number, number, number]>;
  shotIr: DirectorShotIr;
}

function packedRgb(red: number, green: number, blue: number): number {
  return red * 65_536 + green * 256 + blue;
}

function semanticCategory(kind: string): DirectorInstanceAnnotation["semanticCategory"] {
  if (kind === "character") return "character";
  if (kind === "prop") return "prop";
  return "environment";
}

/**
 * Build instance annotations from an object-id RGBA buffer: for each
 * known object, count visible pixels, compute 2D bounding boxes, and
 * attach semantic metadata from the shot IR.
 *
 * @param input - The frame number, raster dimensions, RGBA buffer, color map, and shot IR.
 * @returns The complete instance annotations for the frame.
 */
export function buildDirectorInstanceAnnotations({
  frame,
  width,
  height,
  rgba,
  objectIdToRgb,
  shotIr,
}: BuildDirectorInstanceAnnotationsInput): DirectorInstanceAnnotations {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Instance annotation buffer must contain ${width * height * 4} bytes; received ${rgba.length}.`);
  }

  const objectIdByColor = new Map<number, string>();
  const stats = new Map<string, { count: number; minX: number; minY: number; maxX: number; maxY: number }>();
  Object.entries(objectIdToRgb).forEach(([objectId, [red, green, blue]]) => {
    objectIdByColor.set(packedRgb(red, green, blue), objectId);
    stats.set(objectId, { count: 0, minX: width, minY: height, maxX: -1, maxY: -1 });
  });

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const objectId = objectIdByColor.get(packedRgb(rgba[offset]!, rgba[offset + 1]!, rgba[offset + 2]!));
      if (!objectId) continue;
      const objectStats = stats.get(objectId)!;
      objectStats.count += 1;
      objectStats.minX = Math.min(objectStats.minX, x);
      objectStats.minY = Math.min(objectStats.minY, y);
      objectStats.maxX = Math.max(objectStats.maxX, x);
      objectStats.maxY = Math.max(objectStats.maxY, y);
    }
  }

  const shotObjects = new Map(shotIr.objects.map((object) => [object.id, object]));
  const pixelCount = width * height;
  const instances = Object.entries(objectIdToRgb)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([objectId, rgb]): DirectorInstanceAnnotation => {
      const objectStats = stats.get(objectId)!;
      const object = shotObjects.get(objectId);
      return {
        objectId,
        ...(object ? { name: object.name, kind: object.kind, semanticCategory: semanticCategory(object.kind) } : {}),
        rgb,
        visiblePixels: objectStats.count,
        frameCoverage: objectStats.count / pixelCount,
        bounds:
          objectStats.count === 0
            ? null
            : {
                x: objectStats.minX,
                y: objectStats.minY,
                width: objectStats.maxX - objectStats.minX + 1,
                height: objectStats.maxY - objectStats.minY + 1,
              },
      };
    });

  return {
    schemaVersion: 1,
    contract: "director-instance-annotations-v1",
    frame,
    raster: { width, height, origin: "top-left" },
    instances,
  };
}
