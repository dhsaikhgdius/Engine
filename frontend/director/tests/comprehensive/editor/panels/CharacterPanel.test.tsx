import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useBlenderRuntimeStore } from "../../../../src/comprehensive/editor/runtime/blenderRuntimeStore";
import { CharacterPanel } from "../../../../src/comprehensive/editor/panels/CharacterPanel";

vi.mock("../../../../src/comprehensive/editor/assistant/agentProfilesClient", () => ({
  listAgentProfiles: vi.fn().mockResolvedValue([
    {
      id: "profile-claude",
      label: "Claude Harness",
      runtime: "claude-agent",
      model: "claude",
      endpointHost: null,
      credentialConfigured: true,
      available: true,
      capabilities: { vision: true, video: false },
    },
  ]),
}));

beforeEach(() => {
  useBlenderRuntimeStore.getState().reset();
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    selectedObjectId: "char_default_a",
  });
});

it("renders the approved role property order", () => {
  render(<CharacterPanel />);

  expect(screen.getByLabelText("角色名称")).toBeInTheDocument();
  expect(screen.getByLabelText("角色位置 X")).toBeInTheDocument();
  expect(screen.getByLabelText("角色旋转 X")).toBeInTheDocument();
  expect(screen.getByLabelText("角色缩放 X")).toBeInTheDocument();
  expect(screen.getByLabelText("角色统一缩放")).toBeInTheDocument();
  expect(screen.getByLabelText("角色颜色")).toBeInTheDocument();
});

it("keeps character creation-only body type controls out of the role property panel", () => {
  render(<CharacterPanel />);

  const content = document.querySelector(".right-inspector-content");
  expect(content).toBeInTheDocument();

  const labels = Array.from(content?.querySelectorAll(".inspector-field-label, .inspector-section h3") ?? []).map(
    (item) => item.textContent?.trim(),
  );

  expect(labels).toEqual([
    "基本信息",
    "名称",
    "变换",
    "位置",
    "旋转",
    "缩放",
    "放置",
    "外观",
    "统一缩放",
    "颜色",
    "绑定 Agent",
    "Agent Profile",
    "Session ID",
  ]);
  expect(screen.queryByText("体型")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "二头身" })).not.toBeInTheDocument();
});

it("rounds axis fields for display while keeping full precision in the store", () => {
  const rawPosition: [number, number, number] = [-0.27194793279678464, 0.14629092015680736, 0.8981588299961127];

  useDirectorStore.setState((state) => ({
    ...state,
    project: {
      ...state.project,
      objects: state.project.objects.map((object) =>
        object.id === "char_default_a"
          ? { ...object, transform: { ...object.transform, position: rawPosition } }
          : object,
      ),
    },
  }));

  render(<CharacterPanel />);

  expect(screen.getByLabelText("角色位置 X")).toHaveValue(-0.272);
  expect(screen.getByLabelText("角色位置 Y")).toHaveValue(0.146);
  expect(screen.getByLabelText("角色位置 Z")).toHaveValue(0.898);

  const stored = useDirectorStore.getState().project.objects.find((object) => object.id === "char_default_a");
  expect(stored?.transform.position).toEqual(rawPosition);
});

it("keeps role axis labels exactly 10px above their coordinate rows", () => {
  render(<CharacterPanel />);

  ["位置", "旋转", "缩放"].forEach((label) => {
    const group = screen.getByRole("group", { name: label });

    expect(group).toHaveClass("inspector-axis-group");
    expect(group.tagName).toBe("DIV");
  });
});

it("uses the provided right inspector layout for role properties", () => {
  const { container } = render(<CharacterPanel />);

  expect(screen.getByLabelText("角色右侧属性面板")).toHaveClass("right-inspector", "character-inspector");
  expect(container.querySelector(".right-inspector-header")).toBeInTheDocument();
  expect(container.querySelector(".right-inspector-tabs")).toBeInTheDocument();
  expect(container.querySelector(".right-inspector-content")).toBeInTheDocument();

  const positionX = screen.getByLabelText("角色位置 X").closest(".inspector-axis-input");
  const colorRow = screen.getByLabelText("角色颜色 HEX").closest(".inspector-color-row");

  expect(positionX).toBeInTheDocument();
  expect(within(positionX as HTMLElement).getByText("X")).toHaveClass("inspector-axis-prefix");
  expect(colorRow).toBeInTheDocument();
  expect(screen.getByLabelText("角色颜色")).toHaveClass("inspector-color-swatch");
});

