import { useEffect, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import { Plane, Vector3 } from "three";
import type { DirectorClippingPlane } from "../schema/directorProject";

export function createDirectorClippingPlaneInstances(planes: readonly DirectorClippingPlane[]) {
  return planes
    .filter((plane) => plane.enabled)
    .map((plane) => new Plane(new Vector3(...plane.normal), plane.constant).normalize());
}

/** Applies bounded project-native clipping planes to every Stage material. */
export function DirectorClippingPlanes({ planes }: { planes: readonly DirectorClippingPlane[] }) {
  const { gl, invalidate } = useThree();
  const activePlanes = useMemo(() => createDirectorClippingPlaneInstances(planes), [planes]);

  useEffect(() => {
    gl.clippingPlanes = activePlanes;
    gl.localClippingEnabled = activePlanes.length > 0;
    invalidate();
    return () => {
      if (gl.clippingPlanes === activePlanes) {
        gl.clippingPlanes = [];
        gl.localClippingEnabled = false;
        invalidate();
      }
    };
  }, [activePlanes, gl, invalidate]);

  return null;
}
