import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type {
  DirectorBlendSceneImportPlanV1,
  DirectorBlendSceneManifestV1,
} from "@director/dcc-protocol";
import type { BlenderBridge } from "../../dcc/blenderBridge";
import type { BlenderSceneImporter } from "../../dcc/blenderSceneImport";
import type { BlenderReturnImporter } from "../../dcc/blenderReturnImport";
import { createTestDirectorProject } from "../fixtures/createTestDirectorProject";
import { handleDccRoute } from "../../routes/dccRoutes";
import { getDirectorDccProviderDescriptor } from "@director/dcc-protocol";
import type { DirectorDccProviderRegistry } from "../../dcc/dccProviderRegistry";
import { DirectorDccExchangePackageError, type DirectorDccExchangePackager } from "../../dcc/dccExchangePackage";

const BLEND_HASH = "a".repeat(64);
const BLEND_REVISION = `director-project-revision:v1:sha256:${"b".repeat(64)}` as const;

function request(method: string): IncomingMessage {
  return { method } as IncomingMessage;
}

function response(): ServerResponse {
  return {} as ServerResponse;
}

function rawRequest(method: string, body = "BLENDER-v300", headers: Record<string, string> = {}): IncomingMessage {
  return Object.assign(Readable.from([Buffer.from(body)]), { method, headers }) as unknown as IncomingMessage;
}

function blendManifest(): DirectorBlendSceneManifestV1 {
  return {
    schemaVersion: 1,
    contract: "director-blend-scene-v1",
    packageId: "blend-job-1",
    exportedAt: "2026-08-06T08:00:00.000Z",
    blenderVersion: "Blender 5.1.2",
    source: { fileName: "source.blend", sha256: BLEND_HASH, sizeBytes: 12 },
    coordinateSystem: {
      source: "right-handed-z-up-negative-z-camera-forward",
      destination: "right-handed-y-up-negative-z-forward",
      unit: "meter",
      linearMap: "(x,y,z)->(x,z,-y)",
    },
    timeline: {
      frameStart: 1,
      frameEnd: 120,
      currentFrame: 1,
      fps: 24,
      timebase: { rate: { numerator: 24, denominator: 1 } },
    },
    scene: {
      name: "Imported stage",
      bundleFile: null,
      objectCount: 0,
      meshCount: 0,
      materialCount: 0,
      actionCount: 0,
    },
    cameras: [],
    unsupported: [],
    warnings: [],
    fileHashes: {},
  };
}

function blendPlan(ready = true): DirectorBlendSceneImportPlanV1 {
  return {
    contract: "director-blend-scene-import-plan-v1",
    planId: "blend-job-1/plans/default.json",
    ready,
    packageId: "blend-job-1",
    packageDir: "blend-job-1/package",
    manifestHash: BLEND_HASH,
    targetRevision: BLEND_REVISION,
    selection: { includeScene: false, cameraSourceIds: [] },
    operations: [],
    conflicts: ready ? [] : [{ sourceId: "selection", code: "empty_selection", reason: "Select a scene or camera." }],
    warnings: [],
  };
}

function mockedSceneImporter(overrides: Partial<BlenderSceneImporter> = {}): BlenderSceneImporter {
  const plan = blendPlan();
  return {
    ingestUpload: vi.fn().mockResolvedValue({
      jobId: "blend-job-1",
      packagePath: "blend-job-1/package",
      manifest: blendManifest(),
      plan,
    }),
    validatePackage: vi.fn(),
    buildImportPlan: vi.fn().mockResolvedValue(plan),
    applyImportPlan: vi.fn().mockResolvedValue({
      plan,
      authoring: { success: true },
      copiedAssets: [],
    }),
    ...overrides,
  } as BlenderSceneImporter;
}

