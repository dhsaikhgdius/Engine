import { z } from "zod";
import type { DirectorAssetRef, DirectorCameraShot, DirectorLight, DirectorObject } from "@director/project-schema";

/**
 * Kernel ownership: the machine-readable answer to "which kernel owns this
 * entity's data and which Stage patches will be rejected", attached to
 * `director_workbench inspect` results for objects, lights, and cameras.
 *
 * The Director project runs on two kernels. The Stage project store owns
 * catalog instances, generated-3D placements, characters, and plain objects;
 * they are not Blender datablocks, so clearing Blender or deleting bpy objects
 * never removes them. A provisioned native object mirrors a live Blender
 * datablock; Blender owns its geometry and material, and
 * `director_workbench update_object` deliberately accepts only
 * name/visible/locked/transform for it (see `directorAuthoring`).
 */

/** The exact `update_object` patch fields the Stage accepts on a Blender-owned object. */
export const DIRECTOR_NATIVE_STAGE_PATCH_FIELDS = ["name", "visible", "locked", "transform"] as const;

/** Which kernel owns the entity's renderable data. */
export const DIRECTOR_KERNEL_OWNERS = ["stage", "blender"] as const;
export type DirectorKernelOwner = (typeof DIRECTOR_KERNEL_OWNERS)[number];

/**
 * Where the entity's renderable data comes from. Values mirror real project
 * state: `nativeSource.provisioned` for `blender_native`, `assetSource` for
 * `generated_3d` / `stage_catalog` / `stage_local_asset`, `geometryType` for
 * legacy `stage_primitive`, and object kind for the remaining Stage sources.
 */
export const DIRECTOR_KERNEL_SOURCES = [
  "blender_native",
  "generated_3d",
  "stage_catalog",
  "stage_local_asset",
  "stage_primitive",
  "stage_character",
  "stage_camera_rig",
  "stage_object",
  "stage_light",
  "stage_camera",
] as const;
export type DirectorKernelSource = (typeof DIRECTOR_KERNEL_SOURCES)[number];

/** In `rejected_stage_patches.fields`, matches every patch field not listed in `stage_patchable_fields`. */
export const DIRECTOR_KERNEL_ANY_OTHER_FIELD = "*" as const;

const rejectedStagePatchSchema = z.strictObject({
  fields: z
    .array(z.string().min(1))
    .min(1)
    .describe('Patch fields the Stage rejects for this entity; "*" means every field not in stage_patchable_fields.'),
  use_instead: z.string().min(1).describe("The operation that owns these edits."),
});

/**
 * The stable `kernel_ownership` block on object/light/camera inspect results.
 * This schema is the canonical vocabulary; `describe target:"inspect"` embeds it.
 */
export const directorKernelOwnershipSchema = z.strictObject({
  kernel: z
    .enum(DIRECTOR_KERNEL_OWNERS)
    .describe(
      "stage: the Director project store owns the data; it is not a Blender datablock and Blender edits or deletions cannot touch it. blender: the live Blender kernel owns geometry and material; the Stage only mirrors identity, visibility, and transform.",
    ),
  source: z.enum(DIRECTOR_KERNEL_SOURCES).describe("Where the renderable data comes from."),
  blender_object_id: z
    .string()
    .nullable()
    .describe("The Blender datablock id mirroring this entity, or null when Blender holds no representation."),
  blender_provisioned: z
    .boolean()
    .nullable()
    .describe(
      "true: Blender owns the datablock. false: the Stage authored it and the mirror provisions a Blender representation. null: no native representation.",
    ),
  stage_patchable_fields: z
    .union([z.literal("all"), z.array(z.string().min(1))])
    .describe("Update patch fields director_workbench accepts for this entity."),
  rejected_stage_patches: z
    .array(rejectedStagePatchSchema)
    .describe("Update patch fields director_workbench rejects here, each with the operation to use instead."),
  deletes_with_blender: z
    .boolean()
    .describe(
      "true: deleting the Blender datablock removes this entity from the project. false: only director_workbench delete actions remove it (asset-backed native objects are re-provisioned instead of dropped).",
    ),
  stage_entity: z
    .strictObject({ entity: z.enum(["object", "light", "camera"]), id: z.string().min(1) })
    .optional()
    .describe(
      "On blender_native inspect results only: the Stage entity mirroring this Blender datablock. director_workbench addresses this id, not the Blender datablock id.",
    ),
});
export type DirectorKernelOwnership = z.infer<typeof directorKernelOwnershipSchema>;

const GEOMETRY_TYPE_REJECTION: DirectorKernelOwnership["rejected_stage_patches"][number] = {
  fields: ["geometry_type"],
  use_instead:
    "Rejected on the public wire for every object: instance catalog or project meshes with asset_id, model with blender_native, or generate with generated_3d.",
};

function blenderNativeSource(entity: { nativeSource?: { engine: "blender"; objectId: string; provisioned?: boolean } }) {
  return entity.nativeSource?.engine === "blender" ? entity.nativeSource : null;
}

function stageObjectSource(object: DirectorObject, asset: DirectorAssetRef | undefined): DirectorKernelSource {
  if (asset?.assetSource === "generated") return "generated_3d";
  if (asset?.assetSource === "library" || asset?.assetSource === "remote") return "stage_catalog";
  if (asset) return "stage_local_asset";
  if (object.geometryType) return "stage_primitive";
  if (object.kind === "character") return "stage_character";
  return "stage_object";
}

