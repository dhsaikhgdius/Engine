import { Html, TransformControls } from "@react-three/drei";
import { createPortal, useFrame, useThree } from "@react-three/fiber";
import { useCallback, useMemo, useRef, useState, type RefObject } from "react";
import { Euler, Quaternion, Vector3, type Group, type Object3D } from "three";
import { useLanguage } from "../../i18n/language";
import { resolveCharacterPoseControls } from "../presets/mannequinPosePresets";
import { getDefaultCharacterIkTarget } from "../runtime/mannequin/characterIk";
import type { DirectorCharacterIkTarget, DirectorObject } from "../schema/directorProject";
import { useDirectorStore } from "../store/directorStore";
import { useRafCoalescedTransformInteraction } from "../runtime/useRafCoalescedTransformInteraction";
import { useCharacterPoseEditorStore } from "./characterPoseEditorStore";
import { getCharacterPoseControlsFromJointRotationDelta, type CharacterPoseJointId } from "./characterPoseJoints";
import {
  resolveCharacterPoseRigBinding,
  type CharacterPoseJointNode,
  type CharacterPoseRigBinding,
} from "./characterPoseJointProbe";

const HIDE_FROM_VIEWPORT_CAPTURE_KEY = "hideFromViewportCapture";
const POSE_LINK_RADIUS_M = 0.006;
const Y_AXIS = new Vector3(0, 1, 0);

const POSE_JOINT_LINKS: ReadonlyArray<readonly [CharacterPoseJointId, CharacterPoseJointId]> = [
  ["body", "torso"],
  ["torso", "head"],
  ["torso", "leftShoulder"],
  ["leftShoulder", "leftElbow"],
  ["leftElbow", "leftHand"],
  ["torso", "rightShoulder"],
  ["rightShoulder", "rightElbow"],
  ["rightElbow", "rightHand"],
  ["body", "leftHip"],
  ["leftHip", "leftKnee"],
  ["leftKnee", "leftFoot"],
  ["body", "rightHip"],
  ["rightHip", "rightKnee"],
  ["rightKnee", "rightFoot"],
];

function PoseJointLink({ from, to }: { from: Object3D; to: Object3D }) {
  const ref = useRef<Group>(null!);
  const scratch = useMemo(
    () => ({ from: new Vector3(), to: new Vector3(), direction: new Vector3(), quaternion: new Quaternion() }),
    [],
  );

  useFrame(() => {
    const link = ref.current;
    if (!link) return;
    from.getWorldPosition(scratch.from);
    to.getWorldPosition(scratch.to);
    scratch.direction.subVectors(scratch.to, scratch.from);
    const length = scratch.direction.length();
    if (length < 0.0001) {
      link.visible = false;
      return;
    }
    link.visible = true;
    link.position.copy(scratch.from).addScaledVector(scratch.direction, 0.5);
    scratch.direction.multiplyScalar(1 / length);
    link.quaternion.copy(scratch.quaternion.setFromUnitVectors(Y_AXIS, scratch.direction));
    link.scale.set(1, length, 1);
  });

  return (
    <group ref={ref} userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}>
      <mesh renderOrder={998}>
        <cylinderGeometry args={[POSE_LINK_RADIUS_M, POSE_LINK_RADIUS_M, 1, 8]} />
        <meshBasicMaterial color="#29d6ff" depthTest={false} opacity={0.32} transparent />
      </mesh>
    </group>
  );
}

function PoseJointHandle({ active, node }: { active: boolean; node: CharacterPoseJointNode }) {
  const { t } = useLanguage();
  const ref = useRef<Group>(null!);
  const position = useMemo(() => new Vector3(), []);
  const selectJoint = useCharacterPoseEditorStore((state) => state.selectJoint);

  useFrame(() => {
    if (!ref.current) return;
    node.anchor.getWorldPosition(position);
    ref.current.position.copy(position);
  });

  return (
    <group ref={ref} userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}>
      <Html center zIndexRange={[12, 2]}>
        <button
          aria-label={`${t("选择关节")}：${t(node.joint.label)}`}
          aria-pressed={active}
          className={`character-pose-handle is-${node.joint.side}${active ? " is-active" : ""}`}
          onClick={(event) => {
            event.stopPropagation();
            selectJoint(node.joint.id);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          <span aria-hidden="true" className="character-pose-handle-dot" />
          {active ? <span className="character-pose-handle-label">{t(node.joint.label)}</span> : null}
        </button>
      </Html>
    </group>
  );
}

function roundIkPoint(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(4))) as [number, number, number];
}

