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

/** The result of executing a single tool against the Stage scene. */
export interface ToolExecution {
  scene: StageScene;
  success: boolean;
  result?: unknown;
  error?: string;
  events?: StageAgentEvent[];
}
