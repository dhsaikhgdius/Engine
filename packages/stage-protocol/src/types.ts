/**
 * Public type surface of @director/stage-protocol.
 *
 * Re-exports the scene document types plus the agent-facing execution result
 * so downstream packages (gateway tools, frontend runtime, scene pipeline)
 * can depend on one import path instead of reaching into sceneSchema.
 */
import type { StageScene } from "./sceneSchema";
import type { StageAgentEventWire } from "@director/protocol/agentGatewayProtocol";

export type { AgentToolName, StageCommandToolName } from "@director/protocol/agentTools";

export type {
  BaseStageObject,
  CameraFollowItem,
  CameraMoveItem,
  CameraObject,
  CameraPathItem,
  CameraStillItem,
  CameraTransformItem,
  ClipItem,
  GroupObject,
  HumanoidObject,
  ImageReferenceObject,
  ItemBase,
  PathItem,
  PrimitiveObject,
  PropObject,
  StageItem,
  StageObject,
  StageObjectKind,
  StageScene,
  StageTrack,
  TargetObject,
  TransformItem,
  TransformKeyframe,
  Vec3,
} from "./sceneSchema";

/** Re-exported agent event wire type from the gateway protocol. */
export type StageAgentEvent = StageAgentEventWire;

/**
 * The result of executing a single tool against the Stage scene.
 *
 * Executors always return the resulting scene — on failure it is the
 * unmodified input — so callers can treat the scene as the single source of
 * truth without branching on success first.
 */
export interface ToolExecution {
  /** The scene after the tool ran; identical to the input scene when `success` is false. */
  scene: StageScene;
  success: boolean;
  /** Tool-specific payload (e.g. created ids, observations); shape is defined per tool. */
  result?: unknown;
  /** Human-readable failure reason; present exactly when `success` is false. */
  error?: string;
  /** Wire events to broadcast to connected workbench clients (e.g. selection, highlights). */
  events?: StageAgentEvent[];
}
