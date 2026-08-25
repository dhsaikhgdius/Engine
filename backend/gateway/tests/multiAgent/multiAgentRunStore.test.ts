// @vitest-environment node

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { productionRunSchema, type ProductionRun } from "@director/agent-engine";
import { MultiAgentRunStore } from "../../multiAgent/multiAgentRunStore";

const directories: string[] = [];

const TARGET = {
  token: "target-token",
  client_id: "browser-client",
  instance_id: "director-instance",
  scene_id: "scene-1",
  creative_scope_id: "scope-1",
  contract_version: 2 as const,
};

function createStore() {
  const directory = mkdtempSync(resolve(tmpdir(), "director-production-runs-"));
  directories.push(directory);
  return { directory, store: new MultiAgentRunStore(directory) };
}

function createRun(id = "run-atomic-store"): ProductionRun {
  const now = new Date().toISOString();
  return productionRunSchema.parse({
    version: 1,
    id,
    objective: "Prove that concurrent durable updates never lose an artifact.",
    provider: "api",
    profileId: "api-default",
    status: "queued",
    target: TARGET,
    createdAt: now,
    updatedAt: now,
    activeNodeId: null,
    nodes: [
      {
        id: "node-01-showrunner",
        roleId: "showrunner",
        sessionId: null,
        status: "pending",
        attempt: 0,
        startedAt: null,
        completedAt: null,
        inputArtifactIds: [],
        outputArtifactIds: [],
        error: null,
      },
    ],
    artifacts: [],
  });
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MultiAgentRunStore", () => {
  it("reads legacy v1 snapshots and migrates every node to the fallback profile", async () => {
    const { directory, store } = createStore();
    const id = "run-legacy-profile";
    const legacy = structuredClone(createRun(id)) as unknown as Record<string, unknown>;
    legacy.version = 1;
    delete legacy.profileByRole;
    legacy.nodes = (legacy.nodes as Array<Record<string, unknown>>).map((node) => {
      const copy = { ...node };
      delete copy.profileId;
      return copy;
    });
    const runDirectory = resolve(directory, "multi-agent-runs");
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(resolve(runDirectory, `${id}.json`), JSON.stringify(legacy), "utf8");

    await expect(store.get(id)).resolves.toMatchObject({
      version: 2,
      profileByRole: { showrunner: "api-default" },
      nodes: [{ roleId: "showrunner", profileId: "api-default" }],
    });
  });

  it("serializes concurrent transforms and atomically persists a schema-valid snapshot", async () => {
    const { directory, store } = createStore();
    const run = await store.create(createRun());

    await Promise.all(
      Array.from({ length: 24 }, (_, index) =>
        store.update(run.id, async (current) => {
          // Vary transform latency so this test detects read-modify-write races rather than
          // accidentally relying on invocation order.
          await new Promise((resolveDelay) => setTimeout(resolveDelay, index % 4));
          return {
            ...current,
            artifacts: [
              ...current.artifacts,
              {
                id: `artifact-${String(index).padStart(2, "0")}`,
                kind: "role-report" as const,
                roleId: "showrunner" as const,
                payload: { index },
                createdAt: new Date().toISOString(),
              },
            ],
          };
        }),
      ),
    );

    const persisted = await store.get(run.id);
    expect(persisted?.artifacts).toHaveLength(24);
    expect(new Set(persisted?.artifacts.map((artifact) => artifact.id)).size).toBe(24);

    const runDirectory = resolve(directory, "multi-agent-runs");
    expect(readdirSync(runDirectory)).toEqual([`${run.id}.json`]);
    expect(
      productionRunSchema.parse(JSON.parse(readFileSync(resolve(runDirectory, `${run.id}.json`), "utf8"))),
    ).toEqual(persisted);

    // A fresh store instance must observe the same durable state; correctness cannot
    // depend on the in-memory update lock.
    expect(await new MultiAgentRunStore(directory).get(run.id)).toEqual(persisted);
  });
});
