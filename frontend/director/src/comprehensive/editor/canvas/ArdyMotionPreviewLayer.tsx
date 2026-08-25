import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { Object3D } from "three";
import { useArdyMotionPreviewStore } from "../motion/ardy/ardyMotionPreviewStore";
import {
  applyArdyMotionFrame,
  prepareArdyRigBinding,
  restoreArdyRigBinding,
  type ArdyRigBinding,
} from "../motion/ardy/ardyRigPlayback";
import type { ArdyMotionClip } from "../motion/ardy/ardyNpz";

/**
 * Canvas overlay that plays the active ARDY motion preview on its target
 * character. It registers its frame callback only while a preview runs, so it
 * is subscribed after the character's own samplers and its bone writes win
 * the frame. Stopping (or unmounting) restores the snapshot taken when the
 * binding was prepared.
 */
export function ArdyMotionPreviewLayer() {
  const objectId = useArdyMotionPreviewStore((state) => state.objectId);
  const clip = useArdyMotionPreviewStore((state) => state.clip);
  const session = useArdyMotionPreviewStore((state) => state.session);
  const playing = useArdyMotionPreviewStore((state) => state.playing);
  if (!playing || !objectId || !clip) return null;
  return <ActiveArdyMotionPreview key={`${objectId}:${session}`} clip={clip} objectId={objectId} />;
}

function ActiveArdyMotionPreview({ clip, objectId }: { clip: ArdyMotionClip; objectId: string }) {
  const scene = useThree((state) => state.scene);
  const bindingRef = useRef<ArdyRigBinding | null>(null);
  const characterRootRef = useRef<Object3D | null>(null);
  const elapsedRef = useRef(0);

  useEffect(
    () => () => {
      if (bindingRef.current) restoreArdyRigBinding(bindingRef.current);
      bindingRef.current = null;
    },
    [clip, objectId],
  );

  useFrame((state, delta) => {
    let binding = bindingRef.current;
    // (Re)bind when the preview starts or the character remounts (asset
    // reloads swap the whole subtree; the stale binding then points at
    // detached bones).
    if (!binding || characterRootRef.current?.parent === null || !bindingStillMounted(binding)) {
      const root = scene.getObjectByName(`director-object-${objectId}`) ?? null;
      characterRootRef.current = root;
      binding = root ? prepareArdyRigBinding(root) : null;
      bindingRef.current = binding;
      if (!binding) {
        useArdyMotionPreviewStore.getState().stopPreview();
        return;
      }
      elapsedRef.current = 0;
    }
    elapsedRef.current += Math.max(0, delta);
    const totalFrames = Math.max(1, clip.frames);
    const frame = Math.floor(elapsedRef.current * clip.fps) % totalFrames;
    applyArdyMotionFrame(binding, clip, frame);
    state.invalidate();
  });

  return null;
}

/** The hips bone must still hang under the bound character root. */
function bindingStillMounted(binding: ArdyRigBinding) {
  const hips = binding.bones.find((bone) => bone !== null);
  for (let node: Object3D | null = hips ?? null; node; node = node.parent) {
    if (node === binding.root) return true;
  }
  return false;
}
