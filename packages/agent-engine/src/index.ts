/**
 * @director/agent-engine — barrel export.
 *
 * Only exports files safe for universal (Node + browser) consumption.
 * Files that import Zustand stores, React hooks, or browser-specific
 * APIs (import.meta.env, localStorage) are explicitly excluded.
 *
 * @module @director/agent-engine
 */

export * from "./agentIds";
export * from "./agentPlan";
export * from "./agentPlanFold";
export * from "./agentSceneRunProjection";
export * from "./agentRuntimeSchema";
export * from "./agentSessionSchema";
export * from "./agentSessionProjection";
export * from "./commandEngine";
export * from "./creativeWorkspaceAgentQuality";
export * from "./directorAudit";
export * from "./directorAuthoring";
export * from "./directorAutomation";
export * from "./directorBlocking";
export * from "./directorProceduralAuthoring";
export * from "./directorProjectGraph";
export * from "./directorSpatialAuthoring";
export * from "./directorSpatialGeometry";
export * from "./directorStageAdapter";
export * from "./directorWorkbenchContract";
export * from "./directorWorkbenchDescribe";
export * from "./directorWorkbenchObserve";
export * from "./directorDefaultProject";
export * from "./characterMotionCatalog";
export * from "./directorAgentAssetCatalog";
export * from "./jsonPatch";
export * from "./multiAgentRunSchema";
export * from "./stageCommandSchema";
export * from "./stageFeedback";
export * from "./videoModelContract";

// Browser workbench execution lives in frontend/director/src/agent/
// (gatewayClient, directorWorkbenchExecutor, creative workspace execute/observe,
// and the capture/generation workbench command handlers). Those modules may
// import this package; this package must not import the browser store.
