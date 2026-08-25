import { Euler, Quaternion, Vector3 } from "three";
import { clamp } from "../../../../../../../packages/protocol/src/primitives";
import type { DirectorCharacterIkEffector, DirectorCharacterIkTarget } from "../../schema/directorProject";
import { getBodyPreset, type CharacterBodyType } from "./bodyTypes";

export type CharacterIkVector = [number, number, number];

/** Geometric description of a two-bone chain (e.g. upper arm + forearm) in its rest pose. */
export interface CharacterIkChainGeometry {
  root: CharacterIkVector;
  upperRestVector: CharacterIkVector;
  lowerRestVector: CharacterIkVector;
}

/** Result of a two-bone IK solve, including the resolved joint positions and reachability metadata. */
export interface TwoBoneIkSolution {
  root: CharacterIkVector;
  middle: CharacterIkVector;
  end: CharacterIkVector;
  requestedTarget: CharacterIkVector;
  distance: number;
  clamped: boolean;
  reachable: boolean;
}

/** Input parameters for a two-bone IK solve. */
export interface TwoBoneIkInput {
  root: CharacterIkVector;
  target: CharacterIkVector;
  pole: CharacterIkVector;
  upperLength: number;
  lowerLength: number;
  reachClamp?: number;
}

/** Stable vectors and result tuples for allocation-free runtime IK sampling. */
export interface TwoBoneIkRuntime {
  safeRoot: Vector3;
  safeTarget: Vector3;
  safePole: Vector3;
  requestedDelta: Vector3;
  direction: Vector3;
  end: Vector3;
  poleDirection: Vector3;
  bendDirection: Vector3;
  middle: Vector3;
  solution: TwoBoneIkSolution;
}

/** Rotations produced by the character IK solver for the upper and lower segments of a two-bone chain. */
export interface CharacterIkRotations {
  upperRotation: CharacterIkVector;
  lowerRotation: CharacterIkVector;
  solution: TwoBoneIkSolution;
}

const IK_EPSILON = 1e-6;
const DOWN = new Vector3(0, -1, 0);

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function finiteVector(value: CharacterIkVector, fallback: CharacterIkVector): Vector3 {
  return new Vector3(finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2]));
}

function tuple(value: Vector3): CharacterIkVector {
  return [value.x, value.y, value.z];
}

function writeTuple(target: CharacterIkVector, source: Vector3) {
  target[0] = source.x;
  target[1] = source.y;
  target[2] = source.z;
}

function writeFiniteVector(
  target: Vector3,
  value: CharacterIkVector,
  fallbackX: number,
  fallbackY: number,
  fallbackZ: number,
) {
  target.set(finite(value[0], fallbackX), finite(value[1], fallbackY), finite(value[2], fallbackZ));
}

function writeDeterministicPerpendicular(target: Vector3, direction: Vector3) {
  const x = Math.abs(direction.x);
  const y = Math.abs(direction.y);
  const z = Math.abs(direction.z);
  if (x <= y && x <= z) target.set(1, 0, 0);
  else if (y <= z) target.set(0, 1, 0);
  else target.set(0, 0, 1);
  return target.addScaledVector(direction, -target.dot(direction)).normalize();
}

/** Allocation-free creation of a new IK runtime with pre-allocated scratch vectors. */
export function createTwoBoneIkRuntime(): TwoBoneIkRuntime {
  return {
    safeRoot: new Vector3(),
    safeTarget: new Vector3(),
    safePole: new Vector3(),
    requestedDelta: new Vector3(),
    direction: new Vector3(),
    end: new Vector3(),
    poleDirection: new Vector3(),
    bendDirection: new Vector3(),
    middle: new Vector3(),
    solution: {
      root: [0, 0, 0],
      middle: [0, 0, 0],
      end: [0, 0, 0],
      requestedTarget: [0, 0, 0],
      distance: 0,
      clamped: false,
      reachable: false,
    },
  };
}

/**
 * Stable analytic two-bone solve. It never stretches either segment: targets
 * outside the configured reach are projected onto the reachable shell, and a
 * deterministic bend plane is used when target/pole vectors are degenerate.
 */
