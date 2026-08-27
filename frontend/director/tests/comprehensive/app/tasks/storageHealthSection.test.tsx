import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(),
}));

vi.mock("../../../../src/comprehensive/editor/api/directorControlPlaneClient", () => ({
  directorControlPlaneFetch: mocks.fetch,
}));

import { StorageHealthSection } from "../../../../src/comprehensive/app/tasks/StorageHealthSection";
import {
  fetchStorageHealth,
  formatStorageBytes,
  planStorageGc,
  sweepStorageGc,
} from "../../../../src/comprehensive/app/tasks/storageHealthClient";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function healthBody(overrides: Record<string, unknown> = {}) {
  return {
    health: {
      contract: "director-storage-health-v1",
      generatedAt: "2026-08-25T12:00:00.000Z",
      backend: "filesystem",
      policy: {
        source: "default",
        minimumAgeHours: 24,
        rules: [],
        legalHold: { keys: 0, keyPrefixes: 0, jobIds: 0 },
      },
      usage: {
        jobArtifacts: { objects: 3, bytes: 3 * 1024 * 1024 },
        jobMetadata: { objects: 3, bytes: 2048 },
        stagedMediaInputs: { objects: 1, bytes: 512 * 1024 },
        total: { objects: 7, bytes: 3.5 * 1024 * 1024 + 2048 },
      },
      jobs: { total: 3, nonTerminal: 1, byStatus: { succeeded: 2, running: 1 } },
      sweepCandidates: { count: 2, bytes: 2048, byReason: { unreachable: 1, retentionExpired: 1 } },
      recentSweeps: [],
      capacity: {
        status: "measured",
        totalBytes: 100 * 1024 * 1024 * 1024,
        freeBytes: 40 * 1024 * 1024 * 1024,
        availableBytes: 38 * 1024 * 1024 * 1024,
        usedRatio: 0.6,
      },
      writeProbe: { status: "ok", probedAt: "2026-08-25T12:00:00.000Z", latencyMs: 4, bytesProbed: 48 },
      ...overrides,
    },
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("storageHealthClient", () => {
  it("fetches and validates the health report", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(200, healthBody()));
    const health = await fetchStorageHealth();
    expect(mocks.fetch).toHaveBeenCalledWith("/api/storage/health", { signal: undefined });
    expect(health.backend).toBe("filesystem");
    expect(health.sweepCandidates).toMatchObject({ count: 2, bytes: 2048 });
    expect(health.capacity).toMatchObject({ status: "measured", usedRatio: 0.6 });
    expect(health.writeProbe).toMatchObject({ status: "ok", latencyMs: 4, bytesProbed: 48 });
  });

  it("accepts reports from older gateways without live-check stanzas", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(200, healthBody({ capacity: undefined, writeProbe: undefined })));
    const health = await fetchStorageHealth();
    expect(health.capacity).toBeUndefined();
    expect(health.writeProbe).toBeUndefined();
  });

  it("accepts pre-deepen ok write probes that omit bytesProbed", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(
        200,
        healthBody({
          writeProbe: { status: "ok", probedAt: "2026-08-25T12:00:00.000Z", latencyMs: 4 },
        }),
      ),
    );
    const health = await fetchStorageHealth();
    expect(health.writeProbe).toMatchObject({ status: "ok", latencyMs: 4 });
    expect(health.writeProbe && "bytesProbed" in health.writeProbe ? health.writeProbe.bytesProbed : undefined).toBe(
      undefined,
    );
  });

  it("parses typed capacity omissions and write-probe failures", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(
        200,
        healthBody({
          backend: "object-storage",
          capacity: { status: "unavailable", code: "capacity_unsupported", reason: "no enumerable capacity" },
          writeProbe: {
            status: "failed",
            probedAt: "2026-08-25T12:00:00.000Z",
            latencyMs: 12,
            code: "put_failed",
            reason: "bucket is read-only",
          },
        }),
      ),
    );
    const health = await fetchStorageHealth();
    expect(health.capacity).toMatchObject({ status: "unavailable", code: "capacity_unsupported" });
    expect(health.writeProbe).toMatchObject({ status: "failed", code: "put_failed", reason: "bucket is read-only" });
  });

  it("surfaces gateway error messages", async () => {
    mocks.fetch.mockResolvedValueOnce(jsonResponse(409, { code: "gc_plan_expired", message: "计划已过期" }));
    await expect(sweepStorageGc("plan-1")).rejects.toThrow("计划已过期");
  });

  it("plans a dry run and echoes the plan id as the sweep confirmation", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        plan: {
          planId: "plan-9",
          plannedAt: "2026-08-25T12:00:00.000Z",
          expiresAt: "2026-08-25T12:15:00.000Z",
          examined: 5,
          sweep: { count: 2, bytes: 2048, byReason: { unreachable: 1, retentionExpired: 1 } },
        },
      }),
    );
    const plan = await planStorageGc();
    expect(plan.planId).toBe("plan-9");

    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        result: {
          planId: "plan-9",
          sweptAt: "2026-08-25T12:01:00.000Z",
          replayed: false,
          deletedCount: 2,
          reclaimedBytes: 2048,
          skippedCount: 0,
        },
      }),
    );
    const outcome = await sweepStorageGc(plan.planId);
    expect(outcome.deletedCount).toBe(2);
    expect(outcome.skippedByReason).toBeUndefined();
    const [path, init] = mocks.fetch.mock.calls.at(-1)!;
    expect(path).toBe("/api/storage/gc/sweep");
    expect(JSON.parse(String(init?.body))).toEqual({ planId: "plan-9", confirm: "plan-9" });
  });

  it("parses typed skip reason counts on sweep outcome and recentSweeps", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        result: {
          planId: "plan-skip",
          sweptAt: "2026-08-25T12:01:00.000Z",
          replayed: false,
          deletedCount: 1,
          reclaimedBytes: 1024,
          skippedCount: 2,
          skippedByReason: {
            becameReachable: 1,
            modifiedSincePlan: 1,
            alreadyAbsent: 0,
            deleteFailed: 0,
          },
          skipped: [
            { key: "jobs/a.bin", code: "became-reachable" },
            { key: "jobs/b.bin", code: "modified-since-plan" },
          ],
        },
      }),
    );
    const outcome = await sweepStorageGc("plan-skip");
    expect(outcome).toMatchObject({
      deletedCount: 1,
      skippedCount: 2,
      skippedByReason: { becameReachable: 1, modifiedSincePlan: 1, alreadyAbsent: 0, deleteFailed: 0 },
    });
    expect(outcome.skipped).toHaveLength(2);

    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(
        200,
        healthBody({
          recentSweeps: [
            {
              planId: "plan-skip",
              sweptAt: "2026-08-25T12:01:00.000Z",
              deletedCount: 1,
              reclaimedBytes: 1024,
              skippedCount: 2,
              skippedByReason: {
                becameReachable: 1,
                modifiedSincePlan: 1,
                alreadyAbsent: 0,
                deleteFailed: 0,
              },
            },
          ],
        }),
      ),
    );
    const health = await fetchStorageHealth();
    expect(health.recentSweeps[0]).toMatchObject({
      skippedCount: 2,
      skippedByReason: { becameReachable: 1, modifiedSincePlan: 1 },
    });
  });

  it("accepts older sweep outcomes and recentSweeps without skip reason stanzas", async () => {
    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(200, {
        result: {
          planId: "legacy-plan",
          sweptAt: "2026-08-25T12:01:00.000Z",
          replayed: false,
          deletedCount: 1,
          reclaimedBytes: 512,
          skippedCount: 0,
        },
      }),
    );
    const outcome = await sweepStorageGc("legacy-plan");
    expect(outcome.skippedByReason).toBeUndefined();
    expect(outcome.skipped).toBeUndefined();

    mocks.fetch.mockResolvedValueOnce(
      jsonResponse(
        200,
        healthBody({
          recentSweeps: [
            {
              planId: "legacy-plan",
              sweptAt: "2026-08-25T12:01:00.000Z",
              deletedCount: 1,
              reclaimedBytes: 512,
            },
          ],
        }),
      ),
    );
    const health = await fetchStorageHealth();
    expect(health.recentSweeps[0]?.skippedCount).toBeUndefined();
    expect(health.recentSweeps[0]?.skippedByReason).toBeUndefined();
  });

  it("formats byte counts compactly", () => {
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(512)).toBe("512 B");
    expect(formatStorageBytes(2048)).toBe("2.0 KB");
    expect(formatStorageBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatStorageBytes(250 * 1024 * 1024 * 1024)).toBe("250 GB");
  });
});

