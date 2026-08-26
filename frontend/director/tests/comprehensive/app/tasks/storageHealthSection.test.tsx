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
    const [path, init] = mocks.fetch.mock.calls.at(-1)!;
    expect(path).toBe("/api/storage/gc/sweep");
    expect(JSON.parse(String(init?.body))).toEqual({ planId: "plan-9", confirm: "plan-9" });
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
    expect(screen.getByText("2 个对象（2.0 KB）")).toBeTruthy();
    expect(screen.getByText("暂无清扫记录")).toBeTruthy();

    // Planning is a dry run: it reports candidates without deleting.
    await user.click(screen.getByRole("button", { name: "生成清扫计划（试运行）" }));
    expect(await screen.findByText("试运行完成，尚未删除任何对象。")).toBeTruthy();
    expect(mocks.fetch.mock.calls.some(([path]) => path === "/api/storage/gc/sweep")).toBe(false);

    // The explicit confirm button names exactly what it deletes.
    await user.click(screen.getByRole("button", { name: "确认清扫 2 个对象（2.0 KB）" }));
    expect(await screen.findByText("已清扫 2 个对象，回收 2.0 KB")).toBeTruthy();
    // The section refreshed health after the sweep.
    const healthCalls = mocks.fetch.mock.calls.filter(([path]) => path === "/api/storage/health");
    expect(healthCalls.length).toBeGreaterThanOrEqual(2);
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
