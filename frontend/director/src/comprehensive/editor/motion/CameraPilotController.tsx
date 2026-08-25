/**
 * 掌镜模式控制器，管理自由飞行摄像机运动、目标锁定、射线检测和帧同步。
 *
 * @module camera-pilot-controller
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef, type MutableRefObject } from "react";
import {
  Euler,
  MathUtils,
  Matrix4,
  Object3D,
  PerspectiveCamera,
  Raycaster,
  Spherical,
  Vector2,
  Vector3,
  type Intersection,
} from "three";
import {
  getDirectorObjectBatchCount,
  getDirectorObjectBatchHitIndex,
  isDirectorObjectBatchMesh,
} from "../canvas/directorObjectBatch";
import type { CameraShotSnapshot } from "../store/directorStore";
import {
  DEFAULT_VIEWPORT_ROTATE_SENSITIVITY,
  DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
  normalizeViewportSensitivity,
} from "../schema/viewportNavigation";
import {
  getPilotLookIntent,
  getPilotMovementIntent,
  getPilotSpeedMultiplier,
  isEditablePilotEventTarget,
  isPilotLookCode,
  isPilotMovementCode,
  PILOT_LOOK_RADIANS_PER_SECOND,
} from "./pilotControls";
import {
  getCameraPilotBankTarget,
  getCameraPilotDampingAlpha,
  getCameraPilotInputResponse,
  getCameraPilotLookResponse,
} from "./cameraPilotMotion";

const PILOT_MOUSE_SENSITIVITY = 0.0022;
const PILOT_ORBIT_SPEED = 1.15;
const PILOT_MIN_FOV = 5;
const PILOT_MAX_FOV = 160;
const PILOT_WHEEL_FOV_SENSITIVITY = 0.006;
const PILOT_WHEEL_MAX_FOV_STEP = 0.6;
const PILOT_MAX_FRAME_DELTA = 0.05;
const PILOT_RAYCAST_INTERVAL_MS = 80;

/** 掌镜模式下的目标状态，包含悬停、锁定目标 ID 和锁定点。 */
export interface CameraPilotTargetState {
  hoveredTargetId: string | null;
  lockedTargetId: string | null;
  lockedPoint: [number, number, number] | null;
}

/** 掌镜模式下的录制记录，包含摄像机快照和可选的目标对象 ID。 */
export interface CameraPilotRecord {
  snapshot: CameraShotSnapshot;
  targetObjectId: string | null;
}