it("keeps the selected character identity visible across editing tabs", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  const summary = screen.getByLabelText("当前角色");
  expect(summary).toHaveClass("character-selection-summary");
  expect(within(summary).getByText("角色01")).toBeInTheDocument();
  expect(within(summary).getByText("单个角色")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "姿势" }));
  expect(screen.getByLabelText("当前角色")).toBeInTheDocument();
});

it("marks the pose adjustment section for the compact character inspector layout", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "姿势" }));

  expect(screen.getByText("姿势预设").closest(".inspector-section")).toHaveClass("pose-preset-section");
  expect(screen.getByText("姿势调节").closest(".inspector-section")).toHaveClass("pose-adjust-section");
});

it("uses the shared per-control range for hinge joints and extended shoulder motion", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "姿势" }));

  expect(screen.getByLabelText("左膝 · 弯曲 滑杆")).toHaveAttribute("min", "0");
  expect(screen.getByLabelText("左膝 · 弯曲 滑杆")).toHaveAttribute("max", "150");
  expect(screen.getByLabelText("左肩 · 前举 滑杆")).toHaveAttribute("min", "-120");
  expect(screen.getByLabelText("左肩 · 前举 滑杆")).toHaveAttribute("max", "120");
  expect(screen.getByLabelText("头部 · 转头 滑杆")).toHaveAttribute("max", "90");
  expect(screen.getByLabelText("身体 · 高度偏移 滑杆")).toHaveAttribute("step", "0.01");
  expect(screen.getByLabelText("左手腕 · 俯仰 滑杆")).toBeInTheDocument();
  expect(screen.getByLabelText("右脚踝 · 滚转 滑杆")).toBeInTheDocument();
});

it("authors, configures, and clears a packaged skeletal motion", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));
  await user.click(screen.getByRole("button", { name: "角色骨骼动作" }));
  await user.click(screen.getByRole("option", { name: /向前行走/ }));

  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig?.motion,
  ).toMatchObject({ clipId: "walk", enabled: true, loop: "repeat", rootMotion: "in-place" });
  fireEvent.change(screen.getByLabelText("角色动作速度"), { target: { value: "1.4" } });
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig?.motion,
  ).toMatchObject({ speed: 1.4 });

  await user.click(screen.getByRole("button", { name: "清除骨骼动作" }));
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig?.motion,
  ).toBeUndefined();
});

it("keeps legacy authored root motion readable but prevents new unsafe authoring", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().setCharacterMotion("char_default_a", {
    clipId: "jump",
    enabled: true,
    loop: "once",
    speed: 1,
    weight: 1,
    startFrame: 0,
    blendInS: 0.12,
    blendOutS: 0.15,
    rootMotion: "authored",
  });
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));
  expect(screen.getByRole("button", { name: "角色动作根运动" })).toHaveTextContent("保留位移（迁移兼容，暂不可用）");
  await user.click(screen.getByRole("button", { name: "角色动作根运动" }));

  expect(screen.getByRole("option", { name: "保留位移（迁移兼容，暂不可用）" })).toBeDisabled();
  await user.click(screen.getByRole("option", { name: "原地（推荐）" }));
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig?.motion,
  ).toMatchObject({ rootMotion: "in-place" });
});

it("hides the unavailable authored root-motion option for newly authored motion", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));
  await user.click(screen.getByRole("button", { name: "角色骨骼动作" }));
  await user.click(screen.getByRole("option", { name: /向前行走/ }));
  await user.click(screen.getByRole("button", { name: "角色动作根运动" }));

  expect(screen.getByRole("option", { name: "原地（推荐）" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "保留位移（迁移兼容，暂不可用）" })).not.toBeInTheDocument();
});

