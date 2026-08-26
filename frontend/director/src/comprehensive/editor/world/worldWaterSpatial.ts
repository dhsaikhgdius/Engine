import type { DirectorWorldRoad, DirectorWorldWaterBody } from "../schema/directorProject";
import { buildRiverRibbonData } from "./river/riverGeometry";
import { buildRoadSpline } from "./traffic/roadSpline";
import { computeWaterTroughLift, resolveWaterOccluderHeight } from "./water/waterParams";

/** Clearance above the highest modeled crest used by the semantic road repair. */
export const ROAD_WATER_CLEARANCE_M = 0.45;

/** Height above a water crest over which a fire transitions back to full strength. */
const COMBUSTION_RECOVERY_HEIGHT_M = 0.25;

/** The river shader's two wave bands can sum to 1.22× the authored amplitude. */
const RIVER_CREST_FACTOR = 1.22;

export interface WaterBasinFootprint {
  centerX: number;
  centerY: number;
  centerZ: number;
  halfSizeX: number;
  halfSizeZ: number;
  rotationDegrees: number;
  inverseCos: number;
  inverseSin: number;
  crestAmplitudeM: number;
  occluderHeightM: number | null;
}

export interface WaterRiverSegmentFootprint {
  riverIndex: number;
  startX: number;
  startY: number;
  startZ: number;
  endX: number;
  endY: number;
  endZ: number;
  halfWidthStartM: number;
  halfWidthEndM: number;
  crestAmplitudeM: number;
  troughLiftM: number;
}

/** Stable, precomputed geometry used by render-time and inspector queries. */
export interface WaterSpatialIndex {
  basins: WaterBasinFootprint[];
  riverSegments: WaterRiverSegmentFootprint[];
}

/**
 * Converts visible authored water into allocation-free spatial queries.
 * River bounds come from the same sampled ribbon used by the renderer, so a
 * river never falls back to its schema-only placeholder surface rectangle.
 */
export function buildWaterSpatialIndex(
  waterBodies: ReadonlyArray<DirectorWorldWaterBody>,
  groundHeight?: number,
  sampleGroundHeight?: (x: number, z: number) => number | null,
): WaterSpatialIndex {
  const basins: WaterBasinFootprint[] = [];
  const riverSegments: WaterRiverSegmentFootprint[] = [];
  let riverIndex = 0;

  for (const body of waterBodies) {
    if (!body.river) {
      const radians = (-body.surface.rotationDegrees * Math.PI) / 180;
      basins.push({
        centerX: body.surface.center[0],
        centerY: body.surface.center[1],
        centerZ: body.surface.center[2],
        halfSizeX: body.surface.sizeX * 0.5,
        halfSizeZ: body.surface.sizeZ * 0.5,
        rotationDegrees: body.surface.rotationDegrees,
        inverseCos: Math.cos(radians),
        inverseSin: Math.sin(radians),
        crestAmplitudeM: body.waveAmplitude,
        occluderHeightM:
          groundHeight === undefined ? null : resolveWaterOccluderHeight(body, groundHeight, sampleGroundHeight),
      });
      continue;
    }

    const ribbon = buildRiverRibbonData(body.river);
    let riverTroughLiftM = 0;
    if (groundHeight !== undefined) {
      let occluderHeight = groundHeight;
      let minimumSurfaceY = body.river.points[0]![1];
      for (const point of body.river.points) {
        minimumSurfaceY = Math.min(minimumSurfaceY, point[1]);
        const sampledHeight = sampleGroundHeight?.(point[0], point[2]);
        if (sampledHeight != null) occluderHeight = Math.max(occluderHeight, sampledHeight);
      }
      riverTroughLiftM = computeWaterTroughLift(
        minimumSurfaceY,
        body.waveAmplitude * RIVER_CREST_FACTOR,
        occluderHeight,
      );
    }
    for (let sample = 0; sample < ribbon.sampleCount - 1; sample += 1) {
      const startLeft = sample * 6;
      const startRight = startLeft + 3;
      const endLeft = (sample + 1) * 6;
      const endRight = endLeft + 3;
      const startX = (ribbon.positions[startLeft]! + ribbon.positions[startRight]!) * 0.5;
      const startY = (ribbon.positions[startLeft + 1]! + ribbon.positions[startRight + 1]!) * 0.5;
      const startZ = (ribbon.positions[startLeft + 2]! + ribbon.positions[startRight + 2]!) * 0.5;
      const endX = (ribbon.positions[endLeft]! + ribbon.positions[endRight]!) * 0.5;
      const endY = (ribbon.positions[endLeft + 1]! + ribbon.positions[endRight + 1]!) * 0.5;
      const endZ = (ribbon.positions[endLeft + 2]! + ribbon.positions[endRight + 2]!) * 0.5;
      riverSegments.push({
        riverIndex,
        startX,
        startY,
        startZ,
        endX,
        endY,
        endZ,
        halfWidthStartM: Math.hypot(ribbon.positions[startLeft]! - startX, ribbon.positions[startLeft + 2]! - startZ),
        halfWidthEndM: Math.hypot(ribbon.positions[endLeft]! - endX, ribbon.positions[endLeft + 2]! - endZ),
        crestAmplitudeM: body.waveAmplitude * RIVER_CREST_FACTOR,
        troughLiftM: riverTroughLiftM,
      });
    }
    riverIndex += 1;
  }

  return { basins, riverSegments };
}

