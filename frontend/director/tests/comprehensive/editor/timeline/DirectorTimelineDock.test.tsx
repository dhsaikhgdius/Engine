import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { useTimelineRuntimeStore } from "../../../../src/comprehensive/editor/runtime/timelineRuntimeStore";
import { DirectorTimelineDock, type DirectorTimelineExportResult } from "../../../../src/comprehensive/editor/timeline/DirectorTimelineDock";
import { createTimelineRecordingSettings } from "../../../../src/comprehensive/editor/timeline/timelineRecording";
import { getEffectiveTimelineEndFrame } from "../../../../src/comprehensive/editor/timeline/frameTimeline";
import { formatDirectorTimelineTimecode } from "../../../../src/comprehensive/editor/timeline/timecode";
import { MIN_TIMELINE_HEIGHT, TIMELINE_COLLAPSE_OVERDRAG_PX } from "../../../../src/comprehensive/app/layout/workspaceLayout";

function prepareProject() {
  const initial = createInitialDirectorState();
  initial.project.scene.timeline = {
    version: 1,
    fps: 24,
    frameStart: 0,
    frameEnd: 48,
    currentFrame: 0,
    loop: false,
  };
  useDirectorStore.setState({ ...useDirectorStore.getState(), ...initial });
  useDirectorStore.getState().addGeometryPrimitive("box");
  return useDirectorStore.getState().project;
}

function renderDock(overrides: Partial<ComponentProps<typeof DirectorTimelineDock>> = {}) {
  const project = useDirectorStore.getState().project;
  const {
    onRecordingSettingsChange: providedOnRecordingSettingsChange,
    recordingSettings: providedRecordingSettings,
    ...remainingOverrides
  } = overrides;
  function RecordingDockHarness() {
    const [recordingSettings, setRecordingSettings] = useState(
      () =>
        providedRecordingSettings ??
        createTimelineRecordingSettings({
          frameStart: project.scene.timeline!.frameStart,
          frameEnd: getEffectiveTimelineEndFrame(project),
        }),
    );
    const onRecordingSettingsChange = (settings: typeof recordingSettings) => {
      providedOnRecordingSettingsChange?.(settings);
      setRecordingSettings(settings);
    };
    return (
      <DirectorTimelineDock
        height={292}
        isPlaying={false}
        onCancelDeterministicExport={vi.fn()}
        onCollapse={vi.fn()}
        onDeterministicExport={vi.fn(async (frameStart, frameEnd) => ({
          extension: "zip" as const,
          frameStart,
          frameEnd,
          frameCount: frameEnd - frameStart + 1,
          kind: "png-sequence" as const,
          name: "director-png-sequence.zip",
          packageFingerprint: "sha256:1234567890abcdef",
        }))}
        onMultimodalExport={vi.fn(async (frameStart, frameEnd) => ({
          extension: "zip" as const,
          frameStart,
          frameEnd,
          frameCount: frameEnd - frameStart + 1,
          kind: "multimodal-dataset" as const,
          name: "director-multimodal.zip",
          packageFingerprint: "sha256:abcdef1234567890",
        }))}
        onExport={vi.fn(async (_format, frameStart, frameEnd) => ({
          extension: "webm" as const,
          frameStart,
          frameEnd,
          name: "渲染视频01",
        }))}
        onRecordingControl={vi.fn()}
        onRecordingSettingsChange={onRecordingSettingsChange}
        onFrameChange={vi.fn()}
        onFrameCommit={vi.fn()}
        onHeightChange={vi.fn()}
        onReset={vi.fn()}
        onTogglePlaying={vi.fn()}
        project={project}
        recordingSettings={recordingSettings}
        recordingStatus="idle"
        timeline={project.scene.timeline!}
        {...remainingOverrides}
      />
    );
  }
  return render(<RecordingDockHarness />);
}

beforeEach(() => {
  prepareProject();
  useTimelineRuntimeStore.getState().reset();
});