describe("DCC routes", () => {
  it("returns Blender bridge status without requesting a project", async () => {
    const json = vi.fn();
    const getProject = vi.fn();
    const blender: BlenderBridge = {
      status: vi.fn().mockResolvedValue({
        available: true,
        executable: "/Blender",
        version: "Blender 5.1",
        contract: "director-dcc-scene-v1",
      }),
      exportBlend: vi.fn(),
    };
    expect(
      await handleDccRoute(request("GET"), response(), new URL("http://test/api/dcc/status"), {
        readBody: vi.fn(),
        json,
        getProject,
        blender,
      }),
    ).toBe(true);
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, expect.objectContaining({ success: true }));
    expect(getProject).not.toHaveBeenCalled();
  });

  it("streams a raw Blender upload to the scene importer without parsing it as JSON", async () => {
    const json = vi.fn();
    const readBody = vi.fn();
    const project = createTestDirectorProject();
    const sceneImporter = mockedSceneImporter();
    const upload = rawRequest("POST", "BLENDER-v300", {
      "content-type": "application/x-blender; charset=binary",
      "content-length": "12",
    });

    expect(
      await handleDccRoute(
        upload,
        response(),
        new URL(`http://test/api/dcc/blender-scene/uploads?filename=${encodeURIComponent("片场 #1.blend")}`),
        {
          readBody,
          json,
          getProject: vi.fn().mockResolvedValue(project),
          blender: { status: vi.fn(), exportBlend: vi.fn() },
          sceneImporter,
        },
      ),
    ).toBe(true);

    expect(readBody).not.toHaveBeenCalled();
    expect(sceneImporter.ingestUpload).toHaveBeenCalledWith("片场 #1.blend", upload, project, 12);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ jobId: "blend-job-1", packagePath: "blend-job-1/package" }),
      }),
    );
  });

  it.each([
    {
      caseName: "a non-POST method",
      upload: rawRequest("GET"),
      url: "http://test/api/dcc/blender-scene/uploads?filename=stage.blend",
      status: 405,
    },
    {
      caseName: "an unsupported content type",
      upload: rawRequest("POST", "BLENDER-v300", { "content-type": "application/json" }),
      url: "http://test/api/dcc/blender-scene/uploads?filename=stage.blend",
      status: 415,
    },
    {
      caseName: "a missing filename",
      upload: rawRequest("POST", "BLENDER-v300", { "content-type": "application/octet-stream" }),
      url: "http://test/api/dcc/blender-scene/uploads",
      status: 400,
    },
  ])("rejects $caseName before reading the upload body", async ({ upload, url, status }) => {
    const json = vi.fn();
    const readBody = vi.fn();
    const getProject = vi.fn();
    const sceneImporter = mockedSceneImporter();

    expect(
      await handleDccRoute(upload, response(), new URL(url), {
        readBody,
        json,
        getProject,
        blender: { status: vi.fn(), exportBlend: vi.fn() },
        sceneImporter,
      }),
    ).toBe(true);

    expect(json).toHaveBeenCalledWith(expect.anything(), status, expect.objectContaining({ success: false }));
    expect(readBody).not.toHaveBeenCalled();
    expect(getProject).not.toHaveBeenCalled();
    expect(sceneImporter.ingestUpload).not.toHaveBeenCalled();
  });

  it("validates and exports the live project", async () => {
    const json = vi.fn();
    const project = createTestDirectorProject();
    const blender: BlenderBridge = {
      status: vi.fn(),
      exportBlend: vi.fn().mockResolvedValue({ jobId: "job-1", blendPath: "/safe/job/scene.blend" }),
    };
    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({ input: { op: "export_blend", render_preview: true } }),
      json,
      getProject: vi.fn().mockResolvedValue(project),
      blender,
    });
    expect(blender.exportBlend).toHaveBeenCalledWith(project, {
      renderPreview: true,
      cameraId: undefined,
      frame: undefined,
    });
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, result: expect.objectContaining({ jobId: "job-1" }) }),
    );
  });

  it("rejects malformed DCC operations before Blender", async () => {
    const json = vi.fn();
    const blender: BlenderBridge = { status: vi.fn(), exportBlend: vi.fn() };
    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({ input: { op: "run_arbitrary_python", source: "evil" } }),
      json,
      getProject: vi.fn(),
      blender,
    });
    expect(json).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ success: false }));
    expect(blender.exportBlend).not.toHaveBeenCalled();
  });

  it("previews a Blender scene selection without applying authoring operations", async () => {
    const json = vi.fn();
    const project = createTestDirectorProject();
    const selection = { includeScene: true, cameraSourceIds: ["Camera.Main"] };
    const plan: DirectorBlendSceneImportPlanV1 = { ...blendPlan(), selection };
    const sceneImporter = mockedSceneImporter({ buildImportPlan: vi.fn().mockResolvedValue(plan) });
    const applyAuthoring = vi.fn();

    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: { op: "preview_blend_scene_import", package_dir: "blend-job-1/package", selection },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(project),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      sceneImporter,
      applyAuthoring,
    });

    expect(sceneImporter.buildImportPlan).toHaveBeenCalledWith("blend-job-1/package", project, selection);
    expect(sceneImporter.applyImportPlan).not.toHaveBeenCalled();
    expect(applyAuthoring).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, { success: true, result: { plan } });
  });

  it("returns HTTP 409 for a Blender scene preview with unresolved conflicts", async () => {
    const json = vi.fn();
    const plan = blendPlan(false);
    const sceneImporter = mockedSceneImporter({ buildImportPlan: vi.fn().mockResolvedValue(plan) });

    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: { op: "preview_blend_scene_import", package_dir: "blend-job-1/package" },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(createTestDirectorProject()),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      sceneImporter,
    });

    expect(json).toHaveBeenCalledWith(expect.anything(), 409, { success: false, result: { plan } });
  });

  it("applies a stored Blender scene plan with revision and idempotency guards", async () => {
    const json = vi.fn();
    const project = createTestDirectorProject();
    const plan = blendPlan();
    const result = { plan, authoring: { success: true }, copiedAssets: [] };
    const sceneImporter = mockedSceneImporter({ applyImportPlan: vi.fn().mockResolvedValue(result) });
    const applyAuthoring = vi.fn();

    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: {
          op: "apply_blend_scene_import",
          plan_id: plan.planId,
          expected_revision: BLEND_REVISION,
          idempotency_key: "blend-apply-1",
        },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(project),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      sceneImporter,
      applyAuthoring,
    });

    expect(sceneImporter.applyImportPlan).toHaveBeenCalledWith(
      plan.planId,
      project,
      BLEND_REVISION,
      "blend-apply-1",
      applyAuthoring,
    );
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, { success: true, result });
  });

  it("rejects an unguarded Blender scene apply before loading the live project", async () => {
    const json = vi.fn();
    const getProject = vi.fn();
    const sceneImporter = mockedSceneImporter();

    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: { op: "apply_blend_scene_import", plan_id: blendPlan().planId },
      }),
      json,
      getProject,
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      sceneImporter,
      applyAuthoring: vi.fn(),
    });

    expect(json).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ success: false }));
    expect(getProject).not.toHaveBeenCalled();
    expect(sceneImporter.applyImportPlan).not.toHaveBeenCalled();
  });

  it("returns a dry-run import plan without mutating the project", async () => {
    const json = vi.fn();
    const project = createTestDirectorProject();
    const plan = {
      contract: "director-dcc-import-plan-v1" as const,
      ready: true,
      packageId: "return-1",
      packageDir: "job-1/return-package",
      manifestHash: "a".repeat(64),
      sourceRevision: `director-project-revision:v1:sha256:${"b".repeat(64)}` as const,
      targetRevision: `director-project-revision:v1:sha256:${"b".repeat(64)}` as const,
      operations: [],
      conflicts: [],
      warnings: [],
    };
    const returnImporter = {
      buildImportPlan: vi.fn().mockResolvedValue(plan),
    } as unknown as BlenderReturnImporter;
    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: { op: "import_return_package", package_dir: "job-1/return-package", dry_run: true },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(project),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      returnImporter,
    });
    expect(returnImporter.buildImportPlan).toHaveBeenCalledWith("job-1/return-package", project);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({ success: true, result: expect.objectContaining({ plan }) }),
    );
  });

  it("passes skip_director_ids through to the return import plan build", async () => {
    const json = vi.fn();
    const project = createTestDirectorProject();
    const plan = {
      contract: "director-dcc-import-plan-v1" as const,
      ready: true,
      packageId: "return-1",
      packageDir: "job-1/return-package",
      manifestHash: "a".repeat(64),
      sourceRevision: `director-project-revision:v1:sha256:${"b".repeat(64)}` as const,
      targetRevision: `director-project-revision:v1:sha256:${"c".repeat(64)}` as const,
      operations: [{ op: "skip" as const, directorId: "chair", reason: "Skipped on request." }],
      conflicts: [],
      warnings: [],
    };
    const returnImporter = {
      buildImportPlan: vi.fn().mockResolvedValue(plan),
    } as unknown as BlenderReturnImporter;
    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: {
          op: "import_return_package",
          package_dir: "job-1/return-package",
          dry_run: true,
          skip_director_ids: ["chair"],
        },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(project),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      returnImporter,
    });
    expect(returnImporter.buildImportPlan).toHaveBeenCalledWith("job-1/return-package", project, {
      skipDirectorIds: ["chair"],
    });
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      200,
      expect.objectContaining({
        success: true,
        result: expect.objectContaining({ summary: expect.objectContaining({ skipped_count: 1 }) }),
      }),
    );
  });

  it("rejects a malformed skip_director_ids list before building the plan", async () => {
    const json = vi.fn();
    const returnImporter = { buildImportPlan: vi.fn() } as unknown as BlenderReturnImporter;
    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: { op: "import_return_package", package_dir: "job-1/return-package", skip_director_ids: "chair" },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(createTestDirectorProject()),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      returnImporter,
    });
    expect(returnImporter.buildImportPlan).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(expect.anything(), 400, expect.objectContaining({ success: false }));
  });

  it("applies only a revision-guarded import plan through browser authoring", async () => {
    const json = vi.fn();
    const project = createTestDirectorProject();
    const revision = `director-project-revision:v1:sha256:${"c".repeat(64)}` as const;
    const plan = {
      contract: "director-dcc-import-plan-v1" as const,
      ready: true,
      packageId: "return-1",
      packageDir: "job-1/return-package",
      manifestHash: "a".repeat(64),
      sourceRevision: revision,
      targetRevision: revision,
      operations: [],
      conflicts: [],
      warnings: [],
    };
    const result = { plan, authoring: { success: true }, copiedAssets: [] };
    const returnImporter = {
      applyImportPlan: vi.fn().mockResolvedValue(result),
    } as unknown as BlenderReturnImporter;
    const applyAuthoring = vi.fn();
    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: {
          op: "apply_import_plan",
          plan,
          expected_revision: revision,
          idempotency_key: "return-1",
        },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(project),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      returnImporter,
      applyAuthoring,
    });
    expect(returnImporter.applyImportPlan).toHaveBeenCalledWith(plan, project, revision, "return-1", applyAuthoring);
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, {
      success: true,
      result: { provider: "blender", ...result },
    });
  });

  it("discovers all registered DCC providers without loading the live project", async () => {
    const json = vi.fn();
    const catalog = { contract: "director-dcc-provider-catalog-v1" as const, providers: [] };
    const providers = {
      discover: vi.fn().mockResolvedValue(catalog),
    } as unknown as DirectorDccProviderRegistry;
    const getProject = vi.fn();

    await handleDccRoute(request("GET"), response(), new URL("http://test/api/dcc/providers"), {
      readBody: vi.fn(),
      json,
      getProject,
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      providers,
    });

    expect(json).toHaveBeenCalledWith(expect.anything(), 200, { success: true, result: catalog });
    expect(getProject).not.toHaveBeenCalled();
  });

  it("rejects malformed provider ids before registry dispatch", async () => {
    const json = vi.fn();
    const providers = { status: vi.fn() } as unknown as DirectorDccProviderRegistry;
    await handleDccRoute(request("GET"), response(), new URL("http://test/api/dcc/providers/Studio%2FUnsafe/status"), {
      readBody: vi.fn(),
      json,
      getProject: vi.fn(),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      providers,
    });
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      400,
      expect.objectContaining({ code: "dcc_provider_invalid" }),
    );
    expect(providers.status).not.toHaveBeenCalled();
  });

  it("exports a portable package through the selected provider descriptor", async () => {
    const json = vi.fn();
    const project = createTestDirectorProject();
    const descriptor = getDirectorDccProviderDescriptor("maya");
    const adapter = { descriptor, status: vi.fn() };
    const providers = {
      get: vi.fn().mockReturnValue(adapter),
      status: vi.fn().mockResolvedValue({
        provider: descriptor,
        installed: false,
        executable: null,
        version: null,
        nativeReady: false,
        exchangeReady: true,
        reason: null,
      }),
    } as unknown as DirectorDccProviderRegistry;
    const result = {
      contract: "director-dcc-exchange-result-v1",
      provider: "maya",
      packagePath: "/safe/package",
    };
    const exchangePackager = {
      exportPackage: vi.fn().mockResolvedValue(result),
    } as unknown as DirectorDccExchangePackager;

    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({
        input: { op: "export_exchange_package", provider: "maya", formats: ["usda"], frame: 24 },
      }),
      json,
      getProject: vi.fn().mockResolvedValue(project),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      providers,
      exchangePackager,
    });

    expect(exchangePackager.exportPackage).toHaveBeenCalledWith(project, {
      provider: "maya",
      descriptor,
      exchangeReady: true,
      formats: ["usda"],
      cameraId: undefined,
      frame: 24,
    });
    expect(json).toHaveBeenCalledWith(expect.anything(), 200, { success: true, result });
  });

  it("rejects an exchange export when the provider reports exchange as unavailable", async () => {
    const json = vi.fn();
    const descriptor = getDirectorDccProviderDescriptor("maya");
    const providers = {
      get: vi.fn().mockReturnValue({ descriptor, status: vi.fn() }),
      status: vi.fn().mockResolvedValue({
        provider: descriptor,
        installed: true,
        executable: "/Applications/Maya",
        version: null,
        nativeReady: false,
        exchangeReady: false,
        reason: "Exchange prerequisites are missing.",
      }),
    } as unknown as DirectorDccProviderRegistry;
    const exchangePackager = { exportPackage: vi.fn() } as unknown as DirectorDccExchangePackager;

    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({ input: { op: "export_exchange_package", provider: "maya" } }),
      json,
      getProject: vi.fn().mockResolvedValue(createTestDirectorProject()),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      providers,
      exchangePackager,
    });

    expect(exchangePackager.exportPackage).not.toHaveBeenCalled();
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      409,
      expect.objectContaining({ success: false, code: "dcc_exchange_unavailable" }),
    );
  });

  it("maps typed exchange validation and capacity errors to their HTTP status", async () => {
    const json = vi.fn();
    const descriptor = getDirectorDccProviderDescriptor("maya");
    const providers = {
      get: vi.fn().mockReturnValue({ descriptor, status: vi.fn() }),
      status: vi.fn().mockResolvedValue({
        provider: descriptor,
        installed: false,
        executable: null,
        version: null,
        nativeReady: false,
        exchangeReady: true,
        reason: null,
      }),
    } as unknown as DirectorDccProviderRegistry;
    const exchangePackager = {
      exportPackage: vi
        .fn()
        .mockRejectedValue(new DirectorDccExchangePackageError("Too many exports.", 429, "dcc_exchange_busy")),
    } as unknown as DirectorDccExchangePackager;

    await handleDccRoute(request("POST"), response(), new URL("http://test/api/tools/director_dcc"), {
      readBody: vi.fn().mockResolvedValue({ input: { op: "export_exchange_package", provider: "maya" } }),
      json,
      getProject: vi.fn().mockResolvedValue(createTestDirectorProject()),
      blender: { status: vi.fn(), exportBlend: vi.fn() },
      providers,
      exchangePackager,
    });

    expect(json).toHaveBeenCalledWith(expect.anything(), 429, {
      success: false,
      code: "dcc_exchange_busy",
      error: "Too many exports.",
    });
  });
});