/** Highest conservative water crest at (x, z), or null when the point is dry. */
export function queryWaterSurfaceCeiling(
  water: WaterSpatialIndex,
  x: number,
  z: number,
  horizontalPaddingM: number = 0,
  basinAmplitudeScale: number = 1,
): number | null {
  let ceiling: number | null = null;
  const padding = Math.max(0, horizontalPaddingM);
  const amplitudeScale = Math.max(0, basinAmplitudeScale);

  for (const basin of water.basins) {
    const dx = x - basin.centerX;
    const dz = z - basin.centerZ;
    const localX = dx * basin.inverseCos - dz * basin.inverseSin;
    const localZ = dx * basin.inverseSin + dz * basin.inverseCos;
    if (Math.abs(localX) > basin.halfSizeX + padding || Math.abs(localZ) > basin.halfSizeZ + padding) continue;
    const amplitude = basin.crestAmplitudeM * amplitudeScale;
    const troughLift =
      basin.occluderHeightM === null ? 0 : computeWaterTroughLift(basin.centerY, amplitude, basin.occluderHeightM);
    const candidate = basin.centerY + troughLift + amplitude;
    if (ceiling === null || candidate > ceiling) ceiling = candidate;
  }

  let segmentIndex = 0;
  while (segmentIndex < water.riverSegments.length) {
    const currentRiver = water.riverSegments[segmentIndex]!.riverIndex;
    let nearestDistanceSquared = Number.POSITIVE_INFINITY;
    let nearestSurfaceY = 0;
    let crestAmplitudeM = 0;
    while (
      segmentIndex < water.riverSegments.length &&
      water.riverSegments[segmentIndex]!.riverIndex === currentRiver
    ) {
      const segment = water.riverSegments[segmentIndex]!;
      const dx = segment.endX - segment.startX;
      const dz = segment.endZ - segment.startZ;
      const lengthSquared = dx * dx + dz * dz;
      const projection =
        lengthSquared > 0 ? ((x - segment.startX) * dx + (z - segment.startZ) * dz) / lengthSquared : 0;
      const t = Math.min(1, Math.max(0, projection));
      const nearestX = segment.startX + dx * t;
      const nearestZ = segment.startZ + dz * t;
      const distanceSquared = (x - nearestX) ** 2 + (z - nearestZ) ** 2;
      const halfWidth = segment.halfWidthStartM + (segment.halfWidthEndM - segment.halfWidthStartM) * t;
      if (distanceSquared <= (halfWidth + padding) ** 2 && distanceSquared < nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearestSurfaceY = segment.startY + (segment.endY - segment.startY) * t + segment.troughLiftM;
        crestAmplitudeM = segment.crestAmplitudeM;
      }
      segmentIndex += 1;
    }
    if (nearestDistanceSquared < Number.POSITIVE_INFINITY) {
      const candidate = nearestSurfaceY + crestAmplitudeM;
      if (ceiling === null || candidate > ceiling) ceiling = candidate;
    }
  }

  return ceiling;
}

