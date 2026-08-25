import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { AdditiveBlending, BufferAttribute, BufferGeometry, Line, LineBasicMaterial } from "three";
import type { LivingWorldFrameContext } from "../livingWorldContracts";
import { createLightningBoltPolyline, evaluateLightningState, LIGHTNING_BOLT_POINT_COUNT } from "./lightning";

/**
 * Visible lightning channel for storm strikes.
 *
 * A single polyline `Line` object tracks the active strike window: the jagged
 * channel geometry is a pure function of `(seed, strikeWindowIndex)` and the
 * flash opacity follows the deterministic strike intensity, so a timeline
 * scrub or export replays the identical bolt at the identical moment.
 *
 * This is a transient weather overlay like the lightning flash lights: it
 * renders regardless of `drivesSky` while the weather preset is storm, and it
 * never touches the project's authored light list.
 */

/** Above clouds (4), well below precipitation (22). */
const LIGHTNING_BOLT_RENDER_ORDER = 6;

export interface SkyLightningBoltProps {
  context: LivingWorldFrameContext;
}

export default function SkyLightningBolt({ context }: SkyLightningBoltProps) {
  const { seed, settings } = context;
  const writtenWindowRef = useRef<number | null>(null);

  const bolt = useMemo(() => {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(new Float32Array(LIGHTNING_BOLT_POINT_COUNT * 3), 3));
    const material = new LineBasicMaterial({
      blending: AdditiveBlending,
      color: "#e8eeff",
      depthWrite: false,
      toneMapped: false,
      transparent: true,
    });
    const line = new Line(geometry, material);
    line.name = "living-world-lightning-bolt";
    line.frustumCulled = false;
    line.renderOrder = LIGHTNING_BOLT_RENDER_ORDER;
    line.visible = false;
    // Editor picking must never hit a transient flash.
    line.raycast = () => undefined;
    return line;
  }, []);

  useEffect(
    () => () => {
      bolt.geometry.dispose();
      (bolt.material as LineBasicMaterial).dispose();
    },
    [bolt],
  );

  const syncBoltFrame = () => {
    const state = evaluateLightningState(seed, context.worldSeconds, settings.weather);
    if (!state.active || state.strikeWindowIndex === undefined) {
      bolt.visible = false;
      return;
    }
    if (writtenWindowRef.current !== state.strikeWindowIndex) {
      writtenWindowRef.current = state.strikeWindowIndex;
      const positions = bolt.geometry.getAttribute("position") as BufferAttribute;
      (positions.array as Float32Array).set(createLightningBoltPolyline(seed, state.strikeWindowIndex));
      positions.needsUpdate = true;
    }
    bolt.visible = true;
    (bolt.material as LineBasicMaterial).opacity = state.intensity;
  };

  // First paint before the frameloop starts (e.g. while scrubbing paused).
  useLayoutEffect(() => {
    syncBoltFrame();
  });
  useFrame(syncBoltFrame);

  return <primitive object={bolt} />;
}
