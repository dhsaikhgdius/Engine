import { describe, expect, it, vi } from "vitest";
import type { ProductionRecord } from "../../gatewaySchemas";
import { ProductionMutationCoordinator, ProductionMutationError } from "../../production/productionMutationCoordinator";

function production(): ProductionRecord {
  return {
    productionId: "main",
    revision: 4,
    updatedAt: null,
    updatedBy: null,
    production: {
      version: 1,
      title: "Production",
      activeSceneId: "scene-a",
      scenes: [{ sceneId: "scene-a", title: "Scene A", sourceRevision: 2, createdAt: "2026-08-01T00:00:00Z" }],
      editorialTimeline: [],
    },
  };
}

describe("ProductionMutationCoordinator", () => {
  it("commits one revision and replays an exact idempotent retry without committing again", async () => {
    const coordinator = new ProductionMutationCoordinator(() => "2026-08-02T00:00:00Z");
    const commit = vi.fn(async () => undefined);
    const request = {
      expectedRevision: 4,
      actor: "agent:director",
      idempotencyKey: "scene-create-0001",
      operations: [
        { op: "add_scene_reference" as const, sceneId: "scene-b", title: "Scene B" },
        { op: "set_active_scene" as const, sceneId: "scene-b" },
      ],
    };

    const first = await coordinator.execute(production(), request, commit);
    const replay = await coordinator.execute(first.record, request, commit);

    expect(first.replayed).toBe(false);
    expect(first.record.revision).toBe(5);
    expect(first.record.production.activeSceneId).toBe("scene-b");
    expect(replay).toEqual({ record: first.record, replayed: true });
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rejects stale revisions and changed payloads reusing a key", async () => {
    const coordinator = new ProductionMutationCoordinator();
    const commit = vi.fn(async () => undefined);
    await expect(
      coordinator.execute(
        production(),
        {
          expectedRevision: 3,
          actor: "agent:director",
          operations: [{ op: "rename_production", title: "Stale" }],
        },
        commit,
      ),
    ).rejects.toMatchObject({ code: "stale_production_revision" });

    await coordinator.execute(
      production(),
      {
        expectedRevision: 4,
        actor: "agent:director",
        idempotencyKey: "rename-production-1",
        operations: [{ op: "rename_production", title: "First" }],
      },
      commit,
    );
    await expect(
      coordinator.execute(
        production(),
        {
          expectedRevision: 4,
          actor: "agent:director",
          idempotencyKey: "rename-production-1",
          operations: [{ op: "rename_production", title: "Different" }],
        },
        commit,
      ),
    ).rejects.toMatchObject({ code: "idempotency_key_conflict" });
  });

  it("keeps semantic failures atomic", async () => {
    const coordinator = new ProductionMutationCoordinator();
    const current = production();
    const commit = vi.fn(async () => undefined);
    await expect(
      coordinator.execute(
        current,
        {
          expectedRevision: 4,
          actor: "agent:director",
          operations: [{ op: "set_active_scene", sceneId: "missing" }],
        },
        commit,
      ),
    ).rejects.toBeInstanceOf(ProductionMutationError);
    expect(current).toEqual(production());
    expect(commit).not.toHaveBeenCalled();
  });

  it("serializes concurrent writers and rechecks the live revision inside the queue", async () => {
    const coordinator = new ProductionMutationCoordinator(() => "2026-08-02T00:00:00Z");
    let current = production();
    const commit = vi.fn(async (next: ProductionRecord) => {
      current = structuredClone(next);
    });
    const first = coordinator.execute(
      () => structuredClone(current),
      {
        expectedRevision: 4,
        actor: "agent:first",
        operations: [{ op: "rename_production", title: "First" }],
      },
      commit,
    );
    const second = coordinator.execute(
      () => structuredClone(current),
      {
        expectedRevision: 4,
        actor: "agent:second",
        operations: [{ op: "rename_production", title: "Second" }],
      },
      commit,
    );

    await expect(first).resolves.toMatchObject({ record: { revision: 5 } });
    await expect(second).rejects.toMatchObject({ code: "stale_production_revision" });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(current.production.title).toBe("First");
  });
});
