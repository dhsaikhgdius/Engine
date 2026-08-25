import { z } from "zod";

/** Supported aspect ratios for Director camera views. */
export const DIRECTOR_CAMERA_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "1.85:1", "2.39:1"] as const;

/** Zod schema for a Director camera aspect ratio. */
export const directorCameraAspectRatioSchema = z.enum(DIRECTOR_CAMERA_ASPECT_RATIOS);

/** Type alias for a Director camera aspect ratio value. */
export type DirectorCameraAspectRatio = z.infer<typeof directorCameraAspectRatioSchema>;
