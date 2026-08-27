// @vitest-environment node
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { directorWorkbenchOperationSchema } from "../../packages/agent-engine/src/directorWorkbenchContract";
import { creativeWorkspaceAgentRequestSchema } from "../../packages/protocol/src/creativeWorkspaceProtocol";
import { videoModelOperationSchema } from "../../packages/protocol/src/videoGenerationProtocol";
import { blenderNativeToolRequestSchema } from "../../packages/protocol/src/blenderLiveProtocol";
import { directorGameOperationSchema } from "../../packages/protocol/src/directorGameProtocol";
import { directorDccOperationSchema } from "../../packages/dcc-protocol/src/directorDccContract";

const tasksDirectory = join(dirname(fileURLToPath(import.meta.url)), "tasks");
const schemas = {
  director_workbench: directorWorkbenchOperationSchema,
  director_creative: creativeWorkspaceAgentRequestSchema,
  stage_video: videoModelOperationSchema,
  blender_native: blenderNativeToolRequestSchema,
  director_dcc: directorDccOperationSchema,
  director_game: directorGameOperationSchema,
} as const;

type GoldenTask = {
  name: string;
  description: string;
  steps: Array<{
    label: string;
    tool: keyof typeof schemas;
    /** Optional per-step agent session identity (e.g. the possessing session). */
    session_id?: string;
    /** The gateway possession preflight fills this input's omitted character target before validation. */
    gateway_fills_target?: boolean;
    /** Retry budget for steps waiting on asynchronous readiness (e.g. the live player session). */
    retry?: { attempts: number; delay_ms?: number };
    input: unknown;
    expect: { success: boolean };
  }>;
};

describe("Agent golden tasks", () => {
  it("uses known tools and valid contracts for every expected-success step", async () => {
    const files = (await readdir(tasksDirectory)).filter((file) => file.endsWith(".json")).sort();
    const tasks = await Promise.all(
      files.map(async (file) => JSON.parse(await readFile(join(tasksDirectory, file), "utf8")) as GoldenTask),
    );

    expect(new Set(tasks.map((task) => task.name)).size).toBe(tasks.length);
    for (const task of tasks) {
      expect(task.name).not.toBe("");
      expect(task.description).not.toBe("");
      expect(task.steps.length).toBeGreaterThan(0);
      expect(new Set(task.steps.map((step) => step.label)).size).toBe(task.steps.length);
      for (const step of task.steps) {
        expect(Object.hasOwn(schemas, step.tool), `${task.name}: unknown tool ${step.tool}`).toBe(true);
        if (!step.expect.success) continue;
        const parses = schemas[step.tool].safeParse(step.input).success;
        if (step.gateway_fills_target) {
          // Deliberately incomplete input: the gateway fills the omitted
          // character target from the possession preflight before validation.
          expect(parses, `${task.name}: ${step.label} no longer needs gateway fill-in`).toBe(false);
        } else {
          expect(parses, `${task.name}: invalid ${step.label}`).toBe(true);
        }
      }
    }
  });
});