function makeSelectedCharacterNative() {
  useDirectorStore.setState((state) => ({
    ...state,
    project: {
      ...state.project,
      objects: state.project.objects.map((object) =>
        object.id === "char_default_a"
          ? {
              ...object,
              nativeSource: { engine: "blender" as const, objectId: "character-root", provisioned: true },
            }
          : object,
      ),
    },
  }));
  useBlenderRuntimeStore.getState().publishNativeRigCapability({
    rootObjectId: "character-root",
    status: "ready",
    compatible: true,
    missingBoneRoles: [],
    mappedBoneCount: 15,
  });
}

it("hides the IK tab and the ping-pong loop for provisioned native characters", async () => {
  const user = userEvent.setup();
  makeSelectedCharacterNative();
  render(<CharacterPanel />);

  expect(screen.getByRole("button", { name: "姿势" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "IK" })).not.toBeInTheDocument();
  expect(screen.queryByText("Blender 角色 IK 适配尚未完成；当前不会写入无效结果。")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "动作" }));
  await user.click(screen.getByRole("button", { name: "角色骨骼动作" }));
  await user.click(screen.getByRole("option", { name: /向前行走/ }));
  await user.click(screen.getByRole("button", { name: "角色动作循环" }));
  expect(screen.getByRole("option", { name: "循环" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: /往返/ })).not.toBeInTheDocument();
});

it("keeps a persisted native ping-pong loop readable as a disabled entry", async () => {
  const user = userEvent.setup();
  makeSelectedCharacterNative();
  useDirectorStore.getState().setCharacterMotion("char_default_a", {
    clipId: "wave",
    enabled: true,
    loop: "ping-pong",
    speed: 1,
    weight: 1,
    startFrame: 0,
    blendInS: 0.12,
    blendOutS: 0.15,
    rootMotion: "in-place",
  });
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "动作" }));
  expect(screen.getByRole("button", { name: "角色动作循环" })).toHaveTextContent("往返（Blender 暂不可用）");
  await user.click(screen.getByRole("button", { name: "角色动作循环" }));
  expect(screen.getByRole("option", { name: "往返（Blender 暂不可用）" })).toBeDisabled();
});

it("authors and clears a stable local-space hand IK target", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "IK" }));
  expect(screen.getByText("四肢 IK")).toBeInTheDocument();
  expect(screen.getByLabelText("IK 末端")).toHaveTextContent("左手");

  fireEvent.change(screen.getByLabelText("IK 目标 X"), { target: { value: "-0.9" } });
  fireEvent.change(screen.getByLabelText("IK Pole Z"), { target: { value: "0.8" } });
  fireEvent.change(screen.getByLabelText("IK 混合权重"), { target: { value: "0.65" } });
  fireEvent.change(screen.getByLabelText("IK 伸展上限"), { target: { value: "0.9" } });

  const character = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")!;
  expect(character.characterRig?.ik?.leftHand).toMatchObject({
    target: [-0.9, expect.any(Number), expect.any(Number)],
    pole: [expect.any(Number), expect.any(Number), 0.8],
    weight: 0.65,
    reachClamp: 0.9,
  });

  await user.click(screen.getByRole("button", { name: "清除此 IK" }));
  expect(
    useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a")?.characterRig?.ik,
  ).toBeUndefined();
  expect(screen.getByRole("button", { name: "启用此 IK" })).toBeInTheDocument();
});

it("adjusts axis values by dragging the gray XYZ prefix handles", () => {
  render(<CharacterPanel />);

  const dragHandle = screen.getByRole("button", { name: "角色位置 X 拖动调整" });

  fireEvent.mouseDown(dragHandle, { button: 0, clientX: 100 });
  fireEvent.mouseMove(window, { clientX: 120 });
  fireEvent.mouseUp(window);

  const role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.transform.position[0]).toBe(2);
  expect(screen.getByLabelText("角色位置 X")).toHaveValue(2);
});

it("updates the selected role name and uniform scale", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.clear(screen.getByLabelText("角色名称"));
  await user.type(screen.getByLabelText("角色名称"), "主角");
  await user.clear(screen.getByLabelText("角色统一缩放"));
  await user.type(screen.getByLabelText("角色统一缩放"), "1.2");

  const role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.name).toBe("主角");
  expect(role?.transform.scale).toEqual([1.2, 1.2, 1.2]);
});

