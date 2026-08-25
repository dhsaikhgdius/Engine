import { afterEach, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: transport.fetch,
}));

import {
  applyDirectorDccImportPlan,
  previewDirectorDccReturnPackage,
} from "../../../../src/comprehensive/editor/api/dccReturnClient";

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

afterEach(() => vi.clearAllMocks());

it("returns a conflict-bearing preview instead of hiding the import plan", async () => {
  transport.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: false,
        code: "stale_source_revision",
        result: {
          ready: false,
          dry_run: true,
          summary: { operation_count: 0, skipped_count: 0, conflict_count: 1, warning_count: 0 },
          plan: {
            ...plan,
            ready: false,
            conflicts: [{ directorId: "project", code: "stale_source_revision", reason: "Project changed." }],
          },
        },
      }),
      { status: 409, headers: { "content-type": "application/json" } },
    ),
  );
  const preview = await previewDirectorDccReturnPackage("job-1/return-package");
  expect(preview.ready).toBe(false);
  expect(preview.plan.conflicts[0]?.code).toBe("stale_source_revision");
});

it("sends revision and deterministic idempotency guards when applying", async () => {
  transport.fetch.mockResolvedValue(
    new Response(JSON.stringify({ success: true, result: { plan, authoring: null, copiedAssets: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  await applyDirectorDccImportPlan(plan);
  const init = transport.fetch.mock.calls[0]![1] as RequestInit;
  const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> };
  expect(body).toMatchObject({
    input: {
      op: "apply_import_plan",
      expected_revision: plan.targetRevision,
      idempotency_key: `blender-return-return-1-${"a".repeat(12)}`,
    },
  });
  // Blender remains the default provider and is omitted from the wire payload.
  expect(body.input).not.toHaveProperty("provider");
});

it("previews engine return packages through receive_from_engine with the provider", async () => {
  transport.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        result: {
          ready: true,
          provider: "unreal",
          dry_run: true,
          summary: { operation_count: 1, skipped_count: 0, conflict_count: 0, warning_count: 0 },
          plan,
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  const preview = await previewDirectorDccReturnPackage("job-ue/return-package", "unreal");
  expect(preview.ready).toBe(true);
  const init = transport.fetch.mock.calls[0]![1] as RequestInit;
  expect(JSON.parse(String(init.body))).toEqual({
    input: { op: "receive_from_engine", provider: "unreal", package_dir: "job-ue/return-package", dry_run: true },
  });
});

it("applies engine plans with the provider and a provider-scoped idempotency key", async () => {
  transport.fetch.mockResolvedValue(
    new Response(
      JSON.stringify({ success: true, result: { provider: "godot", plan, authoring: null, copiedAssets: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  );
  await applyDirectorDccImportPlan(plan, "godot");
  const init = transport.fetch.mock.calls[0]![1] as RequestInit;
  expect(JSON.parse(String(init.body))).toMatchObject({
    input: {
      op: "apply_import_plan",
      provider: "godot",
      expected_revision: plan.targetRevision,
      idempotency_key: `godot-return-return-1-${"a".repeat(12)}`,
    },
  });
});
