import { Euler, Quaternion, Vector3 } from "three";
import type {
  CharacterRigState,
  DirectorCharacterIkEffector,
  DirectorCharacterIkTarget,
} from "../../schema/directorProject";
import { FLICK_HUMAN_ARTICULATION_COLOR, FLICK_HUMAN_DEFAULT_COLOR } from "../../schema/flickHumanAppearance";
import { resolveCharacterPoseControls } from "../../presets/mannequinPosePresets";
import { clampCharacterPoseControlValue } from "../../schema/poseSchema";
import { getBodyPreset, type CharacterBodyProportions, type CharacterBodyType } from "./bodyTypes";
import { degreesToRadians, getRotationFromControls, getSingleAxisRotation } from "./mannequinPose";
import { ArticulationRing, Foot, Hand, Head, Joint, Segment, Torso } from "./mannequinParts";
import { getCharacterIkChainGeometry, solveCharacterIkRotations, type CharacterIkVector } from "./characterIk";

interface ProceduralMannequinProps {
  appearance?: "classic" | "flick-stage";
  bodyType?: CharacterBodyType;
  color?: string;
  rigState?: CharacterRigState;
}

const LEGACY_AUTOMATIC_CHARACTER_BLUE = "#4f8ef7";

function getLimbRotation(
  controls: Record<string, number>,
  prefix: string,
  bodyType?: CharacterBodyType,
): [number, number, number] {
  return [
    degreesToRadians(clampCharacterPoseControlValue(`${prefix}.pitch`, controls[`${prefix}.pitch`] ?? 0, bodyType)),
    degreesToRadians(clampCharacterPoseControlValue(`${prefix}.twist`, controls[`${prefix}.twist`] ?? 0, bodyType)),
    degreesToRadians(clampCharacterPoseControlValue(`${prefix}.spread`, controls[`${prefix}.spread`] ?? 0, bodyType)),
  ];
}

function transformIkTargetToParent(target: DirectorCharacterIkTarget, parentRotation: CharacterIkVector) {
  const inverseParent = new Quaternion().setFromEuler(new Euler(...parentRotation)).invert();
  const transform = (value: CharacterIkVector): CharacterIkVector => {
    const transformed = new Vector3(...value).applyQuaternion(inverseParent);
    return [transformed.x, transformed.y, transformed.z];
  };
  return { ...target, target: transform(target.target), pole: transform(target.pole) };
}

function resolveLimbIk(
  bodyType: CharacterBodyType | undefined,
  effectorName: DirectorCharacterIkEffector,
  effector: DirectorCharacterIkTarget | undefined,
  upperBaseRotation: CharacterIkVector,
  lowerBaseRotation: CharacterIkVector,
  parentRotation?: CharacterIkVector,
) {
  if (!effector) return { upperRotation: upperBaseRotation, lowerRotation: lowerBaseRotation };
  return solveCharacterIkRotations({
    chain: getCharacterIkChainGeometry(bodyType, effectorName),
    effector: parentRotation ? transformIkTargetToParent(effector, parentRotation) : effector,
    upperBaseRotation,
    lowerBaseRotation,
  });
}

interface MannequinLimbProps {
  articulationColor?: string;
  color: string;
  ik: { upperRotation: CharacterIkVector; lowerRotation: CharacterIkVector };
  jointScale: [number, number, number];
  p: CharacterBodyProportions;
  side: "left" | "right";
}