export function solveTwoBoneIkInto(
  { root, target, pole, upperLength, lowerLength, reachClamp = 1 }: TwoBoneIkInput,
  runtime: TwoBoneIkRuntime,
): TwoBoneIkSolution {
  const { safeRoot, safeTarget, safePole } = runtime;
  writeFiniteVector(safeRoot, root, 0, 0, 0);
  writeFiniteVector(safeTarget, target, safeRoot.x, safeRoot.y - 1, safeRoot.z);
  writeFiniteVector(safePole, pole, safeRoot.x, safeRoot.y, safeRoot.z + 1);
  const upper = Math.max(IK_EPSILON, Math.abs(finite(upperLength, 1)));
  const lower = Math.max(IK_EPSILON, Math.abs(finite(lowerLength, 1)));
  const requestedDelta = runtime.requestedDelta.subVectors(safeTarget, safeRoot);
  const requestedDistance = requestedDelta.length();
  const direction = runtime.direction;
  if (requestedDistance > IK_EPSILON) direction.copy(requestedDelta).divideScalar(requestedDistance);
  else direction.copy(DOWN);
  const minimumReach = Math.abs(upper - lower) + IK_EPSILON;
  const fullReach = Math.max(minimumReach, upper + lower - IK_EPSILON);
  const reachLimit = clamp(finite(reachClamp, 1), 0.05, 1);
  const maximumReach = Math.max(minimumReach, fullReach * reachLimit);
  const distance = clamp(requestedDistance, minimumReach, maximumReach);
  const end = runtime.end.copy(safeRoot).addScaledVector(direction, distance);

  const poleDirection = runtime.poleDirection.subVectors(safePole, safeRoot);
  poleDirection.addScaledVector(direction, -poleDirection.dot(direction));
  const bendDirection = runtime.bendDirection;
  if (poleDirection.lengthSq() > IK_EPSILON * IK_EPSILON) bendDirection.copy(poleDirection).normalize();
  else writeDeterministicPerpendicular(bendDirection, direction);

  const along = clamp((upper * upper - lower * lower + distance * distance) / (2 * distance), -upper, upper);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const middle = runtime.middle.copy(safeRoot).addScaledVector(direction, along).addScaledVector(bendDirection, height);
  const reachable = requestedDistance >= minimumReach && requestedDistance <= maximumReach;

  writeTuple(runtime.solution.root, safeRoot);
  writeTuple(runtime.solution.middle, middle);
  writeTuple(runtime.solution.end, end);
  writeTuple(runtime.solution.requestedTarget, safeTarget);
  runtime.solution.distance = distance;
  runtime.solution.clamped = !reachable;
  runtime.solution.reachable = reachable;
  return runtime.solution;
}

/**
 * Convenience wrapper that creates a fresh runtime, solves, and discards it.
 * Prefer {@link solveTwoBoneIkInto} with a reused runtime for hot paths.
 *
 * @param input - The IK solve parameters.
 * @returns The solved joint positions and reachability metadata.
 */
export function solveTwoBoneIk(input: TwoBoneIkInput): TwoBoneIkSolution {
  return solveTwoBoneIkInto(input, createTwoBoneIkRuntime());
}

function quaternionFromEuler(rotation: CharacterIkVector) {
  return new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2], "XYZ"));
}

function eulerTuple(quaternion: Quaternion): CharacterIkVector {
  const rotation = new Euler().setFromQuaternion(quaternion, "XYZ");
  return [rotation.x, rotation.y, rotation.z];
}

/** Resolve an IK effector over the existing authored pose instead of replacing it. */
export function solveCharacterIkRotations({
  chain,
  effector,
  upperBaseRotation,
  lowerBaseRotation,
}: {
  chain: CharacterIkChainGeometry;
  effector: DirectorCharacterIkTarget;
  upperBaseRotation: CharacterIkVector;
  lowerBaseRotation: CharacterIkVector;
}): CharacterIkRotations {
  const upperRestVector = finiteVector(chain.upperRestVector, [0, -1, 0]);
  const lowerRestVector = finiteVector(chain.lowerRestVector, [0, -1, 0]);
  const upperLength = Math.max(IK_EPSILON, upperRestVector.length());
  const lowerLength = Math.max(IK_EPSILON, lowerRestVector.length());
  const solution = solveTwoBoneIk({
    root: chain.root,
    target: effector.target,
    pole: effector.pole,
    upperLength,
    lowerLength,
    reachClamp: effector.reachClamp,
  });
  const weight = clamp(finite(effector.weight, 1), 0, 1);
  const upperBase = quaternionFromEuler(upperBaseRotation);
  const lowerBase = quaternionFromEuler(lowerBaseRotation);
  if (weight <= IK_EPSILON) {
    return {
      upperRotation: [...upperBaseRotation],
      lowerRotation: [...lowerBaseRotation],
      solution,
    };
  }

  const desiredUpperDirection = finiteVector(solution.middle, chain.root).sub(finiteVector(chain.root, [0, 0, 0]));
  if (desiredUpperDirection.lengthSq() <= IK_EPSILON * IK_EPSILON) desiredUpperDirection.copy(DOWN);
  desiredUpperDirection.normalize();
  const upperTarget = new Quaternion().setFromUnitVectors(upperRestVector.clone().normalize(), desiredUpperDirection);
  const upperRotation = upperBase.clone().slerp(upperTarget, weight).normalize();

  const actualMiddle = finiteVector(chain.root, [0, 0, 0]).add(upperRestVector.clone().applyQuaternion(upperRotation));
  const desiredLowerDirection = finiteVector(solution.end, tuple(actualMiddle)).sub(actualMiddle);
  if (desiredLowerDirection.lengthSq() <= IK_EPSILON * IK_EPSILON) {
    desiredLowerDirection.copy(upperRestVector).applyQuaternion(upperRotation);
  }
  desiredLowerDirection.normalize().applyQuaternion(upperRotation.clone().invert());
  const lowerTarget = new Quaternion().setFromUnitVectors(lowerRestVector.clone().normalize(), desiredLowerDirection);
  const lowerRotation = lowerBase.clone().slerp(lowerTarget, weight).normalize();

  return {
    upperRotation: eulerTuple(upperRotation),
    lowerRotation: eulerTuple(lowerRotation),
    solution,
  };
}

