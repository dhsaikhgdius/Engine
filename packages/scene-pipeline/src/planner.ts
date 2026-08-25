// Scene planner — converts natural language into a structured SceneLayout.
// Uses a ModelProvider (any LLM) to generate the layout via JSON mode.

import type { ModelProvider } from "@director/model-provider";
import type { SceneLayout, ScenePipelineInput, SceneValidationIssue } from "./types";

const SCENE_PLANNER_SYSTEM_PROMPT = `你是一个 3D 场景布局规划器。根据用户的描述，生成一个结构化的 3D 场景布局。

规则：
1. 房间尺寸默认为 8m × 8m × 3m，除非用户指定
2. 地板在 y=0，物体放在地板上(y≥0)
3. 物体不能重叠，间距至少 0.5m
4. 家具靠墙放置，通道留出空间
5. 颜色使用 hex 格式（如 "#e8d5b7"）
6. 每个物体都要有合理的标签

输出严格的 JSON 格式，不要包含任何其他文字。`;

const SCENE_PLANNER_USER_TEMPLATE = (input: ScenePipelineInput): string => {
  const parts: string[] = [];
  parts.push(`场景描述：${input.prompt}`);
  if (input.room) {
    parts.push(`房间尺寸：${input.room.width}m × ${input.room.depth}m × ${input.room.height}m`);
  }
  if (input.style) {
    parts.push(`风格：${input.style}`);
  }
  if (input.constraints?.length) {
    parts.push(`约束：${input.constraints.join("；")}`);
  }
  parts.push(`摄像机数量：${input.cameraCount ?? 1}`);
  parts.push(`
请生成 JSON 格式的场景布局，包含：
- name: 场景名称
- description: 简短描述
- room: { width, depth, height }
- objects: [{ id, label, kind, position: {x,y,z}, rotation: {x,y,z}, scale: {x,y,z}, color?, description? }]
- cameras: [{ position: {x,y,z}, target: {x,y,z}, focalLengthMm?, label? }]
- lights: [{ type, color?, intensity?, position?, direction? }]`);
  return parts.join("\n");
};

interface PlannerResult {
  layout: SceneLayout;
  rawResponse: string;
  warnings?: SceneValidationIssue[];
}

/**
 * Plan a scene layout using a model provider.
 */
export async function planScene(
  provider: ModelProvider,
  input: ScenePipelineInput,
): Promise<PlannerResult> {
  const startTime = Date.now();

  const result = await provider.chat(
    [
      { role: "system", content: SCENE_PLANNER_SYSTEM_PROMPT },
      { role: "user", content: SCENE_PLANNER_USER_TEMPLATE(input) },
    ],
    {
      temperature: 0.3,
      maxTokens: 4096,
    },
  );

  const elapsed = Date.now() - startTime;
  const warnings: SceneValidationIssue[] = [];

  // Parse the JSON response
  let layout: SceneLayout;
  try {
    layout = parseLayoutJson(result.content);
  } catch (err) {
    // Try to extract JSON from the response
    const jsonMatch = result.content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error(`Failed to parse scene layout JSON. Raw response: ${result.content.slice(0, 200)}`);
    }
    try {
      layout = parseLayoutJson(jsonMatch[0]);
    } catch (innerErr) {
      throw new Error(
        `Failed to parse scene layout JSON after extraction. Error: ${innerErr}. Raw: ${jsonMatch[0].slice(0, 200)}`,
      );
    }
  }

  // Apply defaults
  layout = applyDefaults(layout, input);

  // Warn about potential issues
  if (layout.objects.length === 0) {
    warnings.push({
      level: "warning",
      message: "场景中没有物体",
      suggestion: "请描述更具体的场景内容",
    });
  }
  if (layout.objects.length > 50) {
    warnings.push({
      level: "warning",
      message: `场景物体数量较多(${layout.objects.length}个)，可能影响性能`,
      suggestion: "考虑减少不重要的物体",
    });
  }

  return { layout, rawResponse: result.content, warnings: warnings.length ? warnings : undefined };
}

