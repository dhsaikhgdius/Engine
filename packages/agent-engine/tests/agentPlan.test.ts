import { describe, expect, it } from "vitest";
import { validateDirectorAgentPlan } from "../src/agentPlan";
import { createDefaultScene } from "@director/stage-protocol";

const blenderSceneEpoch = "00000000-0000-4000-8000-000000000001";

describe("Director agent plans", () => {
  it("validates a multi-step plan against the same scene grammar exposed to MCP", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-1",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "新增主角并安排一段行走。",
        suggested_next: "再添加一个跟拍镜头。",
        operations: [
          {
            tool: "stage_object",
            summary: "新增主角",
            input: { op: "create", ref: "hero", kind: "humanoid", name: "主角", position: [1, 0, 0] },
          },
          {
            tool: "stage_object",
            summary: "让主角向前移动",
            input: { op: "translate", object_id: "hero", delta: [0, 0, -2] },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations).toHaveLength(2);
    expect(result.changedObjectIds).toContain("hero");
  });

  it("marks destructive edits for explicit confirmation", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-2",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "删除角色",
        operations: [
          {
            tool: "stage_object",
            summary: "删除人物",
            input: { op: "delete", object_ids: ["human-1"] },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.requiresConfirmation).toBe(true);
    expect(result.operations[0]?.requiresConfirmation).toBe(true);
  });

  it("rejects plans that reference missing objects", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-3",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "移动不存在的物体",
        operations: [
          {
            tool: "stage_object",
            summary: "移动",
            input: { op: "translate", object_id: "missing", delta: [1, 0, 0] },
          },
        ],
      },
    });

    expect(result).toMatchObject({ error: expect.stringContaining("cannot execute") });
  });

  it("supports a from-zero scene-to-video plan and gates costly submission", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-video",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "从零搭建街角白膜并提交视频渲染",
        operations: [
          {
            tool: "stage_scene",
            summary: "清空并创建主机位",
            input: { op: "reset", name: "街角白膜", with_camera: true },
          },
          {
            tool: "stage_object",
            summary: "搭建建筑体块",
            input: { op: "create", kind: "cube", scale: [4, 3, 2] },
          },
          {
            tool: "stage_video",
            summary: "提交视频模型渲染",
            input: { op: "render", prompt: "A cinematic street corner based on the precise white-box composition" },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations.map((operation) => operation.tool)).toContain("stage_video");
    expect(result.requiresConfirmation).toBe(true);
    expect(result.operations[2]?.requiresConfirmation).toBe(true);
  });

  it("accepts one semantic complete-workbench batch for Claude", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-workbench",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "添加主角和一台电影机位",
        operations: [
          {
            tool: "director_workbench",
            summary: "原子搭建角色与机位",
            input: {
              op: "author",
              actions: [
                { action: "add_object", id: "hero-1", name: "主角", kind: "character" },
                {
                  action: "add_camera",
                  id: "hero-camera",
                  object_id: "hero-camera-rig",
                  name: "主角中景",
                  position: [0, 1.4, 5],
                  target: [0, 0.9, 0],
                  target_object_id: "hero-1",
                  focal_length_mm: 50,
                },
              ],
            },
          },
        ],
      },
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]?.tool).toBe("director_workbench");
    expect(result.changedObjectIds).toEqual(expect.arrayContaining(["hero-1", "hero-camera-rig"]));
    expect(result.requiresConfirmation).toBe(false);
  });

  it("requires confirmation for destructive semantic authoring", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-workbench-delete",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "删除旧角色",
        operations: [
          {
            tool: "director_workbench",
            summary: "删除角色",
            input: {
              op: "author",
              actions: [{ action: "delete_objects", object_ids: ["char_default_a"], cascade: true }],
            },
          },
        ],
      },
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.requiresConfirmation).toBe(true);
  });

  it("accepts a mixed plan when every operation is valid", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-mixed",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "混合计划",
        operations: [
          {
            tool: "director_workbench",
            summary: "添加角色",
            input: { op: "author", actions: [{ action: "add_object", id: "hero-1", name: "主角", kind: "character" }] },
          },
          { tool: "stage_scene", summary: "验证", input: { op: "validate" } },
        ],
      },
    });
    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations).toHaveLength(2);
  });

  it("accepts an explicitly requested correction operation", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-correct",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "应用审计给出的确定性修正",
        operations: [
          {
            tool: "director_workbench",
            summary: "修正最近一次审计问题",
            input: {
              op: "correct",
              audit_token: "workbench-audit-3",
            },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]).toMatchObject({
      tool: "director_workbench",
      input: {
        op: "correct",
        audit_token: "workbench-audit-3",
      },
      requiresConfirmation: false,
    });
  });

  it("accepts a read-only Shot IR export as a safe workbench plan", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-shot-ir",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "导出第 48 帧机位描述",
        operations: [
          {
            tool: "director_workbench",
            summary: "导出 Shot IR",
            input: { op: "shot_ir", camera_id: "cam_1", frame: 48 },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]).toMatchObject({
      tool: "director_workbench",
      input: { op: "shot_ir", camera_id: "cam_1", frame: 48 },
      requiresConfirmation: false,
    });
  });

  it("accepts read-only packaged asset discovery as a safe workbench plan", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-character-catalog",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "查找可直接使用的本地角色",
        operations: [
          {
            tool: "director_workbench",
            summary: "搜索角色目录",
            input: { op: "catalog", catalog: "character_assets", query: "Abe", limit: 10 },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]).toMatchObject({
      tool: "director_workbench",
      input: { op: "catalog", catalog: "character_assets", query: "Abe", limit: 10 },
      requiresConfirmation: false,
    });
  });

  it("allows Gallery generation discovery but confirms provider jobs and durable promotion", () => {
    const discover = validateDirectorAgentPlan({
      id: "plan-generation-discover",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "查看可用音频工作流",
        operations: [
          {
            tool: "director_workbench",
            summary: "发现 ComfyUI 音频工作流",
            input: { op: "generation", command: { action: "workflows", media_kind: "audio" } },
          },
        ],
      },
    });
    expect(discover).not.toHaveProperty("error");
    if ("error" in discover) return;
    expect(discover.operations[0]?.requiresConfirmation).toBe(false);

    const submit = validateDirectorAgentPlan({
      id: "plan-generation-submit",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "提交雨声音效",
        operations: [
          {
            tool: "director_workbench",
            summary: "提交 ComfyUI 音频任务",
            input: {
              op: "generation",
              command: {
                action: "submit",
                kind: "audio.generate",
                workflow_id: "comfy-workflow-audio-main",
                prompt: "Soft rain against glass",
              },
            },
          },
        ],
      },
    });
    expect(submit).not.toHaveProperty("error");
    if ("error" in submit) return;
    expect(submit.operations[0]?.requiresConfirmation).toBe(true);
  });

  it("allows transcription discovery but confirms source upload and transcript promotion", () => {
    const discover = validateDirectorAgentPlan({
      id: "plan-transcription-discover",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "查看转录能力",
        operations: [
          {
            tool: "director_workbench",
            summary: "读取转录服务",
            input: { op: "transcription", command: { action: "capabilities" } },
          },
        ],
      },
    });
    expect(discover).not.toHaveProperty("error");
    if ("error" in discover) return;
    expect(discover.operations[0]?.requiresConfirmation).toBe(false);

    const submit = validateDirectorAgentPlan({
      id: "plan-transcription-submit",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "转录对白",
        operations: [
          {
            tool: "director_workbench",
            summary: "提交转录任务",
            input: {
              op: "transcription",
              command: {
                action: "submit",
                source_media_id: "creative-media:audio:dialogue",
              },
            },
          },
        ],
      },
    });
    expect(submit).not.toHaveProperty("error");
    if ("error" in submit) return;
    expect(submit.operations[0]?.requiresConfirmation).toBe(true);
  });

  it("accepts delivery only when it is explicitly planned", () => {
    const accepted = validateDirectorAgentPlan({
      id: "plan-deliver",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "导出主机位的视频生成控制包",
        operations: [
          {
            tool: "director_workbench",
            summary: "导出当前机位",
            input: {
              op: "deliver",
              camera_id: "cam_1",
              quality_profile: "video-gen",
              render_passes: ["clean", "depth", "normal", "object-id", "mask"],
            },
          },
        ],
      },
    });
    expect(accepted).not.toHaveProperty("error");
    if ("error" in accepted) return;
    expect(accepted.operations[0]).toMatchObject({
      tool: "director_workbench",
      input: { op: "deliver", camera_id: "cam_1" },
      requiresConfirmation: false,
    });

    const rejected = validateDirectorAgentPlan({
      id: "plan-deliver-stale",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "按默认设置导出",
        operations: [
          {
            tool: "director_workbench",
            summary: "导出默认控制包",
            input: { op: "deliver", quality_profile: "blocking" },
          },
        ],
      },
    });
    expect(rejected).not.toHaveProperty("error");
  });

  it("accepts a direct Canvas mutation for Claude", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-creative",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "在画布添加导演备注",
        operations: [
          {
            tool: "director_creative",
            summary: "添加备注节点",
            input: {
              op: "execute",
              operation: {
                op: "canvas.node.add",
                kind: "note",
                title: "镜头意图",
                body: "保持人物在画面右侧三分线",
                x: 120,
                y: 80,
              },
            },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]).toMatchObject({ tool: "director_creative", requiresConfirmation: false });
  });

  it("accepts a guarded Canvas pipeline start as one confirmable semantic operation", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-canvas-pipeline",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "运行已配置的 Canvas 生成图",
        operations: [
          {
            tool: "director_creative",
            summary: "启动 Canvas 流水线",
            input: {
              op: "pipeline",
              request: {
                action: "start",
                target_node_ids: ["image-1"],
                force_node_ids: [],
                max_parallel: 4,
                await_completion: false,
                expected_snapshot_fingerprint: "creative-revision:v1:2",
                idempotency_key: "plan-canvas-pipeline-v1",
              },
            },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result).toMatchObject({ requiresConfirmation: true });
    expect(result.operations[0]).toMatchObject({ tool: "director_creative", requiresConfirmation: true });
  });

  it("accepts a direct creative mutation without a synthetic snapshot guard", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-creative-stale",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "移动时间线游标",
        operations: [
          {
            tool: "director_creative",
            summary: "移动游标",
            input: { op: "execute", operation: { op: "edit.seek", seconds: 4 } },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]).toMatchObject({
      tool: "director_creative",
      input: { op: "execute", operation: { op: "edit.seek", seconds: 4 } },
    });
  });

  it.each([
    { name: "status", input: { op: "status" } },
    { name: "scene", input: { op: "scene" } },
    {
      name: "catalog",
      input: { op: "catalog", query: "bevel", scope: "modeling", availableOnly: true, limit: 12 },
    },
    { name: "describe", input: { op: "describe", operator: "mesh.bevel" } },
    {
      name: "inspect",
      input: {
        op: "inspect",
        id: "desk-a",
        expectedSceneEpoch: blenderSceneEpoch,
        expectedRevision: 3,
      },
    },
    { name: "capture", input: { op: "capture", cameraId: "camera-main", width: 640, height: 360 } },
  ])("accepts read-only Blender $name requests without confirmation", ({ name, input }) => {
    const result = validateDirectorAgentPlan({
      id: `plan-blender-${name}`,
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "读取 Blender 原生状态",
        operations: [
          {
            tool: "blender_native",
            summary: "读取原生状态",
            input,
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]).toMatchObject({ tool: "blender_native", requiresConfirmation: false });
    expect(result.changedObjectIds).toEqual([]);
  });

  it("accepts a native Blender modeling batch and reports every affected stable id", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-blender-model",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "用 Blender 原生操作搭建房间并复制桌子",
        operations: [
          {
            tool: "blender_native",
            summary: "执行原生白膜建模",
            input: {
              op: "apply",
              expectedSceneEpoch: blenderSceneEpoch,
              expectedRevision: 4,
              operations: [
                { op: "create_blockout", preset: "room", idPrefix: "room-main" },
                { op: "create_primitive", id: "desk-a", primitive: "cube" },
                { op: "duplicate_object", id: "desk-a", newId: "desk-b" },
                { op: "set_parent", id: "desk-b", parentId: "room-main-floor" },
                { op: "move_to_collection", ids: ["desk-a", "desk-b"], collection: "Set Dressing" },
              ],
            },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]?.requiresConfirmation).toBe(false);
    expect(result.changedObjectIds).toEqual(
      expect.arrayContaining(["room-main", "desk-a", "desk-b", "room-main-floor"]),
    );
  });

  it("accepts advanced Blender modeling, selection, RNA, history, and render operations", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-blender-advanced-modeling",
      agent: "codex",
      scene: createDefaultScene(),
      draft: {
        summary: "检查并细化 Blender 网格",
        operations: [
          {
            tool: "blender_native",
            summary: "执行高级原生建模",
            input: {
              op: "apply",
              expectedSceneEpoch: blenderSceneEpoch,
              expectedRevision: 7,
              operations: [
                { op: "discover_operators", query: "bevel", scope: "modeling", limit: 10 },
                { op: "describe_operator", operator: "mesh.bevel" },
                { op: "inspect_object", id: "desk-a" },
                { op: "set_selection", selectedIds: ["desk-a"], activeId: "desk-a", mode: "EDIT" },
                {
                  op: "select_mesh_elements",
                  id: "desk-a",
                  domain: "EDGE",
                  action: "SET",
                  indices: [0, 1, 2, 3],
                },
                {
                  op: "invoke_operator",
                  operator: "mesh.bevel",
                  properties: { offset: 0.08, segments: 3 },
                  context: { selectedIds: ["desk-a"], activeId: "desk-a", mode: "EDIT" },
                },
                {
                  op: "set_rna_property",
                  target: { kind: "object", objectId: "desk-a" },
                  path: ["display_type"],
                  value: "SOLID",
                },
                { op: "undo_scene" },
                { op: "redo_scene" },
                { op: "capture_render", cameraId: "camera-main", width: 640, height: 360 },
              ],
            },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result.operations[0]?.requiresConfirmation).toBe(false);
    expect(result.changedObjectIds).toEqual(expect.arrayContaining(["desk-a"]));
  });

  it("requires confirmation only when a native Blender apply batch explicitly deletes an object", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-blender-delete",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "删除 Blender 场景里的旧代理模型",
        operations: [
          {
            tool: "blender_native",
            summary: "删除旧代理模型",
            input: {
              op: "apply",
              expectedSceneEpoch: blenderSceneEpoch,
              expectedRevision: 8,
              operations: [{ op: "delete_object", id: "proxy-old" }],
            },
          },
        ],
      },
    });

    expect(result).not.toHaveProperty("error");
    if ("error" in result) return;
    expect(result).toMatchObject({ requiresConfirmation: true, changedObjectIds: ["proxy-old"] });
    expect(result.operations[0]?.requiresConfirmation).toBe(true);
  });

  it("rejects malformed native Blender operations through the shared contract", () => {
    const result = validateDirectorAgentPlan({
      id: "plan-blender-invalid",
      agent: "claude",
      scene: createDefaultScene(),
      draft: {
        summary: "执行无效原生操作",
        operations: [
          {
            tool: "blender_native",
            summary: "创建缺少 ID 的模型",
            input: {
              op: "apply",
              expectedSceneEpoch: blenderSceneEpoch,
              expectedRevision: 9,
              operations: [{ op: "create_primitive", primitive: "cube" }],
            },
          },
        ],
      },
    });

    expect(result).toMatchObject({ error: expect.stringContaining("blender_native input invalid") });
  });
});
