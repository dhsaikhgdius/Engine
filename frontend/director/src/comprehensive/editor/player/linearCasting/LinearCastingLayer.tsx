/**
 * @module LinearCastingLayer
 * @description R3F layer that drives the linear-casting skill runtime each frame,
 *   wiring pointer/pointerlock input, keyboard hotkeys, and camera shake into the
 *   casting system.
 */

import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Group, Vector2, Vector3 } from "three";
import {
  LINEAR_CASTING_CLEAR_CODE,
  LINEAR_CASTING_EDITOR_CODE,
  LINEAR_CASTING_ELEMENTS,
  LINEAR_CASTING_PAUSE_CODE,
  isLinearCastingHotkey,
  linearCastingSlotForCode,
  type LinearCastingElement,
} from "./linearCastingCatalog";
import { linearCastingPointerNdc } from "./linearCastingPointer";
import { LinearCastingRuntime } from "./linearCastingRuntime";
import { setLinearCastingHudRuntime } from "./linearCastingHudBridge";
import {
  getLinearCastingSession,
  subscribeLinearCastingSession,
  toggleLinearCastingPaused,
} from "./linearCastingSession";
import type { PlayerRuntimeStatusStore } from "../playerRuntimeStatusStore";

const _origin = new Vector3();
const _ndc = new Vector2();
const _shakeScratch = new Vector3();

export function LinearCastingLayer({
  enabled,
  groundHeight,
  origin,
  runtimeStatusStore,
}: {
  enabled: boolean;
  groundHeight: number;
  origin: readonly [number, number, number];
  runtimeStatusStore?: PlayerRuntimeStatusStore;
}) {
  const { camera, gl } = useThree();
  const root = useMemo(() => new Group(), []);
  const runtimeRef = useRef<LinearCastingRuntime | null>(null);
  const originRef = useRef(origin);
  const enabledRef = useRef(enabled);
  const groundHeightRef = useRef(groundHeight);
  const session = useSyncExternalStore(subscribeLinearCastingSession, getLinearCastingSession);
  const sessionEnabledRef = useRef(session.enabled);
  originRef.current = origin;
  enabledRef.current = enabled;
  groundHeightRef.current = groundHeight;
  sessionEnabledRef.current = session.enabled;

  useEffect(() => {
    const runtime = new LinearCastingRuntime(root, camera);
    runtime.setGroundHeight(groundHeightRef.current);
    runtimeRef.current = runtime;
    setLinearCastingHudRuntime(runtime);

    const canvas = gl.domElement;
    const castingActive = () => enabledRef.current && sessionEnabledRef.current;
    const pointerFromEvent = (event: PointerEvent) => {
      if (document.pointerLockElement === canvas) {
        _ndc.set(0, 0);
        return _ndc;
      }
      return linearCastingPointerNdc(event.clientX, event.clientY, canvas.getBoundingClientRect(), _ndc);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!castingActive()) return;
      runtime.aim.point(pointerFromEvent(event));
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!castingActive()) return;
      runtime.aim.point(pointerFromEvent(event));
      if (event.button === 2) {
        if (!runtime.aim.isArmed) return;
        event.preventDefault();
        event.stopPropagation();
        runtime.cancel();
        return;
      }
      if (event.button !== 0 || !runtime.aim.isArmed) return;
      event.preventDefault();
      event.stopPropagation();
      runtime.confirm();
    };
    const onContextMenu = (event: Event) => {
      if (!castingActive() || !runtime.aim.isArmed) return;
      event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!enabledRef.current) return;
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      if (event.code === "Escape") {
        if (!sessionEnabledRef.current || !runtime.aim.isArmed) return;
        event.preventDefault();
        event.stopPropagation();
        runtime.cancel();
        return;
      }
      if (!sessionEnabledRef.current || !isLinearCastingHotkey(event.code)) return;
      event.preventDefault();
      event.stopPropagation();
      const slot = linearCastingSlotForCode(event.code);
      if (slot !== null) {
        const element = LINEAR_CASTING_ELEMENTS[slot] as LinearCastingElement | undefined;
        if (element) runtime.toggleArm(element);
        return;
      }
      if (event.code === LINEAR_CASTING_CLEAR_CODE) runtime.clearEffects();
      if (event.code === LINEAR_CASTING_PAUSE_CODE) toggleLinearCastingPaused();
      if (event.code === LINEAR_CASTING_EDITOR_CODE) runtime.toggleEditor();
    };

    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerdown", onPointerDown, true);
    canvas.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown, true);
      setLinearCastingHudRuntime(null);
      runtime.dispose();
      runtimeRef.current = null;
    };
  }, [camera, gl, root]);

  useEffect(() => {
    runtimeRef.current?.setGroundHeight(groundHeight);
  }, [groundHeight]);

  useEffect(() => {
    if (!session.enabled) runtimeRef.current?.cancel();
  }, [session.enabled]);

  useFrame((state, delta) => {
    const runtime = runtimeRef.current;
    if (!runtime || !enabledRef.current) return;
    const [x, y, z] = runtimeStatusStore?.getSnapshot()?.playerPosition ?? originRef.current;
    _origin.set(x, y, z);
    runtime.update(Math.min(delta, 1 / 20), _origin, {
      camera: state.camera,
      gl: state.gl,
      paused: session.paused,
    });
    _shakeScratch.copy(runtime.shakeOffset);
    if (_shakeScratch.lengthSq() > 1e-8) state.camera.position.add(_shakeScratch);
  }, -2);

  return <primitive object={root} />;
}
