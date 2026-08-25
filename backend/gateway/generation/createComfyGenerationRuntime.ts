import { isAbsolute, relative, resolve } from "node:path";
import type { DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import type { ProductionJobStore } from "../jobs/productionJobStore";
import { ComfyGenerationExecutor } from "./comfyGenerationExecutor";
import { ComfyNodePool } from "./comfyNodePool";
import { ComfyWorkflowStore, type ConfiguredComfyWorkflow } from "./comfyWorkflowStore";

function scopedWorkflowPath(workspaceRoot: string, configured: string) {
  const path = resolve(workspaceRoot, configured);
  const scoped = relative(workspaceRoot, path);
  if (scoped.startsWith("..") || isAbsolute(scoped)) {
    throw new Error("ComfyUI workflow paths must stay inside the Director workspace");
  }
  return path;
}

/**
 * Creates the ComfyUI generation runtime: node pool, workflow store, and executor.
 *
 * Wires together all components needed for submitting, polling, and
 * managing ComfyUI generation jobs. Configured workflows are discovered
 * from the control plane configuration.
 *
 * @param config - The Director control plane configuration.
 * @param dataDirectory - The data directory for workflow persistence.
 * @param productionJobs - The production job store for persisting job state.
 * @returns An object with the node pool, workflow store, and executor.
 */
export function createComfyGenerationRuntime(
  config: DirectorControlPlaneConfig,
  dataDirectory: string,
  productionJobs: ProductionJobStore,
) {
  const configuredWorkflows: ConfiguredComfyWorkflow[] = [];
  if (config.generation.comfyui.imageWorkflowPath) {
    configuredWorkflows.push({
      id: "comfy-workflow-configured-image",
      name: "Configured image workflow",
      path: scopedWorkflowPath(config.workspaceRoot, config.generation.comfyui.imageWorkflowPath),
      mediaKind: "image",
    });
  }
  if (config.generation.comfyui.videoWorkflowPath) {
    configuredWorkflows.push({
      id: "comfy-workflow-configured-video",
      name: "Configured video workflow",
      path: scopedWorkflowPath(config.workspaceRoot, config.generation.comfyui.videoWorkflowPath),
      mediaKind: "video",
    });
  }
  if (config.generation.comfyui.audioWorkflowPath) {
    configuredWorkflows.push({
      id: "comfy-workflow-configured-audio",
      name: "Configured audio workflow",
      path: scopedWorkflowPath(config.workspaceRoot, config.generation.comfyui.audioWorkflowPath),
      mediaKind: "audio",
    });
  }
  const nodes = new ComfyNodePool(dataDirectory, config.generation.comfyui.nodes);
  const workflows = new ComfyWorkflowStore(dataDirectory, configuredWorkflows);
  const executor = new ComfyGenerationExecutor(productionJobs, nodes, workflows, {
    pollIntervalMs: config.generation.comfyui.pollIntervalMs,
    timeoutMs: config.generation.comfyui.timeoutMs,
  });
  return { nodes, workflows, executor };
}