/** 0 below the modeled crest, smoothly recovering to 1 over 25 cm. */
export function evaluateCombustionWaterFactor(
  origin: readonly [number, number, number],
  water: WaterSpatialIndex,
  basinAmplitudeScale: number = 1,
): number {
  const ceiling = queryWaterSurfaceCeiling(water, origin[0], origin[2], 0, basinAmplitudeScale);
  if (ceiling === null) return 1;
  const t = Math.min(1, Math.max(0, (origin[1] - ceiling) / COMBUSTION_RECOVERY_HEIGHT_M));
  return t * t * (3 - 2 * t);
}

export interface CombustionWaterConflict {
  requiredLiftM: number;
  waterCeilingY: number;
}

/** Returns the vertical move needed for an emitter to burn at full strength. */
export function findCombustionWaterConflict(
  origin: readonly [number, number, number],
  water: WaterSpatialIndex,
  basinAmplitudeScale: number = 1,
): CombustionWaterConflict | null {
  const waterCeilingY = queryWaterSurfaceCeiling(water, origin[0], origin[2], 0, basinAmplitudeScale);
  if (waterCeilingY === null) return null;
  const requiredLiftM = waterCeilingY + COMBUSTION_RECOVERY_HEIGHT_M - origin[1];
  return requiredLiftM > 1e-6 ? { requiredLiftM, waterCeilingY } : null;
}

export interface RoadWaterConflict {
  requiredLiftM: number;
  sample: readonly [number, number, number];
  waterCeilingY: number;
}

/** Detects whether any sampled part of the full road width cuts through water. */
export function findRoadWaterConflict(
  road: DirectorWorldRoad,
  water: WaterSpatialIndex,
  basinAmplitudeScale: number = 1,
): RoadWaterConflict | null {
  const spline = buildRoadSpline(road.points, road.loop);
  let requiredLiftM = 0;
  let conflictX = 0;
  let conflictY = 0;
  let conflictZ = 0;
  let conflictCeilingY = 0;

  for (let sample = 0; sample < spline.sampleCount; sample += 1) {
    const offset = sample * 3;
    const x = spline.positions[offset]!;
    const y = spline.positions[offset + 1]!;
    const z = spline.positions[offset + 2]!;
    const waterCeilingY = queryWaterSurfaceCeiling(water, x, z, road.widthM * 0.5, basinAmplitudeScale);
    if (waterCeilingY === null) continue;
    const lift = waterCeilingY + ROAD_WATER_CLEARANCE_M - y;
    if (lift <= requiredLiftM) continue;
    requiredLiftM = lift;
    conflictX = x;
    conflictY = y;
    conflictZ = z;
    conflictCeilingY = waterCeilingY;
  }

  return requiredLiftM > 1e-6
    ? {
        requiredLiftM,
        sample: [conflictX, conflictY, conflictZ],
        waterCeilingY: conflictCeilingY,
      }
    : null;
}

/** Uniformly raises every control point, preserving the authored grade. */
export function raiseRoadAboveWater(road: DirectorWorldRoad, conflict: RoadWaterConflict): DirectorWorldRoad {
  return {
    ...road,
    points: road.points.map(([x, y, z]) => [x, y + conflict.requiredLiftM, z]),
  };
}
