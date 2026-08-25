import type { DirectorProject } from "@director/project-schema";

/** Minimal valid project fixture that stays independent from Zustand and browser persistence. */
export function createTestDirectorProject(): DirectorProject {
  return {
    version: 1,
    scene: {
      scale: 1,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      backgroundColor: "#182033",
      panoramaYaw: 0,
      panoramaRadius: 60,
      showLabels: true,
      snapToGrid: false,
      showGround: true,
      groundOpacity: 0.9,
      groundHeight: 0,
    },
    assets: [],
    objects: [],
    cameras: [],
    activeCameraId: null,
    panoramaAssetId: null,
  };
}
