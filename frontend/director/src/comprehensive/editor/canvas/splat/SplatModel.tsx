import { lazy } from "react";
import type { DirectorAssetRef, DirectorObject } from "../../schema/directorProject";

export interface DirectorSplatModelProps {
  /** Accepted for parity with mesh imports; splats carry no material slots to override. */
  assets?: DirectorAssetRef[];
  material?: DirectorObject["material"];
  /** Distinguishes single captures from `.4dgs.json` sequence manifests. */
  fileName: string;
  grounded?: boolean;
  modelNormalization?: "auto" | "preserve";
  realWorldSizeM?: number;
  url: string;
  onCenterChange?: (center: [number, number, number]) => void;
}

/**
 * The Spark gaussian splatting renderer (WASM sorter plus shader graph
 * runtime) stays out of the main bundle; it loads on the first splat asset
 * and suspends inside the same boundaries as the mesh loaders.
 */
export const SplatModel = lazy(() => import("./SplatModelImpl"));