describe("multitrack director timeline", () => {
  it("switches the lower dock to the dedicated scene-thumbnail browser", () => {
    renderDock();

    fireEvent.click(screen.getByRole("tab", { name: "场景缩略图" }));

    expect(screen.getByRole("tabpanel", { name: "场景缩略图" })).toBeInTheDocument();
    expect(screen.queryByRole("tabpanel", { name: "轨道 / 帧" })).not.toBeInTheDocument();
  });

  it("organizes the lower dock into named playback, creation, and delivery groups", () => {
    const view = renderDock();

    expect(screen.getByRole("group", { name: "播放与时间" })).toContainElement(
      screen.getByRole("button", { name: "播放动画" }),
    );
    expect(screen.getByRole("group", { name: "场景与轨迹" })).toContainElement(
      screen.getByRole("button", { name: "添加分镜到播放头" }),
    );
    expect(screen.getByRole("group", { name: "记录与导出" })).toContainElement(
      screen.getByRole("button", { name: "自动导出 IN/OUT 视频" }),
    );
    expect(screen.getByRole("group", { name: "记录与导出" })).toContainElement(
      screen.getByRole("button", { name: "导出确定性 IN/OUT 帧包" }),
    );
    expect(view.container.querySelector(".animation-timeline-panel")).toHaveAttribute("data-bottom-view", "timeline");

    fireEvent.click(screen.getByRole("tab", { name: "分镜" }));
    expect(view.container.querySelector(".animation-timeline-panel")).toHaveAttribute("data-bottom-view", "storyboard");
  });

  it("offers the Flick-style rehearsal, record, and orbit workflow", () => {
    renderDock();

    expect(screen.getByRole("group", { name: "排练与记录" })).toContainElement(
      screen.getByRole("button", { name: "排练" }),
    );
    expect(screen.getByRole("button", { name: "记录" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "添加轨道" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "添加动作" }));
    expect(screen.getByRole("menuitem", { name: "圆形路径" })).toBeInTheDocument();
  });

  it("keeps stage audio as a compact add control until media is imported", () => {
    renderDock();

    const audio = screen.getByRole("group", { name: "舞台音频" });
    expect(within(audio).queryByRole("combobox", { name: "选择音频素材" })).toBeNull();
    expect(within(audio).getByRole("button", { name: "在播放头处添加音频片段" })).toBeDisabled();
  });

  it("compiles parameterized animation recipes into editable timeline keyframes", () => {
    useDirectorStore.getState().selectObject("char_default_a");
    renderDock();

    fireEvent.click(screen.getByRole("button", { name: "动画配方" }));
    expect(screen.getByRole("dialog", { name: "动画配方参数" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("动画配方类型"), { target: { value: "bounce" } });
    fireEvent.change(screen.getByLabelText("动画配方幅度"), { target: { value: "2" } });
    fireEvent.change(screen.getByLabelText("动画配方循环数"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "应用动画配方" }));

    const animation = useDirectorStore
      .getState()
      .project.objects.find((object) => object.id === "char_default_a")?.animation;
    expect(animation).toMatchObject({
      preset: "custom",
      source: "manual",
      recipe: { type: "bounce", height: 2, bounces: 4, squash: true },
    });
    expect(animation?.keyframes[0]?.frame).toBe(0);
    expect(animation?.keyframes.at(-1)?.frame).toBe(48);
    expect(screen.queryByRole("dialog", { name: "动画配方参数" })).not.toBeInTheDocument();
  });

  it("uses a seconds ruler and keeps the active camera visible before it has motion", () => {
    renderDock();

    expect(screen.getByRole("button", { name: "机位01 静止机位" })).toBeInTheDocument();
    expect(screen.getByText("0s")).toBeInTheDocument();
    expect(screen.getByText("0.5s")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "分镜剪辑轨" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "机位01 静止机位" }));
    fireEvent.click(screen.getByRole("button", { name: "添加动作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "圆形路径" }));

    expect(useDirectorStore.getState().project.cameras[0].animation).toMatchObject({
      enabled: true,
      preset: "circle",
    });
  });

  it("keeps dense ruler ticks while thinning their labels into a dedicated readable band", () => {
    useDirectorStore.getState().updateScene({
      timeline: {
        ...useDirectorStore.getState().project.scene.timeline!,
        frameEnd: 240,
      },
    });
    const view = renderDock();

    expect(screen.getByText("时间轴")).toBeInTheDocument();
    expect(screen.getByText("刻度 · 录制标记")).toBeInTheDocument();
    expect(screen.getByText("0s")).toBeInTheDocument();
    expect(screen.getByText("1s")).toBeInTheDocument();
    expect(screen.queryByText("0.5s")).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(".animation-timeline-ruler .is-unlabeled").length).toBeGreaterThan(0);
    expect(screen.queryByText(/\d+\.\d{3}s/)).not.toBeInTheDocument();
    expect(view.container.querySelector<HTMLElement>(".animation-timeline-labels")?.style.gridTemplateRows).toMatch(
      /^36px/,
    );
    expect(view.container.querySelector<HTMLElement>(".animation-timeline-labels")?.style.gridTemplateRows).toMatch(
      /^\d+px( \d+px)*$/,
    );
  });

  it("uses one vertical scroll surface for timeline labels and canvas tracks", () => {
    const view = renderDock();
    const scroll = view.container.querySelector<HTMLElement>(".animation-timeline-scroll");
    const sync = scroll?.querySelector<HTMLElement>(".animation-timeline-sync");
    const labels = sync?.querySelector<HTMLElement>(".animation-timeline-labels");
    const canvas = sync?.querySelector<HTMLElement>(".animation-timeline-canvas");

    expect(scroll).not.toBeNull();
    expect(sync).not.toBeNull();
    expect(labels).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(labels!.style.gridTemplateRows).toBe(canvas!.style.gridTemplateRows);
    expect(labels!.style.transform).toBe("");
  });

  it("adds an explicit empty track before its first action and keeps it after reopening the dock", () => {
    useDirectorStore.getState().selectObject("char_default_a");
    const initialView = renderDock();

    fireEvent.click(screen.getByRole("button", { name: "添加轨道" }));

    expect(useDirectorStore.getState().project.scene.timeline?.trackKeys).toContain("object:char_default_a");
    expect(useDirectorStore.getState().project.objects[0].animation).toBeUndefined();

    initialView.unmount();
    renderDock();
    expect(screen.getByRole("button", { name: "角色01 待添加动作" })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "为 角色01 添加动作" })[0]);
    expect(screen.getByRole("menuitem", { name: "直线路径" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "直线路径" }));

    expect(useDirectorStore.getState().project.objects[0].animation).toMatchObject({
      enabled: true,
      preset: "line",
    });
  });

  it.each([
    ["char_default_a", "character", "object"],
    ["cam_object_1", "camera", "camera"],
    ["prop_1", "prop", "object"],
  ] as const)("creates every trajectory preset for %s", (objectId, kind, ownerType) => {
    const resolvedObjectId =
      objectId === "prop_1"
        ? useDirectorStore.getState().project.objects.find((item) => item.kind === "prop")!.id
        : objectId;
    useDirectorStore.getState().selectObject(resolvedObjectId);

    for (const [label, preset] of [
      ["直线路径", "line"],
      ["圆形路径", "circle"],
      ["矩形路径", "rectangle"],
    ] as const) {
      const view = renderDock();
      fireEvent.click(screen.getByRole("button", { name: "添加动作" }));
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      const state = useDirectorStore.getState();
      const animation =
        ownerType === "camera"
          ? state.project.cameras[0].animation
          : state.project.objects.find((item) => item.id === resolvedObjectId)?.animation;
      expect(animation).toMatchObject({ preset, enabled: true });
      expect(animation?.keyframes.every((keyframe) => Number.isInteger(keyframe.frame))).toBe(true);
      expect(kind === "character" ? animation?.motion : "none").toBe(kind === "character" ? "walk" : "none");
      view.unmount();
      useTimelineRuntimeStore.getState().reset();
    }

    const view = renderDock();
    fireEvent.click(screen.getByRole("button", { name: "添加动作" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "自由绘制" }));
    act(() => useTimelineRuntimeStore.getState().addDrawingPoint([3, 0, 2]));
    fireEvent.click(screen.getByRole("button", { name: "完成轨迹" }));
    const state = useDirectorStore.getState();
    const customAnimation =
      ownerType === "camera"
        ? state.project.cameras[0].animation
        : state.project.objects.find((item) => item.id === resolvedObjectId)?.animation;
    expect(customAnimation).toMatchObject({ preset: "custom", source: "manual" });
    expect(customAnimation?.keyframes[customAnimation.keyframes.length - 1]?.transform?.position).toEqual([3, 0, 2]);
    view.unmount();
  });

  it("keeps keyframe drag transient until pointer-up commits one integer frame", () => {
    useDirectorStore.getState().setObjectAnimation("char_default_a", {
      version: 1,
      enabled: true,
      preset: "line",
      keyframes: [
        { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { frame: 48, transform: { position: [4, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    renderDock();
    const marker = screen.getByRole("button", { name: /角色01 关键帧 2/ });

    fireEvent.pointerDown(marker, { clientX: 75 });
    fireEvent.pointerMove(window, { clientX: 25 });
    expect(useDirectorStore.getState().project.objects[0].animation?.keyframes[1].frame).toBe(48);
    fireEvent.pointerUp(window, { clientX: 25 });
    expect(useDirectorStore.getState().project.objects[0].animation?.keyframes[1].frame).toBe(12);
  });

  it("adds one catalog motion block at the playhead and undoes the track plus block as one edit", () => {
    useDirectorStore.getState().selectObject("char_default_a");
    act(() => useTimelineRuntimeStore.getState().setPlayheadFrame(12));
    renderDock();

    fireEvent.change(screen.getByLabelText("角色动作区块素材"), { target: { value: "wave" } });
    fireEvent.change(screen.getByLabelText("新动作区块时长（帧）"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "添加动作区块" }));

    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks).toEqual([
      expect.objectContaining({ clipId: "wave", frameStart: 12, frameEnd: 23 }),
    ]);
    expect(useDirectorStore.getState().project.scene.timeline?.trackKeys).toContain("object:char_default_a");

    act(() => useDirectorStore.getState().undo());
    expect(useDirectorStore.getState().project.objects[0].animation).toBeUndefined();
    expect(useDirectorStore.getState().project.scene.timeline?.trackKeys ?? []).not.toContain("object:char_default_a");
  });

  it("moves and trims a motion block transiently, then commits one undoable range", () => {
    useDirectorStore.getState().selectObject("char_default_a");
    useDirectorStore.getState().setObjectAnimation("char_default_a", {
      version: 1,
      enabled: true,
      keyframes: [],
      motionBlocks: [
        {
          id: "motion-wave",
          clipId: "wave",
          enabled: true,
          frameStart: 8,
          frameEnd: 19,
          loop: "once",
          speed: 1,
          weight: 1,
          blendInS: 0.12,
          blendOutS: 0.12,
          rootMotion: "in-place",
        },
      ],
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    renderDock();

    const block = screen.getByRole("button", { name: /动作区块.*第 8 到 19 帧/ });
    fireEvent.pointerDown(block, { button: 0, clientX: 16 });
    fireEvent.pointerMove(window, { clientX: 50 });
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({
      frameStart: 8,
      frameEnd: 19,
    });
    fireEvent.pointerUp(window, { clientX: 50 });
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({
      frameStart: 24,
      frameEnd: 35,
    });

    act(() => useDirectorStore.getState().undo());
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({
      frameStart: 8,
      frameEnd: 19,
    });
  });

  it("replaces and deletes the selected motion block without changing its authored range", () => {
    useDirectorStore.getState().selectObject("char_default_a");
    useDirectorStore.getState().setObjectAnimation("char_default_a", {
      version: 1,
      enabled: true,
      keyframes: [],
      motionBlocks: [
        {
          id: "motion-wave",
          clipId: "wave",
          enabled: true,
          frameStart: 8,
          frameEnd: 19,
          loop: "once",
          speed: 1,
          weight: 1,
          blendInS: 0.12,
          blendOutS: 0.12,
          rootMotion: "in-place",
        },
      ],
    });
    renderDock();

    fireEvent.click(screen.getByRole("button", { name: /动作区块.*第 8 到 19 帧/ }));
    fireEvent.change(screen.getByLabelText("角色动作区块素材"), { target: { value: "run" } });
    fireEvent.click(screen.getByRole("button", { name: "替换所选动作区块" }));
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({
      clipId: "run",
      frameStart: 8,
      frameEnd: 19,
      loop: "repeat",
    });

    act(() => useDirectorStore.getState().undo());
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]?.clipId).toBe("wave");
    fireEvent.click(screen.getByRole("button", { name: "删除所选动作区块" }));
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks).toBeUndefined();
  });

  it("commits selected motion block playback parameters without writing numeric drafts", () => {
    useDirectorStore.getState().selectObject("char_default_a");
    useDirectorStore.getState().setObjectAnimation("char_default_a", {
      version: 1,
      enabled: true,
      keyframes: [],
      motionBlocks: [
        {
          id: "motion-wave",
          clipId: "wave",
          enabled: true,
          frameStart: 8,
          frameEnd: 19,
          loop: "once",
          speed: 1,
          weight: 1,
          blendInS: 0.12,
          blendOutS: 0.12,
          rootMotion: "in-place",
        },
      ],
    });
    const firstView = renderDock();

    fireEvent.click(screen.getByRole("button", { name: /动作区块.*第 8 到 19 帧/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑所选动作区块参数" }));
    expect(screen.getByRole("dialog", { name: "动作区块参数" })).toBeInTheDocument();

    const speed = screen.getByLabelText("动作区块速度");
    fireEvent.change(speed, { target: { value: "1.5" } });
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]?.speed).toBe(1);
    fireEvent.blur(speed);
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({ speed: 1.5 });

    act(() => useDirectorStore.getState().undo());
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({ speed: 1 });

    firstView.unmount();
    const secondView = renderDock();
    fireEvent.click(screen.getByRole("button", { name: /动作区块.*第 8 到 19 帧/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑所选动作区块参数" }));
    fireEvent.change(screen.getByLabelText("动作区块循环方式"), { target: { value: "ping-pong" } });
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({
      loop: "ping-pong",
    });

    secondView.unmount();
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: /动作区块.*第 8 到 19 帧/ }));
    fireEvent.click(screen.getByRole("button", { name: "编辑所选动作区块参数" }));
    fireEvent.click(screen.getByLabelText("启用动作区块"));
    expect(useDirectorStore.getState().project.objects[0].animation?.motionBlocks?.[0]).toMatchObject({
      enabled: false,
      loop: "ping-pong",
    });
  });

  it("keeps playhead sync and stores an exact rational FPS timebase", () => {
    renderDock();
    act(() => useTimelineRuntimeStore.getState().setPlayheadFrame(12));
    expect(screen.getByRole("slider", { name: "时间轴播放头" })).toHaveAttribute("aria-valuenow", "12");
    expect(screen.getByLabelText("当前 SMPTE 时间码")).toHaveValue("00:00:00:12");
    fireEvent.click(screen.getByRole("button", { name: "循环播放" }));
    expect(useDirectorStore.getState().project.scene.timeline?.loop).toBe(true);

    const fps = screen.getByLabelText("时间轴 FPS");
    fireEvent.change(fps, { target: { value: "30" } });
    fireEvent.blur(fps);
    expect(useDirectorStore.getState().project.scene.timeline?.fps).toBe(30);
    expect(useDirectorStore.getState().project.scene.timeline?.timebase).toMatchObject({
      rate: { numerator: 30, denominator: 1 },
      dropFrame: false,
    });
  });

  it("shows and parses SMPTE drop-frame timecode without converting the canonical frame to seconds", () => {
    const timeline = {
      ...useDirectorStore.getState().project.scene.timeline!,
      fps: 30_000 / 1_001,
      frameEnd: 2_000,
      currentFrame: 1_800,
      timebase: {
        rate: { numerator: 30_000, denominator: 1_001 },
        dropFrame: true,
        startTimecode: "00:00:00;00",
      },
    };
    const onFrameChange = vi.fn();
    useTimelineRuntimeStore.getState().setPlayheadFrame(1_800);
    renderDock({ timeline, onFrameChange });

    const timecode = screen.getByLabelText("当前 SMPTE 时间码");
    expect(timecode).toHaveValue("00:01:00;02");
    expect(screen.getByRole("button", { name: "Drop-frame timecode" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(timecode, { target: { value: "00:01:00;03" } });
    fireEvent.blur(timecode);
    expect(onFrameChange).toHaveBeenCalledWith(1_801);
  });

  it("edits the professional timeline start timecode and offsets the displayed playhead", () => {
    useTimelineRuntimeStore.getState().setPlayheadFrame(24);
    renderDock();
    const start = screen.getByLabelText("起始 SMPTE 时间码");
    fireEvent.change(start, { target: { value: "01:00:00:00" } });
    fireEvent.blur(start);
    const timebase = useDirectorStore.getState().project.scene.timeline?.timebase;
    expect(timebase?.startTimecode).toBe("01:00:00:00");
    expect(formatDirectorTimelineTimecode(24, timebase!)).toBe("01:00:01:00");
  });

  it("allows a static timeline range to be recorded even before a motion track exists", () => {
    renderDock();
    expect(screen.getByRole("button", { name: "从蓝色手动起点开始记录" })).toBeEnabled();
  });

  it("keeps a visible storyboard editing track and lets a clip move without crossing its neighbour", () => {
    useDirectorStore.getState().updateStoryboard({
      version: 1,
      title: "剪辑测试",
      logline: "测试轨道编辑",
      shots: [
        {
          id: "shot-a",
          title: "开场",
          cameraId: "cam_object_1",
          frameStart: 0,
          frameEnd: 9,
          shotSize: "wide",
          movement: "static",
          action: "建立空间",
        },
        {
          id: "shot-b",
          title: "反应",
          cameraId: "cam_object_1",
          frameStart: 30,
          frameEnd: 48,
          shotSize: "medium",
          movement: "pan",
          action: "切到反应",
        },
      ],
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    renderDock({ project: useDirectorStore.getState().project });

    expect(screen.getByRole("list", { name: "分镜剪辑轨" })).toBeInTheDocument();
    const clip = screen.getByRole("button", { name: /分镜 1：开场/ });
    fireEvent.pointerDown(clip, { button: 0, clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 20 });
    fireEvent.pointerUp(window, { clientX: 20 });

    expect(useDirectorStore.getState().project.storyboard?.shots.find((shot) => shot.id === "shot-a")).toMatchObject({
      frameStart: 10,
      frameEnd: 19,
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑分镜轨" }));
    expect(screen.getByRole("tabpanel", { name: "分镜" })).toBeInTheDocument();
    expect(screen.getByText("开场").closest(".storyboard-shot-card")).toHaveClass("is-selected");
    const axisSwitch = screen.getByRole("button", { name: "切换到分镜轴" });
    fireEvent.click(axisSwitch);
    expect(screen.getByRole("tabpanel", { name: "轨道 / 帧" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "切换到分镜轴" })).toHaveAttribute("aria-pressed", "true");
  });

  it("inserts a three-second storyboard shot at the playhead and expands the timeline when needed", () => {
    renderDock();
    fireEvent.click(screen.getByRole("button", { name: "添加分镜到播放头" }));

    expect(useDirectorStore.getState().project.storyboard?.shots).toHaveLength(1);
    expect(useDirectorStore.getState().project.storyboard?.shots[0]).toMatchObject({ frameStart: 0, frameEnd: 71 });
    expect(useDirectorStore.getState().project.scene.timeline?.frameEnd).toBe(71);
  });

  it("shows a storyboard clip as an index plus one title without repeating the camera name", () => {
    useDirectorStore.getState().updateStoryboard({
      version: 1,
      title: "机位重复",
      logline: "同一机位不应在片段上写两遍",
      shots: [
        {
          id: "shot-camera-title",
          title: "04 · 机位01",
          cameraId: "cam_object_1",
          frameStart: 0,
          frameEnd: 23,
          shotSize: "wide",
          movement: "static",
          action: "建立空间",
        },
      ],
    });
    const view = renderDock({ project: useDirectorStore.getState().project });

    expect(view.container.querySelector(".animation-timeline-storyboard-clip-index")?.textContent).toBe("01");
    expect(view.container.querySelector(".animation-timeline-storyboard-clip-copy")?.textContent).toBe("机位01");
  });

  it("opens the storyboard print workflow with selectable scope and 1–4 column preview", () => {
    useDirectorStore.getState().updateStoryboard({
      version: 1,
      title: "打印测试",
      logline: "把镜头交给现场",
      shots: [
        {
          id: "shot-print-a",
          title: "建立镜头",
          cameraId: "cam_object_1",
          frameStart: 0,
          frameEnd: 23,
          shotSize: "wide",
          movement: "static",
          action: "人物进入画面",
        },
        {
          id: "shot-print-b",
          title: "反应镜头",
          cameraId: "cam_object_1",
          frameStart: 24,
          frameEnd: 47,
          shotSize: "close-up",
          movement: "pan",
          action: "视线转向门口",
        },
      ],
    });
    renderDock({ project: useDirectorStore.getState().project });
    fireEvent.click(screen.getByRole("tab", { name: "分镜" }));

    expect(screen.getByRole("button", { name: "补齐画面" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "导出 PDF" }));
    expect(screen.getByRole("dialog", { name: "导出分镜 PDF" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("分镜每行列数"), { target: { value: "4" } });
    expect(screen.getByLabelText("分镜每行列数")).toHaveValue("4");
    fireEvent.click(screen.getByLabelText("选择 PDF 分镜 建立镜头"));
    fireEvent.change(screen.getByLabelText("分镜导出范围"), { target: { value: "selected" } });
    expect(screen.getByLabelText("分镜导出范围")).toHaveValue("selected");
    expect(screen.getByRole("button", { name: "下载可验证包" })).toBeEnabled();
  });

  it("selects an inclusive integer IN/OUT range and records exactly that clip", async () => {
    useDirectorStore.getState().setObjectAnimation("char_default_a", {
      version: 1,
      enabled: true,
      preset: "line",
      keyframes: [
        { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { frame: 36, transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const onExport = vi.fn(async (_format, frameStart, frameEnd) => ({
      extension: "webm" as const,
      frameStart,
      frameEnd,
      name: "渲染视频01",
    }));
    renderDock({ onExport });

    const inHandle = screen.getByRole("slider", { name: "录制入点" });
    const outHandle = screen.getByRole("slider", { name: "录制出点" });
    expect(inHandle).toHaveAttribute("aria-valuenow", "0");
    expect(outHandle).toHaveAttribute("aria-valuenow", "36");
    expect(outHandle).toHaveAttribute("aria-valuetext", "第 36 帧，时间码 00:00:01:12");

    fireEvent.pointerDown(inHandle.querySelector("span")!, { button: 0, clientX: 25 });
    fireEvent.pointerUp(window, { clientX: 25 });
    fireEvent.pointerDown(outHandle.querySelector("span")!, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });

    expect(inHandle).toHaveAttribute("aria-valuenow", "12");
    expect(outHandle).toHaveAttribute("aria-valuenow", "24");
    fireEvent.click(screen.getByRole("button", { name: "自动导出 IN/OUT 视频" }));

    await vi.waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(onExport).toHaveBeenCalledWith("auto", 12, 24, expect.any(Function));
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "自动导出 IN/OUT 视频" })).toHaveAttribute("aria-busy", "false"),
    );
    expect(screen.queryByText("渲染视频01 已记录（F12–F24）")).not.toBeInTheDocument();
  });

  it("exports a deterministic, fingerprinted PNG sequence for the active IN/OUT range", async () => {
    const onDeterministicExport = vi.fn(async (frameStart: number, frameEnd: number) => ({
      extension: "zip" as const,
      frameStart,
      frameEnd,
      frameCount: frameEnd - frameStart + 1,
      kind: "png-sequence" as const,
      name: "director-png-sequence.zip",
      packageFingerprint: "sha256:1234567890abcdef",
    }));
    renderDock({ onDeterministicExport });

    fireEvent.click(screen.getByRole("button", { name: "导出确定性 IN/OUT 帧包" }));

    await vi.waitFor(() =>
      expect(onDeterministicExport).toHaveBeenCalledWith(0, 48, expect.any(Function), { background: "composited" }),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "导出确定性 IN/OUT 帧包" })).toHaveAttribute("aria-busy", "false"),
    );
    expect(
      screen.queryByText("director-png-sequence.zip 已导出为确定性 PNG 帧包（49 帧 · SHA 1234567890ab）"),
    ).not.toBeInTheDocument();
  });

  it("opts the deterministic frame package into the transparent compositing background", async () => {
    const onDeterministicExport = vi.fn(async (frameStart: number, frameEnd: number) => ({
      extension: "zip" as const,
      frameStart,
      frameEnd,
      frameCount: frameEnd - frameStart + 1,
      kind: "png-sequence" as const,
      name: "director-png-sequence.zip",
      packageFingerprint: "sha256:1234567890abcdef",
    }));
    renderDock({ onDeterministicExport });

    const transparentToggle = screen.getByRole("checkbox", { name: "确定性帧包使用透明背景" });
    expect(transparentToggle).not.toBeChecked();
    fireEvent.click(transparentToggle);
    fireEvent.click(screen.getByRole("button", { name: "导出确定性 IN/OUT 帧包" }));

    await vi.waitFor(() =>
      expect(onDeterministicExport).toHaveBeenCalledWith(0, 48, expect.any(Function), { background: "transparent" }),
    );
  });

  it("exports only the selected multimodal channels and metadata", async () => {
    const onMultimodalExport = vi.fn(async (frameStart: number, frameEnd: number) => ({
      extension: "zip" as const,
      frameStart,
      frameEnd,
      frameCount: frameEnd - frameStart + 1,
      kind: "multimodal-dataset" as const,
      name: "director-multimodal.zip",
      packageFingerprint: "sha256:abcdef1234567890",
    }));
    renderDock({ onMultimodalExport });

    fireEvent.click(screen.getByText("数据选项"));
    fireEvent.click(screen.getByRole("checkbox", { name: "导出 depth" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "导出对象状态" }));
    fireEvent.click(screen.getByRole("button", { name: "导出多模态 IN/OUT 数据包" }));

    await vi.waitFor(() =>
      expect(onMultimodalExport).toHaveBeenCalledWith(
        0,
        48,
        {
          renderPasses: ["clean", "depth"],
          includeCamera: true,
          includeObjects: false,
        },
        expect.any(Function),
      ),
    );
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "导出多模态 IN/OUT 数据包" })).toHaveAttribute("aria-busy", "false"),
    );
    expect(
      screen.queryByText("director-multimodal.zip 已导出（49 帧 · 2 个图像通道 · SHA abcdef123456）"),
    ).not.toBeInTheDocument();
  });

  it("opts the multimodal selection into the dense motion flow EXR channel", async () => {
    const onMultimodalExport = vi.fn(async (frameStart: number, frameEnd: number) => ({
      extension: "zip" as const,
      frameStart,
      frameEnd,
      frameCount: frameEnd - frameStart + 1,
      kind: "multimodal-dataset" as const,
      name: "director-multimodal.zip",
      packageFingerprint: "sha256:abcdef1234567890",
    }));
    renderDock({ onMultimodalExport });

    fireEvent.click(screen.getByText("数据选项"));
    const denseMotionToggle = screen.getByRole("checkbox", { name: "导出 motion 稠密光流 EXR" });
    expect(denseMotionToggle).not.toBeChecked();
    fireEvent.click(denseMotionToggle);
    fireEvent.click(screen.getByRole("button", { name: "导出多模态 IN/OUT 数据包" }));

    await vi.waitFor(() =>
      expect(onMultimodalExport).toHaveBeenCalledWith(
        0,
        48,
        {
          renderPasses: ["clean"],
          includeCamera: true,
          includeObjects: true,
          denseMotionExr: true,
        },
        expect.any(Function),
      ),
    );
  });

  it("opts into metric depth, instance annotations, and exposes PBR G-buffer channels", async () => {
    const onMultimodalExport = vi.fn(async (frameStart: number, frameEnd: number) => ({
      extension: "zip" as const,
      frameStart,
      frameEnd,
      frameCount: frameEnd - frameStart + 1,
      kind: "multimodal-dataset" as const,
      name: "director-multimodal.zip",
      packageFingerprint: "sha256:abcdef1234567890",
    }));
    renderDock({ onMultimodalExport });

    fireEvent.click(screen.getByText("数据选项"));
    expect(screen.getByRole("checkbox", { name: "导出 albedo" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "导出 roughness" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "导出 shadow" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "导出 depth" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "导出 depth 米制 EXR" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "导出实例标注 JSON" }));
    fireEvent.click(screen.getByRole("button", { name: "导出多模态 IN/OUT 数据包" }));

    await vi.waitFor(() =>
      expect(onMultimodalExport).toHaveBeenCalledWith(
        0,
        48,
        {
          renderPasses: ["clean", "depth"],
          includeCamera: true,
          includeObjects: true,
          depthExr: true,
          includeInstanceAnnotations: true,
        },
        expect.any(Function),
      ),
    );
  });

  it("keeps the multimodal export visibly busy while progress updates", async () => {
    let finishExport: (() => void) | undefined;
    const onMultimodalExport = vi.fn(
      async (
        frameStart: number,
        frameEnd: number,
        _selection: unknown,
        onProgress: (progress: number, frame: number, renderPass: "clean") => void,
      ) => {
        useTimelineRuntimeStore.getState().setExporting(true);
        onProgress(0.5, 24, "clean");
        await new Promise<void>((resolve) => {
          finishExport = resolve;
        });
        useTimelineRuntimeStore.getState().setExporting(false);
        return {
          extension: "zip" as const,
          frameStart,
          frameEnd,
          frameCount: frameEnd - frameStart + 1,
          kind: "multimodal-dataset" as const,
          name: "director-multimodal.zip",
          packageFingerprint: "sha256:abcdef1234567890",
        };
      },
    );
    renderDock({ onMultimodalExport });

    const exportButton = screen.getByRole("button", { name: "导出多模态 IN/OUT 数据包" });
    fireEvent.click(exportButton);

    await vi.waitFor(() => expect(exportButton).toHaveAttribute("aria-busy", "true"));
    expect(exportButton).toHaveTextContent("数据采集 F24 · 50%");

    await act(async () => finishExport?.());
    await vi.waitFor(() => expect(exportButton).toHaveAttribute("aria-busy", "false"));
  });

  it("exposes cancellation while a deterministic frame export owns the timeline", async () => {
    let rejectExport: ((reason?: unknown) => void) | undefined;
    const onDeterministicExport = vi.fn(
      () =>
        new Promise<DirectorTimelineExportResult>((_resolve, reject) => {
          rejectExport = reject;
          useTimelineRuntimeStore.getState().setExporting(true);
        }),
    );
    const onCancelDeterministicExport = vi.fn(() => {
      useTimelineRuntimeStore.getState().setExporting(false);
      rejectExport?.(new DOMException("aborted", "AbortError"));
    });
    renderDock({ onCancelDeterministicExport, onDeterministicExport });

    fireEvent.click(screen.getByRole("button", { name: "导出确定性 IN/OUT 帧包" }));
    const cancel = await screen.findByRole("button", { name: "取消确定性帧导出" });
    fireEvent.click(cancel);

    expect(onCancelDeterministicExport).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(screen.queryByRole("button", { name: "取消确定性帧导出" })).not.toBeInTheDocument());
    expect(screen.queryByText("已取消确定性帧导出")).not.toBeInTheDocument();
  });

  it("locks all transport controls while automatic IN/OUT export owns the playhead", () => {
    useTimelineRuntimeStore.getState().setExporting(true);
    renderDock();

    expect(screen.getByRole("button", { name: "播放动画" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "回到时间轴开头" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "循环播放" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "录制入点" })).toBeDisabled();
    expect(screen.getByRole("slider", { name: "录制出点" })).toBeDisabled();
  });

  it("uses the matching white, blue, and red control families for preview, manual, and automatic work", () => {
    renderDock();

    expect(screen.getByRole("button", { name: "播放动画" })).toHaveClass("animation-timeline-preview-control");
    expect(screen.getByRole("button", { name: "从蓝色手动起点开始记录" })).toHaveClass("is-manual");
    expect(screen.getByRole("button", { name: "暂停记录渲染" })).toHaveClass("is-manual");
    expect(screen.getByRole("button", { name: "停止记录渲染" })).toHaveClass("is-manual");
    expect(screen.getByRole("button", { name: "自动导出 IN/OUT 视频" })).toHaveClass("is-automatic");
  });

  it("keeps the IN/OUT export and manual recording start marker visible together", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const onRecordingSettingsChange = vi.fn();
    const onRecordingControl = vi.fn();
    renderDock({ onRecordingSettingsChange, onRecordingControl });

    expect(screen.queryByLabelText("记录渲染模式")).not.toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "录制入点" })).toBeInTheDocument();
    expect(screen.getByRole("slider", { name: "录制出点" })).toBeInTheDocument();

    const manualStart = screen.getByRole("slider", { name: "手动记录起点" });
    fireEvent.pointerDown(manualStart.querySelector("span")!, { button: 0, clientX: 50 });
    fireEvent.pointerUp(window, { clientX: 50 });
    expect(onRecordingSettingsChange).toHaveBeenLastCalledWith(expect.objectContaining({ manualStart: 24 }));

    fireEvent.click(screen.getByRole("button", { name: "从蓝色手动起点开始记录" }));
    expect(onRecordingControl).toHaveBeenLastCalledWith("start");
  });

  it("moves nearby recording labels into separate lanes without moving their frame handles", () => {
    const initial = createInitialDirectorState();
    initial.project.scene.timeline = {
      version: 1,
      fps: 24,
      frameStart: 0,
      frameEnd: 360,
      currentFrame: 0,
      loop: false,
    };
    useDirectorStore.setState({ ...useDirectorStore.getState(), ...initial });
    const settings = createTimelineRecordingSettings({ frameStart: 0, frameEnd: 360 });
    renderDock({
      recordingSettings: {
        ...settings,
        exportRange: { in: 0, out: 36 },
        manualStart: 36,
      },
    });

    const inHandle = screen.getByRole("slider", { name: "录制入点" });
    const outHandle = screen.getByRole("slider", { name: "录制出点" });
    const manualHandle = screen.getByRole("slider", { name: "手动记录起点" });
    expect(inHandle).not.toHaveClass("is-label-lane-1");
    expect(outHandle).toHaveClass("is-label-lane-1");
    expect(manualHandle).toHaveClass("is-label-lane-2");
    expect(inHandle).toHaveTextContent("IN · F0");
    expect(inHandle).not.toHaveTextContent("00:00:00");
    expect(inHandle.getAttribute("title")).toContain("00:00:00");
    expect(outHandle).toHaveAttribute("aria-valuenow", "36");
    expect(manualHandle).toHaveAttribute("aria-valuenow", "36");
  });

  it("moves range handles one frame at a time and never lets IN cross OUT", () => {
    useDirectorStore.getState().setObjectAnimation("char_default_a", {
      version: 1,
      enabled: true,
      keyframes: [
        { frame: 0, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
        { frame: 24, transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      ],
    });
    renderDock();
    const inHandle = screen.getByRole("slider", { name: "录制入点" });
    const outHandle = screen.getByRole("slider", { name: "录制出点" });

    fireEvent.keyDown(inHandle, { key: "ArrowRight" });
    expect(inHandle).toHaveAttribute("aria-valuenow", "1");
    fireEvent.keyDown(inHandle, { key: "End" });
    expect(inHandle).toHaveAttribute("aria-valuenow", "24");
    fireEvent.keyDown(inHandle, { key: "ArrowRight" });
    expect(inHandle).toHaveAttribute("aria-valuenow", "24");
    fireEvent.keyDown(outHandle, { key: "Home" });
    expect(outHandle).toHaveAttribute("aria-valuenow", "24");
  });

  it("rejects a non-safe ending frame instead of poisoning the frame timeline", () => {
    renderDock();
    const frameEnd = screen.getByLabelText("时间轴结束帧");
    fireEvent.change(frameEnd, { target: { value: "9007199254740992" } });
    fireEvent.blur(frameEnd);
    expect(useDirectorStore.getState().project.scene.timeline?.frameEnd).toBe(48);
  });

  it("accepts a century-scale project timeline while rejecting values beyond the supported range", () => {
    renderDock();
    const frameEnd = screen.getByLabelText("时间轴结束帧");
    fireEvent.change(frameEnd, { target: { value: "75000000000" } });
    fireEvent.blur(frameEnd);
    expect(useDirectorStore.getState().project.scene.timeline?.frameEnd).toBe(75_000_000_000);

    fireEvent.change(frameEnd, { target: { value: "75000000001" } });
    fireEvent.blur(frameEnd);
    expect(useDirectorStore.getState().project.scene.timeline?.frameEnd).toBe(75_000_000_000);
  });

  it("bounds ruler work and canvas width for very large legacy frame ranges", () => {
    useDirectorStore.getState().updateScene({
      timeline: {
        ...useDirectorStore.getState().project.scene.timeline!,
        frameEnd: 1_000_000_000,
      },
    });
    const view = renderDock();
    expect(view.container.querySelectorAll(".animation-timeline-ruler span").length).toBeLessThanOrEqual(242);
    expect(view.container.querySelector<HTMLElement>("[data-timeline-canvas]")?.style.width).toBe("200000px");
  });

  it("collapses independently and resizes its top edge without mutating scene authority", () => {
    const onCollapse = vi.fn();
    const onHeightChange = vi.fn();
    const projectBefore = JSON.stringify(useDirectorStore.getState().project);
    renderDock({ onCollapse, onHeightChange });

    expect(screen.queryByRole("button", { name: "收起下方栏" })).not.toBeInTheDocument();

    const separator = screen.getByRole("separator", { name: "调整时间轴高度" });
    fireEvent.pointerDown(separator, { button: 0, clientY: 400 });
    fireEvent.pointerUp(window, { clientY: 400 });
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenLastCalledWith(292);
    onCollapse.mockClear();
    onHeightChange.mockClear();

    fireEvent.pointerDown(separator, { button: 0, clientY: 400 });
    fireEvent.pointerMove(window, { clientY: 300 });
    fireEvent.pointerUp(window, { clientY: 300 });
    expect(onHeightChange).toHaveBeenCalledWith(392);
    expect(onCollapse).not.toHaveBeenCalled();

    fireEvent.pointerDown(separator, { button: 0, clientY: 400 });
    fireEvent.pointerMove(window, {
      clientY: 400 + 292 - (MIN_TIMELINE_HEIGHT - TIMELINE_COLLAPSE_OVERDRAG_PX) + 1,
    });
    fireEvent.pointerUp(window);
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(onHeightChange).toHaveBeenLastCalledWith(292);

    fireEvent.keyDown(separator, { key: "Home" });
    expect(onHeightChange).toHaveBeenLastCalledWith(180);
    expect(JSON.stringify(useDirectorStore.getState().project)).toBe(projectBefore);
  });

  it("collapses from the top sash keyboard when already at the minimum height", () => {
    const onCollapse = vi.fn();
    renderDock({ height: MIN_TIMELINE_HEIGHT, onCollapse });

    fireEvent.keyDown(screen.getByRole("separator", { name: "调整时间轴高度" }), { key: "ArrowDown" });
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});