describe("StorageHealthSection", () => {
  it("renders health rows and runs the explicit plan → confirm sweep flow", async () => {
    const user = userEvent.setup();
    mocks.fetch.mockImplementation(async (path, init) => {
      if (path === "/api/storage/health") return jsonResponse(200, healthBody());
      if (path === "/api/storage/gc/plan") {
        return jsonResponse(200, {
          plan: {
            planId: "plan-42",
            plannedAt: "2026-08-25T12:00:00.000Z",
            expiresAt: "2026-08-25T12:15:00.000Z",
            examined: 7,
            sweep: { count: 2, bytes: 2048, byReason: { unreachable: 1, retentionExpired: 1 } },
          },
        });
      }
      if (path === "/api/storage/gc/sweep") {
        expect(JSON.parse(String(init?.body))).toEqual({ planId: "plan-42", confirm: "plan-42" });
        return jsonResponse(200, {
          result: {
            planId: "plan-42",
            sweptAt: "2026-08-25T12:01:00.000Z",
            replayed: false,
            deletedCount: 2,
            reclaimedBytes: 2048,
            skippedCount: 0,
          },
        });
      }
      throw new Error(`Unexpected path ${path}`);
    });

    render(<StorageHealthSection />);
    expect(await screen.findByText("产物占用")).toBeTruthy();
    expect(screen.getByText("3.0 MB")).toBeTruthy();
    // Candidate row mirrors typed byReason, not only the aggregate count.
    expect(screen.getByText("2 个对象（2.0 KB） · 不可达 1 · 保留期已过 1")).toBeTruthy();
    expect(screen.getByText("暂无清扫记录")).toBeTruthy();
    // The live checks render as measured numbers, not assumed health.
    expect(screen.getByText("剩余空间")).toBeTruthy();
    expect(screen.getByText("38.0 GB / 100 GB")).toBeTruthy();
    expect(screen.getByText("写入探针")).toBeTruthy();
    expect(screen.getByText("可写 · 4 ms · 已回读 48 B")).toBeTruthy();

    // Planning is a dry run: it reports candidates without deleting.
    await user.click(screen.getByRole("button", { name: "生成清扫计划（试运行）" }));
    expect(await screen.findByText("试运行完成，尚未删除任何对象。")).toBeTruthy();
    // Dry-run review surfaces plan.sweep.byReason before the confirm button.
    expect(screen.getByText("不可达 1 · 保留期已过 1")).toBeTruthy();
    expect(mocks.fetch.mock.calls.some(([path]) => path === "/api/storage/gc/sweep")).toBe(false);

    // The explicit confirm button names exactly what it deletes.
    await user.click(screen.getByRole("button", { name: "确认清扫 2 个对象（2.0 KB）" }));
    expect(await screen.findByText("已清扫 2 个对象，回收 2.0 KB")).toBeTruthy();
    // Clean sweeps do not invent a skip claim.
    expect(screen.queryByText(/跳过/)).toBeNull();
    // The section refreshed health after the sweep.
    const healthCalls = mocks.fetch.mock.calls.filter(([path]) => path === "/api/storage/health");
    expect(healthCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces typed skip reason counts after a partial sweep and on recentSweeps", async () => {
    const user = userEvent.setup();
    let healthCalls = 0;
    mocks.fetch.mockImplementation(async (path, init) => {
      if (path === "/api/storage/health") {
        healthCalls += 1;
        if (healthCalls === 1) {
          return jsonResponse(
            200,
            healthBody({
              recentSweeps: [
                {
                  planId: "plan-prior",
                  sweptAt: "2026-08-25T11:00:00.000Z",
                  deletedCount: 1,
                  reclaimedBytes: 512,
                  skippedCount: 1,
                  skippedByReason: {
                    becameReachable: 0,
                    modifiedSincePlan: 0,
                    alreadyAbsent: 1,
                    deleteFailed: 0,
                  },
                },
              ],
            }),
          );
        }
        return jsonResponse(
          200,
          healthBody({
            recentSweeps: [
              {
                planId: "plan-skip",
                sweptAt: "2026-08-25T12:01:00.000Z",
                deletedCount: 1,
                reclaimedBytes: 1024,
                skippedCount: 2,
                skippedByReason: {
                  becameReachable: 1,
                  modifiedSincePlan: 1,
                  alreadyAbsent: 0,
                  deleteFailed: 0,
                },
              },
            ],
          }),
        );
      }
      if (path === "/api/storage/gc/plan") {
        return jsonResponse(200, {
          plan: {
            planId: "plan-skip",
            plannedAt: "2026-08-25T12:00:00.000Z",
            expiresAt: "2026-08-25T12:15:00.000Z",
            examined: 4,
            sweep: { count: 3, bytes: 3072, byReason: { unreachable: 2, retentionExpired: 1 } },
          },
        });
      }
      if (path === "/api/storage/gc/sweep") {
        expect(JSON.parse(String(init?.body))).toEqual({ planId: "plan-skip", confirm: "plan-skip" });
        return jsonResponse(200, {
          result: {
            planId: "plan-skip",
            sweptAt: "2026-08-25T12:01:00.000Z",
            replayed: false,
            deletedCount: 1,
            reclaimedBytes: 1024,
            skippedCount: 2,
            skippedByReason: {
              becameReachable: 1,
              modifiedSincePlan: 1,
              alreadyAbsent: 0,
              deleteFailed: 0,
            },
          },
        });
      }
      throw new Error(`Unexpected path ${path}`);
    });

    render(<StorageHealthSection />);
    // Recent sweep row carries skip honesty, not delete-only copy.
    expect(await screen.findByText(/跳过 1 个 · 已不存在 1/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "生成清扫计划（试运行）" }));
    await user.click(screen.getByRole("button", { name: "确认清扫 3 个对象（3.0 KB）" }));
    expect(
      await screen.findByText("已清扫 1 个对象，回收 1.0 KB；跳过 2 个 · 重新可达 1 · 计划后已改写 1"),
    ).toBeTruthy();
    // Refreshed health replaces the prior recent-sweep skip summary.
    expect(screen.getByText(/1\.0 KB · 跳过 2 个 · 重新可达 1 · 计划后已改写 1/)).toBeTruthy();
  });

  it("renders typed capacity omissions and write-probe failures instead of hiding them", async () => {
    mocks.fetch.mockImplementation(async (path) => {
      if (path === "/api/storage/health") {
        return jsonResponse(
          200,
          healthBody({
            backend: "object-storage",
            capacity: { status: "unavailable", code: "capacity_unsupported", reason: "no enumerable capacity" },
            writeProbe: {
              status: "failed",
              probedAt: "2026-08-25T12:00:00.000Z",
              latencyMs: 12,
              code: "put_failed",
              reason: "bucket is read-only",
            },
          }),
        );
      }
      throw new Error(`Unexpected path ${path}`);
    });
    render(<StorageHealthSection />);
    expect(await screen.findByText("后端不支持容量测量")).toBeTruthy();
    const failure = screen.getByText("写入失败");
    expect(failure.getAttribute("title")).toBe("bucket is read-only");
    expect(failure.className).toContain("is-error");
  });

  it("claims nothing about capacity or writability when an older gateway omits the live checks", async () => {
    mocks.fetch.mockImplementation(async () =>
      jsonResponse(200, healthBody({ capacity: undefined, writeProbe: undefined })),
    );
    render(<StorageHealthSection />);
    await screen.findByText("产物占用");
    expect(screen.queryByText("剩余空间")).toBeNull();
    expect(screen.queryByText("写入探针")).toBeNull();
  });

  it("shows gateway refusals inline", async () => {
    mocks.fetch.mockImplementation(async (path) => {
      if (path === "/api/storage/health") return jsonResponse(200, healthBody());
      return jsonResponse(409, { code: "gc_plan_not_found", message: "计划不存在，请重新生成清扫计划" });
    });
    const user = userEvent.setup();
    render(<StorageHealthSection />);
    await screen.findByText("产物占用");
    await user.click(screen.getByRole("button", { name: "生成清扫计划（试运行）" }));
    expect(await screen.findByText("计划不存在，请重新生成清扫计划")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("试运行完成，尚未删除任何对象。")).toBeNull());
  });
});