function parseLayoutJson(raw: string): SceneLayout {
  const parsed = JSON.parse(raw) as Record<string, unknown>;

  // Validate version
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(`Unsupported layout version: ${parsed.version}`);
  }

  return {
    version: 1,
    name: String(parsed.name ?? "未命名场景"),
    description: parsed.description ? String(parsed.description) : undefined,
    room: {
      width: Number((parsed.room as any)?.width ?? 8),
      depth: Number((parsed.room as any)?.depth ?? 8),
      height: Number((parsed.room as any)?.height ?? 3),
    },
    objects: Array.isArray(parsed.objects)
      ? parsed.objects.map((obj: any, i: number) => ({
          id: String(obj.id ?? `obj_${i}`),
          label: String(obj.label ?? `物体 ${i + 1}`),
          kind: validateKind(obj.kind),
          position: {
            x: Number(obj.position?.x ?? 0),
            y: Number(obj.position?.y ?? 0),
            z: Number(obj.position?.z ?? 0),
          },
          rotation: {
            x: Number(obj.rotation?.x ?? 0),
            y: Number(obj.rotation?.y ?? 0),
            z: Number(obj.rotation?.z ?? 0),
          },
          scale: {
            x: Number(obj.scale?.x ?? 1),
            y: Number(obj.scale?.y ?? 1),
            z: Number(obj.scale?.z ?? 1),
          },
          color: obj.color ? String(obj.color) : undefined,
          parentId: obj.parentId ? String(obj.parentId) : undefined,
          description: obj.description ? String(obj.description) : undefined,
        }))
      : [],
    cameras: Array.isArray(parsed.cameras)
      ? parsed.cameras.map((cam: any) => ({
          position: { x: Number(cam.position?.x ?? 0), y: Number(cam.position?.y ?? 1.6), z: Number(cam.position?.z ?? 0) },
          target: { x: Number(cam.target?.x ?? 0), y: Number(cam.target?.y ?? 1), z: Number(cam.target?.z ?? 0) },
          focalLengthMm: cam.focalLengthMm ? Number(cam.focalLengthMm) : undefined,
          label: cam.label ? String(cam.label) : undefined,
        }))
      : [],
    lights: Array.isArray(parsed.lights)
      ? parsed.lights.map((light: any) => ({
          type: validateLightType(light.type),
          color: light.color ? String(light.color) : undefined,
          intensity: light.intensity ? Number(light.intensity) : undefined,
          position: light.position
            ? { x: Number(light.position.x), y: Number(light.position.y), z: Number(light.position.z) }
            : undefined,
          direction: light.direction
            ? { x: Number(light.direction.x), y: Number(light.direction.y), z: Number(light.direction.z) }
            : undefined,
        }))
      : [],
  };
}

function validateKind(kind: unknown): SceneLayout["objects"][0]["kind"] {
  const valid = ["floor", "wall", "ceiling", "door", "window", "furniture", "light", "prop", "character", "camera", "custom"];
  if (typeof kind === "string" && valid.includes(kind)) {
    return kind as SceneLayout["objects"][0]["kind"];
  }
  return "prop";
}

function validateLightType(type: unknown): "ambient" | "directional" | "point" | "spot" {
  const valid = ["ambient", "directional", "point", "spot"];
  if (typeof type === "string" && valid.includes(type)) {
    return type as "ambient" | "directional" | "point" | "spot";
  }
  return "ambient";
}

function applyDefaults(layout: SceneLayout, input: ScenePipelineInput): SceneLayout {
  if (input.room) {
    layout.room = { ...input.room };
  }
  // Ensure camera count
  if (input.cameraCount && input.cameraCount > 0 && (!layout.cameras || layout.cameras.length === 0)) {
    const room = layout.room;
    layout.cameras = [{
      position: { x: room.width / 2, y: 1.6, z: room.depth + 2 },
      target: { x: room.width / 2, y: 1, z: room.depth / 2 },
      focalLengthMm: 35,
      label: "主视角",
    }];
  }
  return layout;
}