function PoseJointTransformGizmo({
  binding,
  item,
  node,
}: {
  binding: CharacterPoseRigBinding;
  item: DirectorObject;
  node: CharacterPoseJointNode;
}) {
  const targetRef = useRef<Group>(null!);
  const draggingRef = useRef(false);
  const startQuaternionRef = useRef(new Quaternion());
  const baseControlsRef = useRef<Record<string, number>>({});
  const baseIkTargetRef = useRef<DirectorCharacterIkTarget | null>(null);
  const scratch = useMemo(
    () => ({
      worldPosition: new Vector3(),
      worldQuaternion: new Quaternion(),
      deltaQuaternion: new Quaternion(),
      deltaEuler: new Euler(0, 0, 0, "XYZ"),
      localPosition: new Vector3(),
    }),
    [],
  );
  const mode = node.joint.ikEffector ? "translate" : "rotate";
  const canEdit = mode === "translate" ? Boolean(binding.ikSpaceRoot) : Boolean(node.rotationNode);

  useFrame(() => {
    const target = targetRef.current;
    if (!target || draggingRef.current) return;
    node.anchor.getWorldPosition(scratch.worldPosition);
    target.position.copy(scratch.worldPosition);
    if (mode === "rotate" && node.rotationNode) {
      node.rotationNode.getWorldQuaternion(scratch.worldQuaternion);
      target.quaternion.copy(scratch.worldQuaternion);
    } else {
      target.quaternion.identity();
    }
  });

  const handleObjectChange = useCallback(() => {
    const target = targetRef.current;
    if (!target || !canEdit) return;
    const store = useDirectorStore.getState();

    if (mode === "translate" && node.joint.ikEffector && binding.ikSpaceRoot) {
      binding.ikSpaceRoot.updateWorldMatrix(true, false);
      scratch.localPosition.copy(target.position);
      binding.ikSpaceRoot.worldToLocal(scratch.localPosition);
      const base = baseIkTargetRef.current ?? getDefaultCharacterIkTarget(item.bodyType, node.joint.ikEffector);
      store.setCharacterIkEffector(item.id, node.joint.ikEffector, {
        ...base,
        target: roundIkPoint(scratch.localPosition),
        weight: 1,
      });
      return;
    }

    if (!node.rotationNode) return;
    scratch.deltaQuaternion.copy(startQuaternionRef.current).invert().multiply(target.quaternion).normalize();
    scratch.deltaEuler.setFromQuaternion(scratch.deltaQuaternion, "XYZ");
    const controls = getCharacterPoseControlsFromJointRotationDelta({
      baseControls: baseControlsRef.current,
      bodyType: item.bodyType,
      delta: [scratch.deltaEuler.x, scratch.deltaEuler.y, scratch.deltaEuler.z],
      jointId: node.joint.id,
      skeletonBacked: Boolean(binding.skeletonRoot),
    });
    Object.entries(controls).forEach(([key, value]) => {
      if (value !== undefined) store.updatePoseControl(item.id, key, Number(value.toFixed(3)));
    });
  }, [binding.ikSpaceRoot, binding.skeletonRoot, canEdit, item.bodyType, item.id, mode, node, scratch]);
  const transformInteraction = useRafCoalescedTransformInteraction(handleObjectChange);

  if (!canEdit) return null;

  return (
    <>
      <group
        ref={targetRef}
        name="character-pose-control-target"
        userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
      />
      <TransformControls
        ref={(controls) => {
          if (controls) controls.userData[HIDE_FROM_VIEWPORT_CAPTURE_KEY] = true;
        }}
        mode={mode}
        object={targetRef}
        onMouseDown={() => {
          const target = targetRef.current;
          if (!target) return;
          draggingRef.current = true;
          startQuaternionRef.current.copy(target.quaternion);
          baseControlsRef.current = { ...resolveCharacterPoseControls(item.characterRig) };
          if (node.joint.ikEffector) {
            baseIkTargetRef.current = {
              ...(item.characterRig?.ik?.[node.joint.ikEffector] ??
                getDefaultCharacterIkTarget(item.bodyType, node.joint.ikEffector)),
            };
          }
          transformInteraction.onMouseDown();
        }}
        onMouseUp={() => {
          transformInteraction.onMouseUp();
          draggingRef.current = false;
        }}
        onObjectChange={transformInteraction.onObjectChange}
        rotationSnap={mode === "rotate" ? Math.PI / 180 : undefined}
        size={0.72}
        space={mode === "rotate" ? "local" : "world"}
        translationSnap={mode === "translate" ? 0.01 : undefined}
        userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}
      />
    </>
  );
}

/** Viewport joint handles and the active rotation/IK gizmo for one selected character. */
export function CharacterPoseViewportRig({ item, rootRef }: { item: DirectorObject; rootRef: RefObject<Group> }) {
  const viewportScene = useThree((state) => state.scene);
  const activeJointId = useCharacterPoseEditorStore((state) => state.jointId);
  const [binding, setBinding] = useState<CharacterPoseRigBinding | null>(null);

  useFrame(() => {
    const characterRoot = rootRef.current;
    if (!characterRoot) return;
    const currentAnchor = binding?.joints[0]?.anchor;
    const bindingIsLive = currentAnchor
      ? characterRoot.getObjectByProperty("uuid", currentAnchor.uuid) === currentAnchor
      : false;
    if (bindingIsLive) return;
    const next = resolveCharacterPoseRigBinding(characterRoot);
    if (next.joints.length) setBinding(next);
  });

  const jointsById = useMemo(() => new Map(binding?.joints.map((joint) => [joint.joint.id, joint]) ?? []), [binding]);
  const activeJoint = jointsById.get(activeJointId) ?? binding?.joints[0] ?? null;

  if (!binding || !activeJoint) return null;

  return createPortal(
    <group name={`character-pose-rig-${item.id}`} userData={{ [HIDE_FROM_VIEWPORT_CAPTURE_KEY]: true }}>
      {POSE_JOINT_LINKS.flatMap(([fromId, toId]) => {
        const from = jointsById.get(fromId)?.anchor;
        const to = jointsById.get(toId)?.anchor;
        return from && to ? [<PoseJointLink key={`${fromId}:${toId}`} from={from} to={to} />] : [];
      })}
      {binding.joints.map((node) => (
        <PoseJointHandle active={node.joint.id === activeJoint.joint.id} key={node.joint.id} node={node} />
      ))}
      <PoseJointTransformGizmo
        key={`${activeJoint.joint.id}:${activeJoint.joint.ikEffector ? "translate" : "rotate"}`}
        binding={binding}
        item={item}
        node={activeJoint}
      />
    </group>,
    viewportScene,
  );
}