function MannequinLimb({
  articulationColor,
  color,
  ik,
  jointScale,
  p,
  side,
  kind,
  originY,
  middleY,
  distalY,
  endY,
}: MannequinLimbProps & {
  kind: "arm" | "leg";
  originY: number;
  middleY: number;
  distalY: number;
  endY: number;
}) {
  const arm = kind === "arm";
  const anatomy = arm
    ? {
        rootOffset: p.shoulderWidth,
        rootJoint: "shoulder",
        rootRingRadius: p.shoulderRadius * 1.1,
        upperLength: p.upperArmLength,
        upperRadius: p.upperArmRadius,
        middleJoint: "elbow",
        middleRadius: p.elbowRadius,
        middleRingRadius: p.elbowRadius * 1.12,
        lowerLength: p.forearmLength,
        lowerRadius: p.forearmRadius,
        distalJoint: "wrist",
        distalRadius: p.wristRadius,
      }
    : {
        rootOffset: p.legSpread,
        rootJoint: "hip",
        rootRingRadius: p.thighRadius * 1.18,
        upperLength: p.thighLength,
        upperRadius: p.thighRadius,
        middleJoint: "knee",
        middleRadius: p.kneeRadius,
        middleRingRadius: p.kneeRadius * 1.14,
        lowerLength: p.calfLength,
        lowerRadius: p.calfRadius,
        distalJoint: "ankle",
        distalRadius: p.ankleRadius,
      };
  return (
    <group
      name={`mannequin-${side}-${kind}`}
      position={[side === "left" ? -anatomy.rootOffset : anatomy.rootOffset, originY, 0]}
      rotation={ik.upperRotation}
    >
      {articulationColor ? (
        <ArticulationRing
          color={articulationColor}
          name={`flick-stage-${side}-${anatomy.rootJoint}-collar`}
          position={[0, 0, 0]}
          radius={anatomy.rootRingRadius}
        />
      ) : null}
      <Segment
        color={color}
        length={anatomy.upperLength}
        position={[0, -(anatomy.upperLength * 0.5 + anatomy.upperRadius), 0]}
        radius={anatomy.upperRadius}
      />
      <group name={`mannequin-${side}-${anatomy.middleJoint}`} position={[0, middleY, 0]} rotation={ik.lowerRotation}>
        {articulationColor ? (
          <ArticulationRing
            color={articulationColor}
            name={`flick-stage-${side}-${anatomy.middleJoint}-collar`}
            position={[0, 0, 0]}
            radius={anatomy.middleRingRadius}
          />
        ) : null}
        <Joint color={color} position={[0, 0, 0]} radius={anatomy.middleRadius} scale={jointScale} />
        <Segment
          color={color}
          length={anatomy.lowerLength}
          position={[0, -(anatomy.lowerLength * 0.5 + anatomy.lowerRadius), 0]}
          radius={anatomy.lowerRadius}
        />
        {articulationColor ? (
          <ArticulationRing
            color={articulationColor}
            name={`flick-stage-${side}-${anatomy.distalJoint}-collar`}
            position={[0, distalY, 0]}
            radius={anatomy.distalRadius * 1.18}
          />
        ) : null}
        <Joint color={color} position={[0, distalY, 0]} radius={anatomy.distalRadius} scale={jointScale} />
        {arm ? (
          <Hand color={color} position={[0, endY, 0.02]} radius={p.handRadius} scale={p.handScale} side={side} />
        ) : (
          <Foot
            color={color}
            length={p.footLength}
            position={[0, endY, p.footRadius * 0.74]}
            radius={p.footRadius}
            scale={p.footScale}
            side={side}
          />
        )}
      </group>
    </group>
  );
}

/**
 * Renders a complete procedural humanoid character from body proportions, pose controls, and IK targets.
 *
 * The character is assembled from shared geometric parts (torso, head, limbs, joints) and supports
 * two visual modes: the classic inspector look and the flick-stage appearance with articulation rings.
 * All limb rotations are derived from the character rig state; IK targets override the FK pose when present.
 *
 * @param props.appearance - Visual mode: "classic" for the inspector or "flick-stage" for the Stage viewport.
 * @param props.bodyType - The body type preset controlling proportions.
 * @param props.color - The base material color; the historic auto-blue default is remapped in flick-stage mode.
 * @param props.rigState - The character rig state with pose controls and optional IK targets.
 */
