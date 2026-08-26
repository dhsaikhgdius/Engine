import { beforeEach, describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "@director/agent-engine/default-project";
import type { DirectorProject } from "@director/project-schema";
import type { PersistentCreativeMediaState } from "../../src/comprehensive/editor/media/persistentCreativeMediaStore";
import { useDirectorCreativeWorkspaceStore } from "../../src/comprehensive/editor/workspaces/directorWorkspaceStore";
import {
  executeCreativeWorkspaceInterchangeRequest,
  type CreativeWorkspaceSemanticContext,
} from "../../src/agent/creativeWorkspaceSemanticOperations";

const EMPTY_MEDIA: PersistentCreativeMediaState = {
  status: "ready",
  storageMode: "memory",
  warning: null,
  error: null,
  assets: [],
};

const FOUNTAIN = `Title: The Platform
Logline: A traveller catches the last train.

INT. STATION HALL - NIGHT

Mara studies the departure board, then starts running.
`;

function importContext(
  options: {
    project?: DirectorProject;
    resolveWorkspacePath?: CreativeWorkspaceSemanticContext["resolveWorkspacePath"];
  } = {},
): CreativeWorkspaceSemanticContext & { getImportedProject: () => DirectorProject } {
  let project = options.project ?? createDefaultDirectorProject();
  return {
    getScopeId: () => "semantic-scene",
    getStageProject: () => project,
    replaceStageProject: (next) => {
      project = next;
    },
    getImportedProject: () => project,
    getCreativeState: () => useDirectorCreativeWorkspaceStore.getState(),
    getMediaState: () => EMPTY_MEDIA,
    getCreativeSnapshotFingerprint: () => "creative-revision:v1:import",
    ...(options.resolveWorkspacePath ? { resolveWorkspacePath: options.resolveWorkspacePath } : {}),
  };
}

describe("creative workspace interchange import", () => {
  beforeEach(() => {
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });

  it("plans and commits an inline Fountain Stage import with confirm:true", async () => {
    const context = importContext();
    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-import",
          format: "fountain",
          workspace: "stage",
          source: { kind: "inline", encoding: "utf8", payload: FOUNTAIN, file_name: "platform.fountain" },
          max_inline_bytes: 64 * 1024,
        },
      },
      context,
    );
    expect(planned).toMatchObject({
      result: {
        success: true,
        action: "plan-import",
        plan: { format: "fountain", workspace: "stage", source_kind: "inline", file_name: "platform.fountain" },
      },
    });
    if (!planned.result.success || planned.result.action !== "plan-import") throw new Error("missing import plan");

    const imported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "import",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
          confirm: true,
        },
      },
      context,
    );
    expect(imported).toMatchObject({
      result: { success: true, action: "import", receipt: { format: "fountain", workspace: "stage" } },
    });
    expect(context.getImportedProject().storyboard?.shots.length).toBeGreaterThan(0);
  });

  it("projects typed Creative OTIO omitted records onto the import plan and receipt", async () => {
    const otio = JSON.stringify({
      OTIO_SCHEMA: "Timeline.1",
      name: "Agent Video",
      global_start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
      metadata: {},
      tracks: {
        OTIO_SCHEMA: "Stack.1",
        name: "Tracks",
        metadata: {},
        children: [
          {
            OTIO_SCHEMA: "Track.1",
            name: "V1",
            kind: "Video",
            metadata: {},
            children: [
              {
                OTIO_SCHEMA: "Clip.2",
                name: "Remote",
                source_range: {
                  OTIO_SCHEMA: "TimeRange.1",
                  start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
                  duration: { OTIO_SCHEMA: "RationalTime.1", value: 24, rate: 24 },
                },
                media_reference: {
                  OTIO_SCHEMA: "ExternalReference.1",
                  name: "Remote.mov",
                  target_url: "file:///Volumes/Offline/Remote.mov",
                  metadata: {},
                },
                metadata: {},
              },
              {
                OTIO_SCHEMA: "Transition.1",
                name: "Dissolve",
                source_range: {
                  OTIO_SCHEMA: "TimeRange.1",
                  start_time: { OTIO_SCHEMA: "RationalTime.1", value: 0, rate: 24 },
                  duration: { OTIO_SCHEMA: "RationalTime.1", value: 12, rate: 24 },
                },
                metadata: {},
              },
            ],
          },
        ],
      },
    });
    const context = importContext();
    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-import",
          format: "otio",
          workspace: "video",
          source: { kind: "inline", encoding: "utf8", payload: otio, file_name: "edit.otio" },
          max_inline_bytes: 64 * 1024,
        },
      },
      context,
    );
    expect(planned).toMatchObject({
      result: {
        success: true,
        action: "plan-import",
        plan: {
          format: "otio",
          workspace: "video",
          omitted_count: 2,
        },
      },
    });
    if (!planned.result.success || planned.result.action !== "plan-import") throw new Error("missing import plan");
    expect(planned.result.plan.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "offline_media" }),
        expect.objectContaining({ code: "unsupported_as_gap" }),
      ]),
    );

    const imported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "import",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
          confirm: true,
        },
      },
      context,
    );
    expect(imported).toMatchObject({
      result: {
        success: true,
        action: "import",
        receipt: {
          format: "otio",
          workspace: "video",
          omitted_count: 2,
        },
      },
    });
    if (!imported.result.success || imported.result.action !== "import") throw new Error("missing import receipt");
    expect(imported.result.receipt.omitted).toHaveLength(2);
  });

  it("projects typed Fountain omitted records onto the import plan and receipt", async () => {
    const fountain = `Title: Night Run
Author: Ada
Logline: A courier misses the last train.

INT. LOBBY - NIGHT

Courier checks the board.

COURIER
Where is platform nine?
`;
    const context = importContext();
    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-import",
          format: "fountain",
          workspace: "stage",
          source: { kind: "inline", encoding: "utf8", payload: fountain, file_name: "night.fountain" },
          max_inline_bytes: 64 * 1024,
        },
      },
      context,
    );
    expect(planned).toMatchObject({
      result: {
        success: true,
        action: "plan-import",
        plan: { format: "fountain", workspace: "stage" },
      },
    });
    if (!planned.result.success || planned.result.action !== "plan-import") throw new Error("missing import plan");
    expect(planned.result.plan.omitted_count).toBeGreaterThanOrEqual(2);
    expect(planned.result.plan.omitted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "title_page_field", subject: "Author" }),
        expect.objectContaining({ code: "character_dialogue", subject: "COURIER" }),
      ]),
    );

    const imported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "import",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
          confirm: true,
        },
      },
      context,
    );
    expect(imported).toMatchObject({
      result: {
        success: true,
        action: "import",
        receipt: { format: "fountain", workspace: "stage" },
      },
    });
    if (!imported.result.success || imported.result.action !== "import") throw new Error("missing import receipt");
    expect(imported.result.receipt.omitted).toEqual(planned.result.plan.omitted);
  });

  it("reads a workspace_path source through the host resolver", async () => {
    const context = importContext({
      resolveWorkspacePath: async () => ({
        bytes: new TextEncoder().encode(FOUNTAIN),
        fileName: "from-workspace.fountain",
      }),
    });
    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-import",
          format: "fountain",
          workspace: "stage",
          source: { kind: "workspace_path", path: "imports/platform.fountain" },
          max_inline_bytes: 64 * 1024,
        },
      },
      context,
    );
    expect(planned).toMatchObject({
      result: { success: true, action: "plan-import", plan: { source_kind: "workspace_path" } },
    });
  });

  it("rejects a browser workspace_path import when no host resolver is available", async () => {
    const missingHost = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-import",
          format: "fountain",
          workspace: "stage",
          source: { kind: "workspace_path", path: "imports/platform.fountain" },
          max_inline_bytes: 64 * 1024,
        },
      },
      importContext(),
    );
    expect(missingHost).toMatchObject({ result: { success: false, code: "unavailable" } });
  });

  it("rejects an import without confirm and a guessed plan_id", async () => {
    const context = importContext();
    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-import",
          format: "fountain",
          workspace: "stage",
          source: { kind: "inline", encoding: "utf8", payload: FOUNTAIN },
          max_inline_bytes: 64 * 1024,
        },
      },
      context,
    );
    if (!planned.result.success || planned.result.action !== "plan-import") throw new Error("missing import plan");

    const unknown = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "import",
          plan_id: "interchange-plan:v1:00000000-0000-0000-0000-000000000000",
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
          confirm: true,
        },
      },
      context,
    );
    expect(unknown).toMatchObject({ result: { success: false, code: "not_found" } });
  });

  it("projects typed glTF omitted records onto the import plan and receipt", async () => {
    const gltf = JSON.stringify({
      asset: { version: "2.0" },
      scenes: [{ nodes: [0, 1] }],
      scene: 0,
      nodes: [
        {
          name: "Marker A",
          translation: [1, 0, 0],
          extras: {
            director: {
              adapter: "director-gltf-v1",
              contract: "director-interchange-v1",
              stableId: "dup-agent-001",
              entityType: "object",
              kind: "prop",
            },
          },
        },
        {
          name: "Marker B",
          translation: [2, 0, 0],
          extras: {
            director: {
              adapter: "director-gltf-v1",
              contract: "director-interchange-v1",
              stableId: "dup-agent-001",
              entityType: "object",
              kind: "prop",
            },
          },
        },
      ],
    });
    const context = importContext();
    const planned = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "plan-import",
          format: "gltf",
          workspace: "stage",
          source: { kind: "inline", encoding: "utf8", payload: gltf, file_name: "dup.gltf" },
          max_inline_bytes: 64 * 1024,
        },
      },
      context,
    );
    expect(planned).toMatchObject({
      result: {
        success: true,
        action: "plan-import",
        plan: { format: "gltf", workspace: "stage" },
      },
    });
    if (!planned.result.success || planned.result.action !== "plan-import") throw new Error("missing import plan");
    expect(planned.result.plan.omitted_count).toBe(1);
    expect(planned.result.plan.omitted).toEqual([
      expect.objectContaining({ code: "duplicate_stable_id", subject: "dup-agent-001" }),
    ]);

    const imported = await executeCreativeWorkspaceInterchangeRequest(
      {
        op: "interchange",
        request: {
          action: "import",
          plan_id: planned.result.plan.plan_id,
          expected_guard_fingerprint: planned.result.plan.guard.fingerprint,
          confirm: true,
        },
      },
      context,
    );
    expect(imported).toMatchObject({
      result: {
        success: true,
        action: "import",
        receipt: { format: "gltf", workspace: "stage" },
      },
    });
    if (!imported.result.success || imported.result.action !== "import") throw new Error("missing import receipt");
    expect(imported.result.receipt.omitted).toEqual(planned.result.plan.omitted);
    expect(context.getImportedProject().objects.map((object) => object.id)).toContain("dup-agent-001");
    expect(context.getImportedProject().objects.filter((object) => object.id === "dup-agent-001")).toHaveLength(1);
  });
});
