import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Line, LineBasicMaterial, LineSegments } from "three";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import {
  createLightningBoltForkSegments,
  createLightningBoltPolyline,
  evaluateLightningState,
  LIGHTNING_BOLT_POINT_COUNT,
  LIGHTNING_FORK_MAX_COUNT,
  LIGHTNING_FORK_SEGMENTS,
} from "./lightning";

/**
 * Visible lightning channel for storm strikes.
 *
 * Two draws per strike: the bright near-white core polyline of the main
 * cloud-to-ground channel, and a dimmer bluish `LineSegments` pass with the
 * fork branches that die mid-air. Both geometries are pure functions of
 * `(seed, strikeWindowIndex)` and both opacities follow the deterministic
 * strike intensity, so a timeline scrub or export replays the identical
 * forked bolt at the identical moment.
 *
 * This is a transient weather overlay like the lightning flash lights: it
 * renders regardless of `drivesSky` while the weather preset is storm, and it
 * never touches the project's authored light list.
 */

/** Above clouds (4), well below precipitation (22). */
const LIGHTNING_BOLT_RENDER_ORDER = 6;

/** Fork branches flash dimmer than the core so the main channel dominates. */
export const LIGHTNING_FORK_OPACITY_RATIO = 0.55;

function createBoltLineMaterial(color: string): LineBasicMaterial {
  return new LineBasicMaterial({
    blending: AdditiveBlending,
    color,
    depthWrite: false,
    toneMapped: false,
    transparent: true,
  });
}

export interface SkyLightningBoltProps {
  context: LivingWorldFrameContext;
}

export default function SkyLightningBolt({ context }: SkyLightningBoltProps) {
  const { seed, settings } = context;
  const writtenWindowRef = useRef<number | null>(null);

  const bolt = useMemo(() => {
    const coreGeometry = new BufferGeometry();
    coreGeometry.setAttribute("position", new BufferAttribute(new Float32Array(LIGHTNING_BOLT_POINT_COUNT * 3), 3));
    const core = new Line(coreGeometry, createBoltLineMaterial("#f4f7ff"));
    core.name = "living-world-lightning-bolt";

    const forkGeometry = new BufferGeometry();
    forkGeometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array(LIGHTNING_FORK_MAX_COUNT * LIGHTNING_FORK_SEGMENTS * 2 * 3), 3),
    );
    const forks = new LineSegments(forkGeometry, createBoltLineMaterial("#c3d2ff"));
    forks.name = "living-world-lightning-forks";

    for (const line of [core, forks]) {
      line.frustumCulled = false;
      line.renderOrder = LIGHTNING_BOLT_RENDER_ORDER;
      line.visible = false;
      // Editor picking must never hit a transient flash.
      line.raycast = () => undefined;
    }
    return { core, forks };
  }, []);

  useEffect(
    () => () => {
      for (const line of [bolt.core, bolt.forks]) {
        line.geometry.dispose();
        (line.material as LineBasicMaterial).dispose();
      }
    },
    [bolt],
  );

  const syncBoltFrame = () => {
    const state = evaluateLightningState(seed, context.worldSeconds, settings.weather);
    if (!state.active || state.strikeWindowIndex === undefined) {
      bolt.core.visible = false;
      bolt.forks.visible = false;
      return;
    }
    if (writtenWindowRef.current !== state.strikeWindowIndex) {
      writtenWindowRef.current = state.strikeWindowIndex;
      const corePositions = bolt.core.geometry.getAttribute("position") as BufferAttribute;
      (corePositions.array as Float32Array).set(createLightningBoltPolyline(seed, state.strikeWindowIndex));
      corePositions.needsUpdate = true;

      const forkSegments = createLightningBoltForkSegments(seed, state.strikeWindowIndex);
      const forkPositions = bolt.forks.geometry.getAttribute("position") as BufferAttribute;
      (forkPositions.array as Float32Array).set(forkSegments);
      forkPositions.needsUpdate = true;
      bolt.forks.geometry.setDrawRange(0, forkSegments.length / 3);
    }
    bolt.core.visible = true;
    bolt.forks.visible = true;
    (bolt.core.material as LineBasicMaterial).opacity = state.intensity;
    (bolt.forks.material as LineBasicMaterial).opacity = state.intensity * LIGHTNING_FORK_OPACITY_RATIO;
  };

  // First paint before the frameloop starts (e.g. while scrubbing paused).
  useLayoutEffect(() => {
    syncBoltFrame();
  });
  useFrame(syncBoltFrame);

  return (
    <>
      <primitive object={bolt.core} />
      <primitive object={bolt.forks} />
    </>
  );
}