export function ProceduralMannequin({
  appearance = "classic",
  bodyType,
  color = "#4F8EF7",
  rigState,
}: ProceduralMannequinProps) {
  const preset = getBodyPreset(bodyType);
  const controls = resolveCharacterPoseControls(rigState);
  const p = preset.proportions;
  const stageAppearance = appearance === "flick-stage";
  // Previous versions auto-created blue mannequins. Treat only that historic
  // default as the new warm core Human; deliberate inspector colours remain editable.
  const mannequinColor =
    stageAppearance && color.toLowerCase() === LEGACY_AUTOMATIC_CHARACTER_BLUE ? FLICK_HUMAN_DEFAULT_COLOR : color;
  const articulationColor = stageAppearance ? FLICK_HUMAN_ARTICULATION_COLOR : undefined;

  const bodyRotation = getRotationFromControls(controls, "body", preset.bodyType);
  const torsoRotation = getRotationFromControls(controls, "torso", preset.bodyType);
  const headRotation = getRotationFromControls(controls, "head", preset.bodyType);
  const leftShoulderRotation = getLimbRotation(controls, "leftShoulder", preset.bodyType);
  const rightShoulderRotation = getLimbRotation(controls, "rightShoulder", preset.bodyType);
  const leftElbowRotation = getSingleAxisRotation(controls, "leftElbow.bend", preset.bodyType);
  const rightElbowRotation = getSingleAxisRotation(controls, "rightElbow.bend", preset.bodyType);
  const leftHipRotation = getLimbRotation(controls, "leftHip", preset.bodyType);
  const rightHipRotation = getLimbRotation(controls, "rightHip", preset.bodyType);
  const leftKneeRotation = getSingleAxisRotation(controls, "leftKnee.bend", preset.bodyType);
  const rightKneeRotation = getSingleAxisRotation(controls, "rightKnee.bend", preset.bodyType);
  const ik = rigState?.ik;

  const abdomenY = p.hipY + p.pelvisRadius * 0.6 + p.torsoLowerHeight * 0.5;
  const chestY = abdomenY + p.torsoLowerHeight * 0.5 + p.torsoUpperHeight * 0.5 + p.torsoUpperRadius * 0.1;
  const neckY = chestY + p.torsoUpperHeight * 0.5 + p.neckHeight * 0.5 + p.torsoUpperRadius * 0.2;
  const headY = neckY + p.neckHeight * 0.5 + p.headRadius * 0.75;

  const shoulderY = chestY + p.torsoUpperHeight * 0.16 + p.shoulderRadius * 0.4;
  const armOriginY = shoulderY - p.shoulderRadius * 0.55;
  const elbowY = -(p.upperArmLength + p.upperArmRadius + p.elbowRadius);
  const wristY = -(p.forearmLength + p.forearmRadius + p.wristRadius);
  const handY = wristY - p.handRadius - 0.05;

  const hipJointY = p.hipY - p.pelvisRadius * 0.15;
  const legOriginY = p.hipY - p.pelvisRadius * 0.35;
  const kneeY = -(p.thighLength + p.thighRadius + p.kneeRadius);
  const ankleY = -(p.calfLength + p.calfRadius + p.ankleRadius);
  const footY = ankleY - p.footRadius - 0.045;
  const jointScale: [number, number, number] = [p.jointRadiusScale, p.jointRadiusScale, p.jointRadiusScale];
  const leftArmIk = resolveLimbIk(
    preset.bodyType,
    "leftHand",
    ik?.leftHand,
    leftShoulderRotation,
    leftElbowRotation,
    torsoRotation,
  );
  const rightArmIk = resolveLimbIk(
    preset.bodyType,
    "rightHand",
    ik?.rightHand,
    rightShoulderRotation,
    rightElbowRotation,
    torsoRotation,
  );
  const leftLegIk = resolveLimbIk(preset.bodyType, "leftFoot", ik?.leftFoot, leftHipRotation, leftKneeRotation);
  const rightLegIk = resolveLimbIk(preset.bodyType, "rightFoot", ik?.rightFoot, rightHipRotation, rightKneeRotation);

  return (
    <group
      name={stageAppearance ? `flick-stage-human-${preset.bodyType}` : `procedural-${preset.bodyType}`}
      rotation={bodyRotation}
      scale={preset.defaultScale}
    >
      <group rotation={torsoRotation}>
        <Torso
          accentColor={articulationColor}
          abdomenPosition={[0, abdomenY, 0]}
          abdomenScale={p.torsoLowerScale}
          chestPosition={[0, chestY, 0]}
          chestScale={p.torsoUpperScale}
          color={mannequinColor}
          pelvisPosition={[0, p.hipY, 0]}
          pelvisRadius={p.pelvisRadius}
          pelvisScale={p.pelvisScale}
          torsoLowerHeight={p.torsoLowerHeight}
          torsoLowerRadius={p.torsoLowerRadius}
          torsoUpperHeight={p.torsoUpperHeight}
          torsoUpperRadius={p.torsoUpperRadius}
        />
        <Head
          color={mannequinColor}
          eyeRadius={p.eyeRadius}
          faceOffsetZ={p.faceOffsetZ}
          featureless={stageAppearance}
          headRadius={p.headRadius}
          headScale={p.headScale}
          mouthScale={p.mouthScale}
          neckHeight={p.neckHeight}
          neckPosition={[0, neckY, 0]}
          neckRadius={p.neckRadius}
          noseScale={p.noseScale}
          position={[0, headY, 0]}
          rotation={headRotation}
        />

        {articulationColor ? (
          <ArticulationRing
            color={articulationColor}
            name="flick-stage-neck-collar"
            position={[0, neckY - p.neckHeight * 0.28, 0]}
            radius={p.neckRadius * 1.13}
          />
        ) : null}

        <Joint
          color={mannequinColor}
          position={[-p.shoulderWidth * 0.86, shoulderY, 0]}
          radius={p.shoulderRadius}
          scale={jointScale}
        />
        <Joint
          color={mannequinColor}
          position={[p.shoulderWidth * 0.86, shoulderY, 0]}
          radius={p.shoulderRadius}
          scale={jointScale}
        />

        <MannequinLimb
          articulationColor={articulationColor}
          color={mannequinColor}
          distalY={wristY}
          endY={handY}
          ik={leftArmIk}
          jointScale={jointScale}
          kind="arm"
          middleY={elbowY}
          originY={armOriginY}
          p={p}
          side="left"
        />
        <MannequinLimb
          articulationColor={articulationColor}
          color={mannequinColor}
          distalY={wristY}
          endY={handY}
          ik={rightArmIk}
          jointScale={jointScale}
          kind="arm"
          middleY={elbowY}
          originY={armOriginY}
          p={p}
          side="right"
        />
      </group>

      <Joint
        color={mannequinColor}
        position={[-p.legSpread, hipJointY, 0]}
        radius={p.thighRadius * 1.08}
        scale={jointScale}
      />
      <Joint
        color={mannequinColor}
        position={[p.legSpread, hipJointY, 0]}
        radius={p.thighRadius * 1.08}
        scale={jointScale}
      />

      <MannequinLimb
        articulationColor={articulationColor}
        color={mannequinColor}
        distalY={ankleY}
        endY={footY}
        ik={leftLegIk}
        jointScale={jointScale}
        kind="leg"
        middleY={kneeY}
        originY={legOriginY}
        p={p}
        side="left"
      />
      <MannequinLimb
        articulationColor={articulationColor}
        color={mannequinColor}
        distalY={ankleY}
        endY={footY}
        ik={rightLegIk}
        jointScale={jointScale}
        kind="leg"
        middleY={kneeY}
        originY={legOriginY}
        p={p}
        side="right"
      />
    </group>
  );
}