/**
 * Computes the rest-pose two-bone chain geometry for a given IK effector and body type.
 *
 * @param bodyType - The character body type determining proportions.
 * @param effector - The IK effector (leftHand, rightHand, leftFoot, or rightFoot).
 * @returns The chain root position, upper rest vector, and lower rest vector.
 */
export function getCharacterIkChainGeometry(
  bodyType: CharacterBodyType | undefined,
  effector: DirectorCharacterIkEffector,
): CharacterIkChainGeometry {
  const p = getBodyPreset(bodyType).proportions;
  if (effector === "leftHand" || effector === "rightHand") {
    const side = effector === "leftHand" ? -1 : 1;
    const abdomenY = p.hipY + p.pelvisRadius * 0.6 + p.torsoLowerHeight * 0.5;
    const chestY = abdomenY + p.torsoLowerHeight * 0.5 + p.torsoUpperHeight * 0.5 + p.torsoUpperRadius * 0.1;
    const shoulderY = chestY + p.torsoUpperHeight * 0.16 + p.shoulderRadius * 0.4;
    const armOriginY = shoulderY - p.shoulderRadius * 0.55;
    const elbowY = -(p.upperArmLength + p.upperArmRadius + p.elbowRadius);
    const wristY = -(p.forearmLength + p.forearmRadius + p.wristRadius);
    const handY = wristY - p.handRadius - 0.05;
    return {
      root: [side * p.shoulderWidth, armOriginY, 0],
      upperRestVector: [0, elbowY, 0],
      lowerRestVector: [0, handY, 0.02],
    };
  }

  const side = effector === "leftFoot" ? -1 : 1;
  const legOriginY = p.hipY - p.pelvisRadius * 0.35;
  const kneeY = -(p.thighLength + p.thighRadius + p.kneeRadius);
  const ankleY = -(p.calfLength + p.calfRadius + p.ankleRadius);
  const footY = ankleY - p.footRadius - 0.045;
  return {
    root: [side * p.legSpread, legOriginY, 0],
    upperRestVector: [0, kneeY, 0],
    lowerRestVector: [0, footY, p.footRadius * 0.74],
  };
}

/**
 * Returns the default IK target for a given effector, computed as the rest-pose end-effector position
 * with a pole vector offset in front of the chain.
 *
 * @param bodyType - The character body type determining proportions.
 * @param effector - The IK effector (leftHand, rightHand, leftFoot, or rightFoot).
 * @returns A default IK target with weight 1 and full reach clamp.
 */
export function getDefaultCharacterIkTarget(
  bodyType: CharacterBodyType | undefined,
  effector: DirectorCharacterIkEffector,
): DirectorCharacterIkTarget {
  const chain = getCharacterIkChainGeometry(bodyType, effector);
  const root = finiteVector(chain.root, [0, 0, 0]);
  const target = root
    .clone()
    .add(finiteVector(chain.upperRestVector, [0, -1, 0]))
    .add(finiteVector(chain.lowerRestVector, [0, -1, 0]));
  const isHand = effector === "leftHand" || effector === "rightHand";
  const pole = root
    .clone()
    .add(isHand ? new Vector3(effector === "leftHand" ? -0.24 : 0.24, -0.25, 0.65) : new Vector3(0, -0.25, 0.65));
  return { target: tuple(target), pole: tuple(pole), weight: 1, reachClamp: 1 };
}
