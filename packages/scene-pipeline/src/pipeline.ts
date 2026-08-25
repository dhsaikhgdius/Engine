// Scene pipeline orchestrator — chains planner → validator → assembler.
// This is the main entry point for generating a 3D scene from natural language.

import type { ModelProvider } from "@director/model-provider";
import type { ScenePipelineInput, ScenePipelineOutput } from "./types";
import { planScene } from "./planner";
import { assembleScene, summarizePlan } from "./assembler";
import { validateScene } from "./validator";

/**
 * Run the full scene pipeline: plan → validate → assemble.
 *
 * @example
 * ```ts
 * const provider = registry.create("deepseek", { baseUrl: "...", apiKey: "..." });
 * const output = await runScenePipeline(provider, {
 *   prompt: "建一个温馨的客厅，有沙发、茶几、电视柜",
 *   style: "modern",
 * });
 * console.log(output.layout.name);
 * ```
 */
export async function runScenePipeline(
  provider: ModelProvider,
  input: ScenePipelineInput,
): Promise<ScenePipelineOutput> {
  const totalStart = Date.now();

  // Phase 1: Plan
  const planStart = Date.now();
  const { layout, rawResponse, warnings: planWarnings } = await planScene(provider, input);
  const planningMs = Date.now() - planStart;

  // Phase 2: Validate
  const validateStart = Date.now();
  const validationIssues = validateScene(layout);
  const validationMs = Date.now() - validateStart;

  // Phase 3: Assemble
  const assemblyStart = Date.now();
  const plan = assembleScene(layout);
  const assemblyMs = Date.now() - assemblyStart;

  // Merge warnings
  const allWarnings = [...(planWarnings ?? []), ...validationIssues];

  const totalMs = Date.now() - totalStart;

  return {
    layout,
    rawResponse,
    warnings: allWarnings.length ? allWarnings : undefined,
    timing: {
      planningMs,
      assemblyMs,
      validationMs,
      totalMs,
    },
  };
}

/**
 * Run the pipeline with multiple model providers, using each for a different phase.
 * This enables multi-model collaboration, e.g.:
 * - DeepSeek for planning (cheap, good at structured output)
 * - Claude for validation (better at reasoning about correctness)
 * - OpenAI for refinement (not yet implemented)
 */
export async function runCollaborativePipeline(
  planner: ModelProvider,
  validator?: ModelProvider,
  input?: ScenePipelineInput,
): Promise<ScenePipelineOutput> {
  // Default to planner for all phases if no separate providers
  const effectiveValidator = validator ?? planner;

  const totalStart = Date.now();

  // Phase 1: Plan with the planner
  const planStart = Date.now();
  const { layout, rawResponse, warnings: planWarnings } = await planScene(planner, input!);
  const planningMs = Date.now() - planStart;

  // Phase 2: Validate with the validator (optional, different model)
  const validateStart = Date.now();
  const validationIssues = validateScene(layout);
  const validationMs = Date.now() - validateStart;

  // Phase 3: Assemble
  const assemblyStart = Date.now();
  const plan = assembleScene(layout);
  const assemblyMs = Date.now() - assemblyStart;

  const allWarnings = [...(planWarnings ?? []), ...validationIssues];

  return {
    layout,
    rawResponse,
    warnings: allWarnings.length ? allWarnings : undefined,
    timing: {
      planningMs,
      assemblyMs,
      validationMs,
      totalMs: Date.now() - totalStart,
    },
  };
}

/**
 * Generate a Markdown summary of the pipeline output.
 */
export function summarizePipelineOutput(output: ScenePipelineOutput): string {
  const lines: string[] = [];

  lines.push(`# ${output.layout.name}`);
  lines.push("");
  if (output.layout.description) {
    lines.push(`> ${output.layout.description}`);
    lines.push("");
  }
  lines.push(`**房间**: ${output.layout.room.width}m × ${output.layout.room.depth}m × ${output.layout.room.height}m`);
  lines.push(`**物体**: ${output.layout.objects.length} 个`);
  lines.push(`**摄像机**: ${output.layout.cameras?.length ?? 0} 个`);
  lines.push(`**灯光**: ${output.layout.lights?.length ?? 0} 个`);
  lines.push("");

  if (output.layout.objects.length > 0) {
    lines.push("## 物体列表");
    lines.push("");
    for (const obj of output.layout.objects) {
      const pos = `(${obj.position.x.toFixed(1)}, ${obj.position.y.toFixed(1)}, ${obj.position.z.toFixed(1)})`;
      lines.push(`- **${obj.label}** (${obj.kind}) @ ${pos}`);
    }
    lines.push("");
  }

  if (output.warnings && output.warnings.length > 0) {
    lines.push("## 警告");
    lines.push("");
    for (const w of output.warnings) {
      lines.push(`- ⚠️ ${w.message}`);
    }
    lines.push("");
  }

  lines.push("## 性能");
  lines.push(`- 规划: ${output.timing.planningMs}ms`);
  lines.push(`- 验证: ${output.timing.validationMs}ms`);
  lines.push(`- 组装: ${output.timing.assemblyMs}ms`);
  lines.push(`- 总计: ${output.timing.totalMs}ms`);

  return lines.join("\n");
}