/**
 * Compute kernel ownership for one Stage object.
 *
 * Mirrors the enforcement in `directorAuthoring` exactly: a provisioned native
 * Blender object (`nativeSource.provisioned !== false`) accepts only
 * {@link DIRECTOR_NATIVE_STAGE_PATCH_FIELDS} through `update_object`; camera
 * rig objects reject `update_object` entirely in favour of `update_camera`.
 *
 * @param object - The inspected project object.
 * @param assets - The project asset list used to resolve `assetRefId` provenance.
 */
export function describeDirectorObjectKernelOwnership(
  object: DirectorObject,
  assets: readonly DirectorAssetRef[],
): DirectorKernelOwnership {
  const native = blenderNativeSource(object);
  const blenderOwned = Boolean(native && native.provisioned !== false);
  const asset = object.assetRefId ? assets.find((item) => item.id === object.assetRefId) : undefined;
  // Matches the Stage reconcile: a missing native datablock re-provisions
  // model-asset objects instead of dropping them from the project.
  const reprovisionsFromAsset = Boolean(asset && asset.sourceType === "model" && asset.kind !== "panorama");
  const shared = {
    blender_object_id: native?.objectId ?? null,
    blender_provisioned: native ? native.provisioned !== false : null,
    deletes_with_blender: blenderOwned && !reprovisionsFromAsset,
  };
  if (object.kind === "camera") {
    return {
      kernel: blenderOwned ? "blender" : "stage",
      source: blenderOwned ? "blender_native" : "stage_camera_rig",
      ...shared,
      stage_patchable_fields: [],
      rejected_stage_patches: [
        {
          fields: [DIRECTOR_KERNEL_ANY_OTHER_FIELD],
          use_instead: object.linkedCameraId
            ? `update_object rejects camera rig objects; use author.update_camera with camera_id "${object.linkedCameraId}".`
            : "update_object rejects camera rig objects; use author.update_camera with the linked camera id.",
        },
      ],
    };
  }
  if (blenderOwned) {
    return {
      kernel: "blender",
      source: "blender_native",
      ...shared,
      stage_patchable_fields: [...DIRECTOR_NATIVE_STAGE_PATCH_FIELDS],
      rejected_stage_patches: [
        {
          fields: [DIRECTOR_KERNEL_ANY_OTHER_FIELD],
          use_instead: `Blender owns this object's material and geometry. Use blender_native (assign_material, set_material_node_input, modifiers, Edit Mode, set_parent) on blender_object_id "${native!.objectId}".`,
        },
      ],
    };
  }
  return {
    kernel: "stage",
    source: stageObjectSource(object, asset),
    ...shared,
    stage_patchable_fields: "all",
    rejected_stage_patches: [GEOMETRY_TYPE_REJECTION],
  };
}

/**
 * Compute kernel ownership for one Stage light. `update_light` accepts every
 * field regardless of the native mirror, so nothing is rejected; the kernel
 * still reports which side owns the datablock, because the reconcile drops
 * lights whose Blender datablock disappeared.
 */
export function describeDirectorLightKernelOwnership(light: DirectorLight): DirectorKernelOwnership {
  const native = blenderNativeSource(light);
  const blenderOwned = Boolean(native && native.provisioned !== false);
  return {
    kernel: blenderOwned ? "blender" : "stage",
    source: blenderOwned ? "blender_native" : "stage_light",
    blender_object_id: native?.objectId ?? null,
    blender_provisioned: native ? native.provisioned !== false : null,
    stage_patchable_fields: "all",
    rejected_stage_patches: [],
    deletes_with_blender: Boolean(native),
  };
}

/**
 * Compute kernel ownership for one Stage camera. `update_camera` accepts every
 * field regardless of the native mirror; the reconcile drops cameras whose
 * Blender datablock disappeared.
 */
export function describeDirectorCameraKernelOwnership(camera: DirectorCameraShot): DirectorKernelOwnership {
  const native = blenderNativeSource(camera);
  const blenderOwned = Boolean(native && native.provisioned !== false);
  return {
    kernel: blenderOwned ? "blender" : "stage",
    source: blenderOwned ? "blender_native" : "stage_camera",
    blender_object_id: native?.objectId ?? null,
    blender_provisioned: native ? native.provisioned !== false : null,
    stage_patchable_fields: "all",
    rejected_stage_patches: [],
    deletes_with_blender: Boolean(native),
  };
}

/**
 * Kernel ownership for a live Blender object that has no counterpart in the
 * persisted Director project (a disconnected-read inspect served straight from
 * the Blender kernel).
 */
export function describeUnmirroredBlenderKernelOwnership(blenderObjectId: string): DirectorKernelOwnership {
  return {
    kernel: "blender",
    source: "blender_native",
    blender_object_id: blenderObjectId,
    blender_provisioned: true,
    stage_patchable_fields: [],
    rejected_stage_patches: [
      {
        fields: [DIRECTOR_KERNEL_ANY_OTHER_FIELD],
        use_instead:
          "This object lives only in the live Blender kernel; edit it with blender_native. A connected Stage tab mirrors it into the project on the next sync.",
      },
    ],
    deletes_with_blender: true,
  };
}