it("updates role rotation, per-axis scale, and hex color fields", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.clear(screen.getByLabelText("角色旋转 Y"));
  await user.type(screen.getByLabelText("角色旋转 Y"), "15");
  await user.clear(screen.getByLabelText("角色缩放 Z"));
  await user.type(screen.getByLabelText("角色缩放 Z"), "1.4");
  await user.clear(screen.getByLabelText("角色颜色 HEX"));
  await user.type(screen.getByLabelText("角色颜色 HEX"), "#123456");

  const role = useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
  expect(role?.transform.rotation).toEqual([0, 15, 0]);
  expect(role?.transform.scale).toEqual([1, 1, 1.4]);
  expect(role?.color).toBe("#123456");
});

it("updates every member in a selected crowd group from the property panel", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });
  useDirectorStore.getState().selectCrowd("crowd_1");

  render(<CharacterPanel />);

  await user.clear(screen.getByLabelText("角色颜色 HEX"));
  await user.type(screen.getByLabelText("角色颜色 HEX"), "#123456");

  const crowdMembers = useDirectorStore
    .getState()
    .project.objects.filter((item) => item.kind === "character" && item.crowdId === "crowd_1");

  expect(crowdMembers).toHaveLength(4);
  expect(new Set(crowdMembers.map((item) => item.color))).toEqual(new Set(["#123456"]));
});

it("applies pose presets to every member in a selected crowd group", async () => {
  const user = userEvent.setup();
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });
  useDirectorStore.getState().selectCrowd("crowd_1");

  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "姿势" }));
  await user.click(screen.getByRole("button", { name: "T型" }));

  const crowdMembers = useDirectorStore
    .getState()
    .project.objects.filter((item) => item.kind === "character" && item.crowdId === "crowd_1");

  expect(crowdMembers).toHaveLength(4);
  expect(new Set(crowdMembers.map((item) => item.characterRig?.posePresetId))).toEqual(new Set(["t-pose"]));
  expect(new Set(crowdMembers.map((item) => item.characterRig?.controls["leftShoulder.spread"]))).toEqual(
    new Set([-70]),
  );
});

function selectedCharacter() {
  return useDirectorStore.getState().project.objects.find((item) => item.id === "char_default_a");
}

it("requires an agent identity before binding the selected character", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "绑定 Agent 到该角色" }));

  expect(screen.getByText("请先选择 Agent Profile 或填写 Session ID。")).toBeInTheDocument();
  expect(selectedCharacter()?.agentBinding).toBeUndefined();
});

it("binds and unbinds an agent session through the shared authoring path", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.type(screen.getByLabelText("绑定 Agent Session ID"), "dsh-session-42");
  await user.click(screen.getByRole("button", { name: "绑定 Agent 到该角色" }));

  expect(selectedCharacter()?.agentBinding).toEqual({ mode: "possess", sessionId: "dsh-session-42" });
  expect(screen.getByText("此人物已被 Agent 接管")).toBeInTheDocument();
  expect(screen.getByLabelText("Agent 接管状态")).toHaveTextContent("Agent 接管中");
  expect(screen.getByText("dsh-session-42")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "解除 Agent 绑定" }));

  expect(selectedCharacter()?.agentBinding).toBeUndefined();
  expect(screen.queryByText("此人物已被 Agent 接管")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "绑定 Agent 到该角色" })).toBeInTheDocument();
});

it("binds through a listed agent profile before a session exists", async () => {
  const user = userEvent.setup();
  render(<CharacterPanel />);

  await user.click(screen.getByRole("button", { name: "绑定 Agent Profile" }));
  await user.click(await screen.findByRole("option", { name: "Claude Harness" }));
  await user.click(screen.getByRole("button", { name: "绑定 Agent 到该角色" }));

  expect(selectedCharacter()?.agentBinding).toEqual({ mode: "possess", profileId: "profile-claude" });
  expect(screen.getByText("此人物已被 Agent 接管")).toBeInTheDocument();
});

it("explains that crowd selections cannot bind an agent", () => {
  useDirectorStore.getState().addCrowdCharacters({ rows: 2, columns: 2, spacing: 1.2 });
  useDirectorStore.getState().selectCrowd("crowd_1");

  render(<CharacterPanel />);

  expect(screen.getByText("群组选择暂不支持绑定 Agent；请选择单个角色后再绑定。")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "绑定 Agent 到该角色" })).not.toBeInTheDocument();
});
