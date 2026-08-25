/**
 * @director/scene-pipeline — barrel export.
 *
 * Re-exports the scene plan, assemble, validate, pipeline, and stage
 * integration APIs in a single import target.
 *
 * @module @director/scene-pipeline
 */

export * from "./types";
export { planScene } from "./planner";
export { assembleScene, summarizePlan, computeBounds } from "./assembler";
export { validateScene, validateObject } from "./validator";
export {
  runScenePipeline,
  runCollaborativePipeline,
  summarizePipelineOutput,
} from "./pipeline";
export {
  applySceneToStage,
  executeScenePlan,
  summarizeWorkbenchOperations,
} from "./stageIntegration";
export type {
  DirectorAuthoringAction,
  DirectorWorkbenchAuthorOperation,
  WorkbenchExecutionResult,
  ScenePlanExecutionResult,
} from "./stageIntegration";