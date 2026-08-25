import { describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../src/directorDefaultProject";
import { applyDirectorAuthoringActions } from "../src/directorAuthoring";
import {
  DIRECTOR_NATIVE_STAGE_PATCH_FIELDS,
  describeDirectorCameraKernelOwnership,
  describeDirectorLightKernelOwnership,
  describeDirectorObjectKernelOwnership,
  describeUnmirroredBlenderKernelOwnership,
  directorKernelOwnershipSchema,
} from "../src/directorKernelOwnership";
import type { DirectorObject } from "@director/project-schema";

function stageObject(overrides: Partial<DirectorObject> = {}): DirectorObject {
  return {
    id: "prop-1",
    name: "道具",
    kind: "prop",
    visible: true,
    locked: false,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    ...overrides,
  };
}

describe("director kernel ownership", () => {
  it("reports Blender ownership and the exact Stage patch allow-list for a provisioned native object", () => {
    const ownership = describeDirectorObjectKernelOwnership(
      stageObject({ nativeSource: { engine: "blender", objectId: "native-mesh-1", provisioned: true } }),
      [],
    );

    expect(directorKernelOwnershipSchema.parse(ownership)).toEqual(ownership);
    expect(ownership.kernel).toBe("blender");
    expect(ownership.source).toBe("blender_native");
    expect(ownership.blender_object_id).toBe("native-mesh-1");
    expect(ownership.blender_provisioned).toBe(true);
    expect(ownership.stage_patchable_fields).toEqual([...DIRECTOR_NATIVE_STAGE_PATCH_FIELDS]);
    expect(ownership.rejected_stage_patches).toEqual([
      expect.objectContaining({ fields: ["*"], use_instead: expect.stringContaining("blender_native") }),
    ]);
    expect(ownership.deletes_with_blender).toBe(true);
  });

  it("keeps the allow-list in lockstep with the update_object enforcement", () => {
    const project = createDefaultDirectorProject();
    const native = project.objects.find((object) => object.nativeSource?.engine === "blender")!;
    native.nativeSource = { ...native.nativeSource!, provisioned: true };
    const ownership = describeDirectorObjectKernelOwnership(native, project.assets);
    expect(ownership.stage_patchable_fields).not.toBe("all");

    for (const field of ownership.stage_patchable_fields as string[]) {
      const patch =
        field === "name"
          ? { name: "重命名" }
          : field === "visible"
            ? { visible: false }
            : field === "locked"
              ? { locked: false }
              : { transform: { position: [1, 0, 0] as [number, number, number] } };
      expect(() =>
        applyDirectorAuthoringActions(structuredClone(project), [
          { action: "update_object", object_id: native.id, patch },
        ]),
      ).not.toThrow();
    }
    expect(() =>
      applyDirectorAuthoringActions(structuredClone(project), [
        { action: "update_object", object_id: native.id, patch: { material: { roughness: 0.4 } } },
      ]),
    ).toThrow(/blender_native/);
  });

  it("keeps Stage ownership for a native object the Stage authored but Blender has not provisioned", () => {
    const ownership = describeDirectorObjectKernelOwnership(
      stageObject({ nativeSource: { engine: "blender", objectId: "prop-1", provisioned: false } }),
      [],
    );
    expect(ownership.kernel).toBe("stage");
    expect(ownership.blender_object_id).toBe("prop-1");
    expect(ownership.blender_provisioned).toBe(false);
    expect(ownership.stage_patchable_fields).toBe("all");
    expect(ownership.deletes_with_blender).toBe(false);
  });

  it("classifies asset provenance from the real assetSource values", () => {
    const assets = [
      { id: "catalog-asset", sourceType: "model", fileName: "tree.glb", url: "/x/tree.glb", assetSource: "library" },
      { id: "generated-asset", sourceType: "model", fileName: "gen.glb", url: "/x/gen.glb", assetSource: "generated" },
      { id: "local-asset", sourceType: "model", fileName: "user.glb", url: "/x/user.glb", assetSource: "local" },
    ] as never[];

    expect(describeDirectorObjectKernelOwnership(stageObject({ assetRefId: "catalog-asset" }), assets)).toMatchObject({
      kernel: "stage",
      source: "stage_catalog",
      blender_object_id: null,
      blender_provisioned: null,
      deletes_with_blender: false,
    });
    expect(describeDirectorObjectKernelOwnership(stageObject({ assetRefId: "generated-asset" }), assets)).toMatchObject(
      { kernel: "stage", source: "generated_3d" },
    );
    expect(describeDirectorObjectKernelOwnership(stageObject({ assetRefId: "local-asset" }), assets)).toMatchObject({
      kernel: "stage",
      source: "stage_local_asset",
    });
  });

  it("re-provisions instead of deleting when Blender drops an asset-backed native object", () => {
    const assets = [
      { id: "catalog-asset", sourceType: "model", fileName: "tree.glb", url: "/x/tree.glb", assetSource: "library" },
    ] as never[];
    const ownership = describeDirectorObjectKernelOwnership(
      stageObject({
        assetRefId: "catalog-asset",
        nativeSource: { engine: "blender", objectId: "native-tree", provisioned: true },
      }),
      assets,
    );
    expect(ownership.kernel).toBe("blender");
    expect(ownership.deletes_with_blender).toBe(false);
  });

  it("classifies primitives, characters, and camera rigs from project state", () => {
    expect(describeDirectorObjectKernelOwnership(stageObject({ geometryType: "box" }), [])).toMatchObject({
      kernel: "stage",
      source: "stage_primitive",
      rejected_stage_patches: [expect.objectContaining({ fields: ["geometry_type"] })],
    });
    expect(describeDirectorObjectKernelOwnership(stageObject({ kind: "character" }), [])).toMatchObject({
      kernel: "stage",
      source: "stage_character",
      stage_patchable_fields: "all",
    });

    const rig = describeDirectorObjectKernelOwnership(
      stageObject({ kind: "camera", linkedCameraId: "cam-main" }),
      [],
    );
    expect(rig).toMatchObject({ kernel: "stage", source: "stage_camera_rig", stage_patchable_fields: [] });
    expect(rig.rejected_stage_patches[0]?.use_instead).toContain('update_camera with camera_id "cam-main"');
  });

  it("describes lights and cameras with the native mirror but no Stage patch restrictions", () => {
    const project = createDefaultDirectorProject();
    project.lights![0].nativeSource = { engine: "blender", objectId: "native-light-a", provisioned: true };
    project.cameras[0].nativeSource = { engine: "blender", objectId: "native-camera-a", provisioned: false };

    expect(describeDirectorLightKernelOwnership(project.lights![0])).toMatchObject({
      kernel: "blender",
      source: "blender_native",
      blender_object_id: "native-light-a",
      stage_patchable_fields: "all",
      rejected_stage_patches: [],
      deletes_with_blender: true,
    });
    expect(describeDirectorCameraKernelOwnership(project.cameras[0])).toMatchObject({
      kernel: "stage",
      source: "stage_camera",
      blender_provisioned: false,
      deletes_with_blender: true,
    });
    expect(describeDirectorLightKernelOwnership({ ...project.lights![0], nativeSource: undefined })).toMatchObject({
      kernel: "stage",
      source: "stage_light",
      blender_object_id: null,
      deletes_with_blender: false,
    });
  });

  it("marks a Blender datablock with no Stage counterpart as Blender-only", () => {
    const ownership = describeUnmirroredBlenderKernelOwnership("orphan-mesh");
    expect(directorKernelOwnershipSchema.parse(ownership)).toEqual(ownership);
    expect(ownership).toMatchObject({
      kernel: "blender",
      source: "blender_native",
      blender_object_id: "orphan-mesh",
      stage_patchable_fields: [],
      deletes_with_blender: true,
    });
  });
});