/** 根据旋转灵敏度计算掌镜模式的鼠标灵敏度系数。 */
export function getPilotMouseSensitivity(rotateSensitivity = DEFAULT_VIEWPORT_ROTATE_SENSITIVITY) {
  const normalized = normalizeViewportSensitivity(rotateSensitivity, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
  return PILOT_MOUSE_SENSITIVITY * (normalized / DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
}

/** 根据旋转灵敏度计算键盘视角旋转速度（弧度/秒）。 */
export function getPilotLookRadiansPerSecond(rotateSensitivity = DEFAULT_VIEWPORT_ROTATE_SENSITIVITY) {
  const normalized = normalizeViewportSensitivity(rotateSensitivity, DEFAULT_VIEWPORT_ROTATE_SENSITIVITY);
  return PILOT_LOOK_RADIANS_PER_SECOND * normalized;
}

/** 根据滚轮增量计算新的 FOV 值，受缩放灵敏度和范围限制。 */
export function getPilotFovAfterWheel(
  currentFov: number,
  deltaY: number,
  zoomSensitivity = DEFAULT_VIEWPORT_ZOOM_SENSITIVITY,
) {
  const normalized = normalizeViewportSensitivity(zoomSensitivity, DEFAULT_VIEWPORT_ZOOM_SENSITIVITY);
  const scale = normalized / DEFAULT_VIEWPORT_ZOOM_SENSITIVITY;
  const step = MathUtils.clamp(
    (Number.isFinite(deltaY) ? deltaY : 0) * PILOT_WHEEL_FOV_SENSITIVITY * scale,
    -PILOT_WHEEL_MAX_FOV_STEP * scale,
    PILOT_WHEEL_MAX_FOV_STEP * scale,
  );
  return MathUtils.clamp(currentFov + step, PILOT_MIN_FOV, PILOT_MAX_FOV);
}

function tuple(vector: Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z].map((value) => Number(value.toFixed(6))) as [number, number, number];
}

/**
 * 从掌镜射线交叉结果中提取 Director 对象 ID。
 * @param intersection - 射线交叉结果，包含 batchId、instanceId 和 object。
 * @returns Director 对象 ID 或 null。
 */
export function getDirectorObjectIdFromPilotIntersection(
  intersection: Pick<Intersection<Object3D>, "batchId" | "instanceId" | "object">,
) {
  const hitIndex = getDirectorObjectBatchHitIndex(intersection);
  let current: Object3D | null = intersection.object;
  while (current) {
    const instanceObjectIds = current.userData?.directorInstanceObjectIds;
    if (Array.isArray(instanceObjectIds) && hitIndex !== null) {
      const objectId = instanceObjectIds[hitIndex];
      if (typeof objectId === "string") return objectId;
    }
    if (typeof current.userData?.directorObjectId === "string") return current.userData.directorObjectId as string;
    current = current.parent;
  }
  return null;
}

function refreshDirectorObjectCache(scene: Object3D, objectById: Map<string, Object3D>, roots: Object3D[]) {
  objectById.clear();
  roots.length = 0;
  scene.updateMatrixWorld(true);
  const instanceMatrix = new Matrix4();
  const worldMatrix = new Matrix4();
  scene.traverse((object) => {
    const instanceObjectIds = object.userData?.directorInstanceObjectIds;
    if (Array.isArray(instanceObjectIds) && isDirectorObjectBatchMesh(object)) {
      roots.push(object);
      instanceObjectIds.slice(0, getDirectorObjectBatchCount(object)).forEach((objectId, index) => {
        if (typeof objectId !== "string" || objectById.has(objectId)) return;
        object.getMatrixAt(index, instanceMatrix);
        worldMatrix.multiplyMatrices(object.matrixWorld, instanceMatrix);
        const proxy = new Object3D();
        proxy.matrixAutoUpdate = false;
        proxy.matrix.copy(worldMatrix);
        proxy.userData.directorObjectId = objectId;
        objectById.set(objectId, proxy);
      });
      return;
    }
    const objectId = object.userData?.directorObjectId;
    if (typeof objectId !== "string" || objectById.has(objectId)) return;
    objectById.set(objectId, object);
    roots.push(object);
  });
}

/**
 * 掌镜模式控制器，处理键盘/鼠标输入、摄像机运动、目标锁定、射线检测和帧同步。
 * @param active - 是否激活掌镜模式。
 * @param bankStrength - 倾斜强度。
 * @param inertia - 输入惯性。
 * @param lookSmoothing - 视角平滑度。
 * @param moveSpeed - 移动速度。
 * @param objectKey - 用于触发对象缓存的刷新键。
 * @param onControlActiveChange - 控制激活状态变化回调。
 * @param onExit - 退出掌镜模式回调。
 * @param onRecord - 录制轨迹点回调。
 * @param onTargetStateChange - 目标状态变化回调。
 * @param rotateSensitivity - 旋转灵敏度。
 * @param snapshotRef - 摄像机快照的可变引用。
 * @param zoomSensitivity - 缩放灵敏度。
 */
export function CameraPilotController({
  active,
  bankStrength,
  inertia,
  lookSmoothing,
  moveSpeed,
  objectKey,
  onControlActiveChange,
  onExit,
  onRecord,
  onTargetStateChange,
  rotateSensitivity,
  snapshotRef,
  zoomSensitivity,
}: {
  active: boolean;
  bankStrength: number;
  inertia: number;
  lookSmoothing: number;
  moveSpeed: number;
  objectKey: string;
  onControlActiveChange?: (active: boolean) => void;
  onExit: () => void;
  onRecord: (record: CameraPilotRecord) => void;
  onTargetStateChange: (state: CameraPilotTargetState) => void;
  rotateSensitivity: number;
  snapshotRef: MutableRefObject<CameraShotSnapshot>;
  zoomSensitivity: number;
}) {
  const { camera, gl, scene } = useThree();
  const pressedCodesRef = useRef(new Set<string>());
  const orientationRef = useRef(new Euler(0, 0, 0, "YXZ"));
  const targetOrientationRef = useRef(new Euler(0, 0, 0, "YXZ"));
  const pendingLockedMouseRef = useRef({ x: 0, y: 0 });
  const smoothedInputRef = useRef(new Vector3());
  const rawInputRef = useRef(new Vector3());
  const pilotBankRef = useRef(0);
  const previousYawRef = useRef(0);
  const focusDistanceRef = useRef(6);
  const raycasterRef = useRef(new Raycaster());
  const screenCenterRef = useRef(new Vector2(0, 0));
  const objectByIdRef = useRef(new Map<string, Object3D>());
  const trackableRootsRef = useRef<Object3D[]>([]);
  const lastRaycastAtRef = useRef(0);
  const hoveredTargetIdRef = useRef<string | null>(null);
  const lockedTargetIdRef = useRef<string | null>(null);
  const lockedPointRef = useRef<[number, number, number] | null>(null);
  const lockedTargetObjectRef = useRef<Object3D | null>(null);
  const targetRef = useRef(new Vector3());
  const orbitOffsetRef = useRef(new Vector3());
  const sphericalOffsetRef = useRef(new Vector3());
  const forwardRef = useRef(new Vector3());
  const rightRef = useRef(new Vector3());
  const sphericalRef = useRef(new Spherical());
  const onExitRef = useRef(onExit);
  const onControlActiveChangeRef = useRef(onControlActiveChange);
  const onRecordRef = useRef(onRecord);
  const onTargetStateChangeRef = useRef(onTargetStateChange);
  const mouseSensitivity = getPilotMouseSensitivity(rotateSensitivity);

  const emitTargetState = () =>
    onTargetStateChangeRef.current({
      hoveredTargetId: hoveredTargetIdRef.current,
      lockedTargetId: lockedTargetIdRef.current,
      lockedPoint: lockedPointRef.current ? [...lockedPointRef.current] : null,
    });

  useEffect(() => {
    onExitRef.current = onExit;
    onControlActiveChangeRef.current = onControlActiveChange;
    onRecordRef.current = onRecord;
    onTargetStateChangeRef.current = onTargetStateChange;
  }, [onControlActiveChange, onExit, onRecord, onTargetStateChange]);

  useEffect(() => {
    if (!active) return;
    refreshDirectorObjectCache(scene, objectByIdRef.current, trackableRootsRef.current);
  }, [active, objectKey, scene]);

  useEffect(() => {
    if (!active) {
      pressedCodesRef.current.clear();
      return;
    }

    const pilotCamera = camera as PerspectiveCamera;
    const pressedCodes = pressedCodesRef.current;
    pilotCamera.position.set(...snapshotRef.current.position);
    pilotCamera.fov = snapshotRef.current.fov;
    pilotCamera.lookAt(...snapshotRef.current.target);
    pilotCamera.updateProjectionMatrix();
    pilotCamera.updateMatrixWorld();
    orientationRef.current.setFromQuaternion(pilotCamera.quaternion, "YXZ");
    targetOrientationRef.current.copy(orientationRef.current);
    previousYawRef.current = orientationRef.current.y;
    pilotBankRef.current = 0;
    smoothedInputRef.current.set(0, 0, 0);
    rawInputRef.current.set(0, 0, 0);
    focusDistanceRef.current = Math.max(
      0.5,
      new Vector3(...snapshotRef.current.position).distanceTo(new Vector3(...snapshotRef.current.target)),
    );
    refreshDirectorObjectCache(scene, objectByIdRef.current, trackableRootsRef.current);

    const canvas = gl.domElement;
    const canUseCanvasEvents = typeof HTMLElement !== "undefined" && canvas instanceof HTMLElement;
    const originalTabIndex = canUseCanvasEvents ? canvas.getAttribute("tabindex") : null;
    const originalCursor = canUseCanvasEvents ? canvas.style.cursor : "";
    if (canUseCanvasEvents && canvas.tabIndex < 0) canvas.tabIndex = 0;
    let controlActive = false;
    let dragPointerId: number | null = null;
    let pointerX = 0;
    let pointerY = 0;

    const hasActiveControl = () => canUseCanvasEvents && controlActive && document.activeElement === canvas;
    const notifyControlActive = () => onControlActiveChangeRef.current?.(hasActiveControl());
    const endDrag = () => {
      if (dragPointerId !== null && canvas.hasPointerCapture?.(dragPointerId)) {
        canvas.releasePointerCapture(dragPointerId);
      }
      dragPointerId = null;
      canvas.style.cursor = originalCursor;
    };
    const clear = () => {
      pressedCodes.clear();
      smoothedInputRef.current.set(0, 0, 0);
    };
    const deactivateControl = () => {
      controlActive = false;
      endDrag();
      clear();
      notifyControlActive();
    };
    notifyControlActive();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditablePilotEventTarget(event.target)) return;
      if (event.code === "Escape") {
        event.preventDefault();
        onExitRef.current();
        return;
      }
      if (!hasActiveControl()) return;
      if (isPilotMovementCode(event.code) || isPilotLookCode(event.code)) {
        event.preventDefault();
        pressedCodes.add(event.code);
        return;
      }
      if (event.repeat) return;
      if (event.code === "KeyF") {
        event.preventDefault();
        if (lockedTargetIdRef.current || lockedPointRef.current) {
          lockedTargetIdRef.current = null;
          lockedPointRef.current = null;
          lockedTargetObjectRef.current = null;
          orientationRef.current.setFromQuaternion(pilotCamera.quaternion, "YXZ");
          targetOrientationRef.current.copy(orientationRef.current);
          emitTargetState();
          return;
        }
        const nextLockedId = hoveredTargetIdRef.current;
        if (nextLockedId) {
          lockedTargetIdRef.current = nextLockedId;
          lockedTargetObjectRef.current = objectByIdRef.current.get(nextLockedId) ?? null;
        } else {
          const direction = forwardRef.current.set(0, 0, -1).applyQuaternion(pilotCamera.quaternion).normalize();
          lockedPointRef.current = tuple(
            targetRef.current.copy(pilotCamera.position).addScaledVector(direction, focusDistanceRef.current),
          );
        }
        emitTargetState();
        return;
      }
      if (event.code === "Enter") {
        event.preventDefault();
        onRecordRef.current({
          snapshot: {
            fov: snapshotRef.current.fov,
            position: [...snapshotRef.current.position],
            target: [...snapshotRef.current.target],
          },
          targetObjectId: lockedTargetIdRef.current,
        });
        return;
      }
    };
    const handleKeyUp = (event: KeyboardEvent) => pressedCodes.delete(event.code);
    const applyLookDelta = (movementX: number, movementY: number) => {
      if (lockedTargetIdRef.current || lockedPointRef.current) {
        pendingLockedMouseRef.current.x += movementX;
        pendingLockedMouseRef.current.y += movementY;
        return;
      }
      targetOrientationRef.current.y -= movementX * mouseSensitivity;
      targetOrientationRef.current.x = MathUtils.clamp(
        targetOrientationRef.current.x - movementY * mouseSensitivity,
        -Math.PI / 2 + 0.025,
        Math.PI / 2 - 0.025,
      );
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!controlActive || dragPointerId !== event.pointerId || (event.buttons & 1) === 0) return;
      event.preventDefault();
      applyLookDelta(event.clientX - pointerX, event.clientY - pointerY);
      pointerX = event.clientX;
      pointerY = event.clientY;
    };
    const handleWheel = (event: WheelEvent) => {
      if (!hasActiveControl()) return;
      event.preventDefault();
      pilotCamera.fov = getPilotFovAfterWheel(pilotCamera.fov, event.deltaY, zoomSensitivity);
      pilotCamera.updateProjectionMatrix();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (!canUseCanvasEvents || event.button !== 0) return;
      event.preventDefault();
      canvas.focus?.({ preventScroll: true });
      controlActive = true;
      dragPointerId = event.pointerId;
      pointerX = event.clientX;
      pointerY = event.clientY;
      canvas.style.cursor = "none";
      canvas.setPointerCapture?.(event.pointerId);
      notifyControlActive();
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (dragPointerId !== event.pointerId) return;
      endDrag();
    };
    const handleCanvasBlur = () => deactivateControl();
    const handleDocumentPointerDown = (event: PointerEvent) => {
      if (!controlActive || event.composedPath().includes(canvas)) return;
      deactivateControl();
    };
    const handleWindowBlur = () => deactivateControl();
    const handleVisibilityChange = () => {
      if (!document.hidden) return;
      deactivateControl();
    };

    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
    document.addEventListener("pointerdown", handleDocumentPointerDown, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (canUseCanvasEvents) {
      canvas.addEventListener("pointerdown", handlePointerDown);
      canvas.addEventListener("pointermove", handlePointerMove);
      canvas.addEventListener("pointerup", handlePointerEnd);
      canvas.addEventListener("pointercancel", handlePointerEnd);
      canvas.addEventListener("blur", handleCanvasBlur);
      canvas.addEventListener("wheel", handleWheel, { passive: false });
    }
    return () => {
      clear();
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("keyup", handleKeyUp, true);
      window.removeEventListener("blur", handleWindowBlur);
      document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (canUseCanvasEvents) {
        canvas.removeEventListener("pointerdown", handlePointerDown);
        canvas.removeEventListener("pointermove", handlePointerMove);
        canvas.removeEventListener("pointerup", handlePointerEnd);
        canvas.removeEventListener("pointercancel", handlePointerEnd);
        canvas.removeEventListener("blur", handleCanvasBlur);
        canvas.removeEventListener("wheel", handleWheel);
        endDrag();
        if (originalTabIndex === null) canvas.removeAttribute("tabindex");
        else canvas.setAttribute("tabindex", originalTabIndex);
      }
      onControlActiveChangeRef.current?.(false);
    };
  }, [active, camera, gl.domElement, mouseSensitivity, scene, snapshotRef, zoomSensitivity]);

  useFrame((_state, delta) => {
    if (!active) return;
    const pilotCamera = camera as PerspectiveCamera;
    const intent = getPilotMovementIntent(pressedCodesRef.current);
    const look = getPilotLookIntent(pressedCodesRef.current);
    const target = targetRef.current;
    const frameDelta = Math.min(Math.max(delta, 0), PILOT_MAX_FRAME_DELTA);
    const lookRate = getPilotLookRadiansPerSecond(rotateSensitivity) * frameDelta;
    const rawInput = rawInputRef.current.set(intent.strafe, intent.vertical, intent.forward);
    const horizontalLength = Math.hypot(rawInput.x, rawInput.z);
    if (horizontalLength > 1) {
      rawInput.x /= horizontalLength;
      rawInput.z /= horizontalLength;
    }
    const inputResponse = getCameraPilotInputResponse(inertia, rawInput.lengthSq() > 0.0001);
    const smoothedInput = smoothedInputRef.current.lerp(
      rawInput,
      getCameraPilotDampingAlpha(inputResponse, frameDelta),
    );
    const speedMultiplier = getPilotSpeedMultiplier(pressedCodesRef.current);

    let hasLockedFocus = false;
    if (lockedTargetIdRef.current) {
      const targetObject =
        lockedTargetObjectRef.current ?? objectByIdRef.current.get(lockedTargetIdRef.current) ?? null;
      if (targetObject) {
        lockedTargetObjectRef.current = targetObject;
        targetObject.getWorldPosition(target);
        hasLockedFocus = true;
      } else {
        lockedTargetIdRef.current = null;
        emitTargetState();
      }
    } else if (lockedPointRef.current) {
      target.set(...lockedPointRef.current);
      hasLockedFocus = true;
    }

    if (hasLockedFocus) {
      const spherical = sphericalRef.current.setFromVector3(
        orbitOffsetRef.current.copy(pilotCamera.position).sub(target),
      );
      if (spherical.radius < 0.1) spherical.radius = 1;
      spherical.theta -= smoothedInput.x * PILOT_ORBIT_SPEED * speedMultiplier * frameDelta;
      spherical.theta -= look.yaw * lookRate;
      spherical.theta -= pendingLockedMouseRef.current.x * mouseSensitivity;
      spherical.phi = MathUtils.clamp(
        spherical.phi + look.pitchDown * lookRate + pendingLockedMouseRef.current.y * mouseSensitivity,
        0.08,
        Math.PI - 0.08,
      );
      spherical.radius = Math.max(0.35, spherical.radius - smoothedInput.z * moveSpeed * speedMultiplier * frameDelta);
      pendingLockedMouseRef.current.x = 0;
      pendingLockedMouseRef.current.y = 0;
      pilotCamera.position.copy(target).add(sphericalOffsetRef.current.setFromSpherical(spherical));
      pilotCamera.position.y += smoothedInput.y * moveSpeed * speedMultiplier * frameDelta;
      pilotCamera.lookAt(target);
    } else {
      if (look.yaw !== 0 || look.pitchDown !== 0) {
        targetOrientationRef.current.y -= look.yaw * lookRate;
        targetOrientationRef.current.x = MathUtils.clamp(
          targetOrientationRef.current.x - look.pitchDown * lookRate,
          -Math.PI / 2 + 0.025,
          Math.PI / 2 - 0.025,
        );
      }
      const lookResponse = getCameraPilotLookResponse(lookSmoothing);
      orientationRef.current.x = MathUtils.damp(
        orientationRef.current.x,
        targetOrientationRef.current.x,
        lookResponse,
        frameDelta,
      );
      orientationRef.current.y = MathUtils.damp(
        orientationRef.current.y,
        targetOrientationRef.current.y,
        lookResponse,
        frameDelta,
      );
      pilotCamera.quaternion.setFromEuler(orientationRef.current);
      const forward = forwardRef.current.set(0, 0, -1).applyQuaternion(pilotCamera.quaternion).normalize();
      const right = rightRef.current.set(1, 0, 0).applyQuaternion(pilotCamera.quaternion).normalize();
      pilotCamera.position.addScaledVector(forward, smoothedInput.z * moveSpeed * speedMultiplier * frameDelta);
      pilotCamera.position.addScaledVector(right, smoothedInput.x * moveSpeed * speedMultiplier * frameDelta);
      pilotCamera.position.y += smoothedInput.y * moveSpeed * speedMultiplier * frameDelta;
      target.copy(pilotCamera.position).addScaledVector(forward, focusDistanceRef.current);
    }
    const yawVelocity = hasLockedFocus
      ? 0
      : (orientationRef.current.y - previousYawRef.current) / Math.max(frameDelta, 0.0001);
    previousYawRef.current = orientationRef.current.y;
    pilotBankRef.current = MathUtils.damp(
      pilotBankRef.current,
      getCameraPilotBankTarget({ bankStrength, strafe: smoothedInput.x, yawVelocity }),
      10,
      frameDelta,
    );
    pilotCamera.rotateZ(pilotBankRef.current);
    pilotCamera.updateMatrixWorld();

    const now = typeof performance === "undefined" ? Date.now() : performance.now();
    if (now - lastRaycastAtRef.current >= PILOT_RAYCAST_INTERVAL_MS) {
      lastRaycastAtRef.current = now;
      raycasterRef.current.setFromCamera(screenCenterRef.current, pilotCamera);
      const intersections = raycasterRef.current.intersectObjects(trackableRootsRef.current, true);
      let hoveredId: string | null = null;
      for (const intersection of intersections) {
        hoveredId = getDirectorObjectIdFromPilotIntersection(intersection);
        if (hoveredId) break;
      }
      if (hoveredId !== hoveredTargetIdRef.current) {
        hoveredTargetIdRef.current = hoveredId;
        emitTargetState();
      }
    }

    snapshotRef.current = {
      fov: Number(pilotCamera.fov.toFixed(3)),
      position: tuple(pilotCamera.position),
      target: tuple(target),
    };
  });

  return null;
}
