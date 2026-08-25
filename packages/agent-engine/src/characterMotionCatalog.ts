import { z } from "zod";
import motionCatalogJson from "../../../assets/library/mixamo-animations/catalog.json";
import {
  DIRECTOR_CHARACTER_MOTION_LOOPS,
  DIRECTOR_CHARACTER_ROOT_MOTION_MODES,
  type DirectorCharacterMotionState,
  type DirectorEntityAnimation,
} from "@director/project-schema";

const localClipUrl = z
  .string()
  .regex(/^\/mixamo-animations\/clips\/[a-z0-9-]+\.glb$/, "motion clip must use the packaged local asset root");

export const directorCharacterMotionCatalogItemSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  nameZh: z.string().min(1),
  category: z.enum(["idle", "locomotion", "gesture", "action", "performance"]),
  tags: z.array(z.string().min(1)).min(1),
  url: localClipUrl,
  fileName: z.string().regex(/^[a-z0-9-]+\.glb$/),
  defaultLoop: z.enum(DIRECTOR_CHARACTER_MOTION_LOOPS),
  recommendedRootMotion: z.enum(DIRECTOR_CHARACTER_ROOT_MOTION_MODES),
  durationS: z.number().finite().positive(),
  frameCount: z.number().int().positive(),
  sourceFps: z.number().finite().positive(),
  byteLength: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  source: z.strictObject({
    provider: z.literal("Adobe Mixamo"),
    fileName: z.string().min(1),
    licenseUrl: z.url(),
    provenance: z.literal("local-user-supplied"),
  }),
});

const directorCharacterMotionCatalogSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    generator: z.literal("tools/scripts/package_mixamo_animations.py"),
    items: z.array(directorCharacterMotionCatalogItemSchema).min(1),
  })
  .superRefine((catalog, context) => {
    const ids = new Set<string>();
    catalog.items.forEach((item, index) => {
      if (ids.has(item.id)) {
        context.addIssue({ code: "custom", message: `duplicate motion id ${item.id}`, path: ["items", index, "id"] });
      }
      ids.add(item.id);
    });
  });

export type DirectorCharacterMotionCatalogItem = z.infer<typeof directorCharacterMotionCatalogItemSchema>;

const parsedCatalog = directorCharacterMotionCatalogSchema.parse(motionCatalogJson);

/** Shared source of truth for runtime loading, inspector choices, and Agent capabilities. */
export const DIRECTOR_CHARACTER_MOTION_CATALOG: readonly DirectorCharacterMotionCatalogItem[] = Object.freeze(
  parsedCatalog.items,
);

const motionById = new Map(DIRECTOR_CHARACTER_MOTION_CATALOG.map((item) => [item.id, item]));

export function getDirectorCharacterMotion(clipId: string) {
  return motionById.get(clipId) ?? null;
}

export function isDirectorCharacterMotionId(clipId: string) {
  return motionById.has(clipId);
}

/**
 * Gait clips animate the authored vertical pelvis bob, so their in-place
 * playback needs per-frame foot grounding. This covers the whole locomotion
 * family (forward, backward, and strafe walks/runs), not just `walk`/`run`.
 */
export function isDirectorLocomotionMotion(clipId: string) {
  return motionById.get(clipId)?.category === "locomotion";
}

/** Map the legacy trajectory pace selector onto real packaged skeletal clips. */
export function getTimelineCharacterMotion(animation: DirectorEntityAnimation | undefined) {
  const pace = animation?.motion;
  if (!animation || !pace || pace === "none") return null;
  const clipId = pace === "slow-walk" || pace === "walk" ? "walk" : "run";
  const paceScale = pace === "slow-walk" ? 0.7 : pace === "jog" ? 0.85 : pace === "sprint" ? 1.35 : 1;
  const startFrame = animation.keyframes.length
    ? Math.min(...animation.keyframes.map((keyframe) => keyframe.frame))
    : 0;
  return {
    clipId,
    enabled: animation.enabled !== false,
    loop: "repeat",
    speed: Math.min(4, Math.max(0.1, (animation.speed ?? 1) * paceScale)),
    weight: 1,
    startFrame,
    blendInS: 0.12,
    blendOutS: 0,
    rootMotion: "in-place",
  } satisfies DirectorCharacterMotionState;
}
