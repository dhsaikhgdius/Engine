import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { SceneWorldSection } from "../../../../src/comprehensive/editor/panels/SceneWorldSection";

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

async function expandSection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "世界系统" }));
}

async function enableWorld(user: ReturnType<typeof userEvent.setup>) {
  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));
}

async function expandEntryPrecision(user: ReturnType<typeof userEvent.setup>, entryLabel: string) {
  const entry = screen.getByLabelText(entryLabel);
  await user.click(within(entry).getByRole("button", { name: "Agent / 专业精调" }));
}

it("folds by default and creates the world block when enabled", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  expect(screen.getByRole("button", { name: "世界系统" })).toHaveAttribute("aria-expanded", "false");
  expect(useDirectorStore.getState().project.world).toBeUndefined();

  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));

  const world = useDirectorStore.getState().project.world;
  expect(world?.settings.enabled).toBe(true);
  expect(world?.effects).toEqual([]);
  expect(screen.getByText("风感")).toBeInTheDocument();
  expect(screen.getByText("天气")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "微风" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Agent / 专业精调" })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByLabelText("风速")).not.toBeInTheDocument();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["气候", "效果", "水体", "生态", "交通"]);
});

it("adds and removes ambient effects through the store", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "效果" }));
  await user.click(screen.getByRole("button", { name: "添加效果" }));

  let world = useDirectorStore.getState().project.world;
  expect(world?.effects).toHaveLength(1);
  expect(world?.effects[0]?.kind).toBe("fire");
  expect(world?.effects[0]?.windInfluence).toBeCloseTo(0.35);

  await user.click(screen.getByLabelText(`删除${world!.effects[0]!.name}`));

  world = useDirectorStore.getState().project.world;
  expect(world?.effects).toHaveLength(0);
});

it("updates weather settings through partial patches", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);

  await user.click(screen.getByRole("button", { name: "风暴" }));

  const world = useDirectorStore.getState().project.world;
  expect(world?.settings.weather.preset).toBe("storm");
  expect(world?.settings.weather).toMatchObject({ intensity: 0.92, cloudCover: 1, wetness: 0.86 });
  expect(screen.queryByText("湿润")).not.toBeInTheDocument();
});

it("applies natural wind and time presets without exposing raw numbers", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("button", { name: "强风" }));
  await user.click(screen.getByRole("button", { name: "昼夜循环" }));

  expect(useDirectorStore.getState().project.world?.settings.timeOfDay).toMatchObject({
    mode: "cycle",
    drivesSky: true,
  });

  await user.click(screen.getByRole("button", { name: "黄昏" }));

  const settings = useDirectorStore.getState().project.world?.settings;
  expect(settings?.wind).toMatchObject({ speedMps: 11, gustiness: 0.7, turbulence: 0.62 });
  expect(settings?.timeOfDay).toMatchObject({ mode: "fixed", hours: 17.5, drivesSky: true });
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
});

it("keeps every world entry semantic while folding raw parameters for Agent", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);

  await user.click(screen.getByRole("tab", { name: "效果" }));
  await user.click(screen.getByRole("button", { name: "添加效果" }));
  let entry = screen.getByLabelText("火焰效果条目");
  expect(within(entry).queryAllByRole("spinbutton")).toHaveLength(0);
  expect(within(entry).getByRole("button", { name: "Agent / 专业精调" })).toHaveAttribute("aria-expanded", "false");
  await user.click(within(entry).getByRole("button", { name: "强烈" }));
  expect(useDirectorStore.getState().project.world?.effects[0]).toMatchObject({
    intensity: 1.8,
    sizeScale: 1.35,
    speedScale: 1.2,
  });

  await user.click(screen.getByRole("tab", { name: "水体" }));
  await user.click(screen.getByRole("button", { name: "添加水体" }));
  entry = screen.getByLabelText("水体水体条目");
  expect(within(entry).queryAllByRole("spinbutton")).toHaveLength(0);
  await user.click(within(entry).getByRole("button", { name: "汹涌" }));
  expect(useDirectorStore.getState().project.world?.waterBodies[0]).toMatchObject({
    waveAmplitude: 0.24,
    waveLengthM: 4.5,
    flowSpeedMps: 0.65,
    foamIntensity: 0.78,
  });

  await user.click(screen.getByRole("tab", { name: "生态" }));
  await user.click(screen.getByRole("button", { name: "添加动物群" }));
  entry = screen.getByLabelText("鸟群动物群条目");
  expect(within(entry).queryAllByRole("spinbutton")).toHaveLength(0);
  await user.click(within(entry).getByRole("button", { name: "繁盛" }));
  expect(useDirectorStore.getState().project.world?.wildlife[0]?.count).toBe(42);

  await user.click(screen.getByRole("tab", { name: "交通" }));
  await user.click(screen.getByRole("button", { name: "添加道路" }));
  entry = screen.getByLabelText("道路道路条目");
  expect(within(entry).queryAllByRole("spinbutton")).toHaveLength(0);
  expect(within(entry).queryByText("道路与水面相交")).toBeNull();
  expect(within(entry).getByLabelText("环路")).toBeInTheDocument();
  await user.click(within(entry).getByRole("button", { name: "繁忙" }));
  expect(useDirectorStore.getState().project.world?.roads[0]).toMatchObject({ vehicleCount: 14, speedKph: 24 });
});

it("detects a road crossing water and offers a semantic one-click lift", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "水体" }));
  await user.click(screen.getByRole("button", { name: "添加水体" }));
  await expandEntryPrecision(user, "水体水体条目");
  fireEvent.change(screen.getByLabelText("水体尺寸X"), { target: { value: "80" } });
  fireEvent.change(screen.getByLabelText("水体尺寸Z"), { target: { value: "80" } });

  await user.click(screen.getByRole("tab", { name: "交通" }));
  await user.click(screen.getByRole("button", { name: "添加道路" }));
  const entry = screen.getByLabelText("道路道路条目");
  expect(within(entry).queryAllByRole("spinbutton")).toHaveLength(0);
  expect(within(entry).getByText("道路与水面相交")).toBeInTheDocument();

  const before = useDirectorStore.getState().project.world!.roads[0]!.points.map((point) => point[1]);
  await user.click(within(entry).getByRole("button", { name: "抬升到水面上方" }));
  const after = useDirectorStore.getState().project.world!.roads[0]!.points.map((point) => point[1]);

  expect(after[0]).toBeGreaterThan(before[0]!);
  const lift = after[0]! - before[0]!;
  after.forEach((height, index) => expect(height - before[index]!).toBeCloseTo(lift));
  expect(within(entry).queryByText("道路与水面相交")).toBeNull();
});

it("explains submerged fire and moves it above water without exposing coordinates", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "水体" }));
  await user.click(screen.getByRole("button", { name: "添加水体" }));
  await expandEntryPrecision(user, "水体水体条目");
  fireEvent.change(screen.getByLabelText("水体尺寸X"), { target: { value: "80" } });
  fireEvent.change(screen.getByLabelText("水体尺寸Z"), { target: { value: "80" } });

  await user.click(screen.getByRole("tab", { name: "效果" }));
  await user.click(screen.getByRole("button", { name: "添加效果" }));
  const entry = screen.getByLabelText("火焰效果条目");
  expect(within(entry).queryAllByRole("spinbutton")).toHaveLength(0);
  expect(within(entry).getByText("火焰位于水下")).toBeInTheDocument();

  const beforeY = useDirectorStore.getState().project.world!.effects[0]!.anchor.position[1];
  await user.click(within(entry).getByRole("button", { name: "移到水面上方" }));
  const afterY = useDirectorStore.getState().project.world!.effects[0]!.anchor.position[1];

  expect(afterY).toBeGreaterThan(beforeY);
  expect(within(entry).queryByText("火焰位于水下")).toBeNull();
});

it("scales semantic water motion to the authored water-body size", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "水体" }));
  await user.click(screen.getByRole("button", { name: "添加水体" }));
  await expandEntryPrecision(user, "水体水体条目");
  fireEvent.change(screen.getByLabelText("水体尺寸X"), { target: { value: "80" } });
  fireEvent.change(screen.getByLabelText("水体尺寸Z"), { target: { value: "80" } });
  await user.click(screen.getByRole("button", { name: "Agent / 专业精调" }));
  await user.click(screen.getByRole("button", { name: "汹涌" }));

  expect(useDirectorStore.getState().project.world?.waterBodies[0]).toMatchObject({
    waveAmplitude: 0.48,
    waveLengthM: 9,
    flowSpeedMps: 0.65,
    foamIntensity: 0.78,
  });
});

it("writes the world seed from the climate tab", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("button", { name: "Agent / 专业精调" }));

  fireEvent.change(screen.getByLabelText("世界种子滑杆"), { target: { value: "12345" } });
  expect(useDirectorStore.getState().project.world?.settings.seed).toBe(12345);

  // Out-of-range or fractional input clamps to the protocol integer bounds.
  fireEvent.change(screen.getByLabelText("世界种子滑杆"), { target: { value: "-8.7" } });
  expect(useDirectorStore.getState().project.world?.settings.seed).toBe(0);
});

it("authors effect shape, position, wind influence, and color tint", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "效果" }));
  await user.click(screen.getByRole("button", { name: "添加效果" }));
  await expandEntryPrecision(user, "火焰效果条目");

  fireEvent.change(screen.getByLabelText("火焰位置 X"), { target: { value: "3.5" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.anchor.position).toEqual([3.5, 0, 0]);

  await user.click(screen.getByRole("button", { name: "火焰发射形状" }));
  await user.click(screen.getByRole("option", { name: "盒体" }));
  expect(useDirectorStore.getState().project.world?.effects[0]?.shape).toEqual({ type: "box", size: [2, 2, 2] });

  fireEvent.change(screen.getByLabelText("火焰盒体尺寸 Y"), { target: { value: "5" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.shape).toEqual({ type: "box", size: [2, 5, 2] });

  await user.click(screen.getByRole("button", { name: "火焰发射形状" }));
  await user.click(screen.getByRole("option", { name: "球体" }));
  expect(useDirectorStore.getState().project.world?.effects[0]?.shape).toEqual({ type: "sphere", radius: 2 });

  fireEvent.change(screen.getByLabelText("火焰形状半径滑杆"), { target: { value: "6" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.shape).toEqual({ type: "sphere", radius: 6 });

  fireEvent.change(screen.getByLabelText("火焰风力影响滑杆"), { target: { value: "0.8" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.windInfluence).toBeCloseTo(0.8);

  fireEvent.change(screen.getByLabelText("火焰尺寸倍率滑杆"), { target: { value: "2.5" } });
  fireEvent.change(screen.getByLabelText("火焰速度倍率滑杆"), { target: { value: "1.6" } });
  fireEvent.change(screen.getByLabelText("火焰种子偏移滑杆"), { target: { value: "17" } });
  const scaled = useDirectorStore.getState().project.world?.effects[0];
  expect(scaled?.sizeScale).toBeCloseTo(2.5);
  expect(scaled?.speedScale).toBeCloseTo(1.6);
  expect(scaled?.seedOffset).toBe(17);

  // Color tint is optional: the toggle adds it, the hex field edits it, and untoggling deletes it.
  expect(scaled?.colorTint).toBeUndefined();
  await user.click(screen.getByLabelText("颜色叠加"));
  expect(useDirectorStore.getState().project.world?.effects[0]?.colorTint).toBe("#ffffff");

  fireEvent.change(screen.getByLabelText("火焰色调 HEX"), { target: { value: "#FF8800" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.colorTint).toBe("#ff8800");

  fireEvent.change(screen.getByLabelText("火焰色调 HEX"), { target: { value: "not-a-color" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.colorTint).toBe("#ff8800");

  await user.click(screen.getByLabelText("颜色叠加"));
  expect(useDirectorStore.getState().project.world?.effects[0]?.colorTint).toBeUndefined();
});

it("locks an effect entry, hiding its controls and disabling deletion", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "效果" }));
  await user.click(screen.getByRole("button", { name: "添加效果" }));
  await expandEntryPrecision(user, "火焰效果条目");
  expect(screen.getByLabelText("火焰强度滑杆")).toBeInTheDocument();

  await user.click(screen.getByLabelText("锁定"));
  expect(useDirectorStore.getState().project.world?.effects[0]?.locked).toBe(true);
  expect(screen.queryByLabelText("火焰强度滑杆")).toBeNull();
  expect(screen.getByText("已锁定，解除锁定后可编辑")).toBeInTheDocument();
  expect(screen.getByLabelText("删除火焰")).toBeDisabled();

  await user.click(screen.getByLabelText("锁定"));
  expect(useDirectorStore.getState().project.world?.effects[0]?.locked).toBe(false);
  expect(screen.queryByLabelText("火焰强度滑杆")).toBeNull();
  await expandEntryPrecision(user, "火焰效果条目");
  expect(screen.getByLabelText("火焰强度滑杆")).toBeInTheDocument();
});

it("toggles seeded weather evolution and shows the live climate readout", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));

  // Default is static: no period slider, no readout.
  expect(screen.queryByLabelText("演化周期")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("气候实时读数")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "自然变化" }));

  const world = useDirectorStore.getState().project.world;
  expect(world?.settings.weather.evolution).toEqual({ mode: "cycle", periodSeconds: 300 });
  expect(screen.queryByLabelText("演化周期")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Agent / 专业精调" }));
  expect(screen.getByLabelText("演化周期")).toBeInTheDocument();
  expect(screen.getByLabelText("气候实时读数")).toBeInTheDocument();
  expect(screen.getByText(/地表|地面/)).toBeInTheDocument();

  // Switching back to static keeps the period for the next toggle.
  await user.click(screen.getByRole("button", { name: "保持当前天气" }));
  expect(useDirectorStore.getState().project.world?.settings.weather.evolution).toEqual({
    mode: "static",
    periodSeconds: 300,
  });
  expect(screen.queryByLabelText("气候实时读数")).not.toBeInTheDocument();
});

it("authors fire propagation from the effects tab", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));
  await user.click(screen.getByRole("tab", { name: "效果" }));
  await user.click(screen.getByRole("button", { name: "添加效果" }));
  await expandEntryPrecision(user, "火焰效果条目");

  const effect = useDirectorStore.getState().project.world!.effects[0]!;
  expect(effect.kind).toBe("fire");
  expect(effect.propagation).toBeUndefined();

  await user.click(screen.getByLabelText("火势蔓延"));
  const enabled = useDirectorStore.getState().project.world!.effects[0]!;
  expect(enabled.propagation).toEqual({ enabled: true, radiusM: 12, spreadRate: 1 });
  expect(screen.getByLabelText(`${effect.name}蔓延半径`)).toBeInTheDocument();
  expect(screen.getByLabelText(`${effect.name}蔓延速率`)).toBeInTheDocument();

  await user.click(screen.getByLabelText("火势蔓延"));
  const disabled = useDirectorStore.getState().project.world!.effects[0]!;
  expect(disabled.propagation).toEqual({ enabled: false, radiusM: 12, spreadRate: 1 });
});

it("adds a river water body with a spline and channel width control", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "水体" }));
  await user.click(screen.getByRole("button", { name: "添加河流" }));

  const world = useDirectorStore.getState().project.world;
  expect(world?.waterBodies).toHaveLength(1);
  const river = world?.waterBodies[0];
  expect(river?.river?.points.length).toBeGreaterThanOrEqual(2);
  expect(river?.river?.widthM).toBe(6);
  expect(screen.getByText(`${river!.name}（河流）`)).toBeInTheDocument();
  expect(screen.queryByLabelText(`${river!.name}河道宽度`)).not.toBeInTheDocument();
  await expandEntryPrecision(user, `${river!.name}水体条目`);
  expect(screen.getByLabelText(`${river!.name}河道宽度`)).toBeInTheDocument();
});

it("authors basin surface, colors, and river control points", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "水体" }));
  await user.click(screen.getByRole("button", { name: "添加水体" }));
  await expandEntryPrecision(user, "水体水体条目");

  fireEvent.change(screen.getByLabelText("水体位置 Y"), { target: { value: "1.5" } });
  fireEvent.change(screen.getByLabelText("水体尺寸X滑杆"), { target: { value: "35" } });
  fireEvent.change(screen.getByLabelText("水体旋转滑杆"), { target: { value: "45" } });
  fireEvent.change(screen.getByLabelText("水体流向滑杆"), { target: { value: "180" } });
  fireEvent.change(screen.getByLabelText("水体波长滑杆"), { target: { value: "12" } });
  fireEvent.change(screen.getByLabelText("水体浅水颜色 HEX"), { target: { value: "#123456" } });
  fireEvent.change(screen.getByLabelText("水体不透明度滑杆"), { target: { value: "0.6" } });
  fireEvent.change(screen.getByLabelText("水体泡沫强度滑杆"), { target: { value: "0.9" } });

  const basin = useDirectorStore.getState().project.world?.waterBodies[0];
  expect(basin?.surface.center).toEqual([0, 1.5, 0]);
  expect(basin?.surface.sizeX).toBe(35);
  expect(basin?.surface.rotationDegrees).toBe(45);
  expect(basin?.flowDirectionDegrees).toBe(180);
  expect(basin?.waveLengthM).toBe(12);
  expect(basin?.colorShallow).toBe("#123456");
  expect(basin?.opacity).toBeCloseTo(0.6);
  expect(basin?.foamIntensity).toBeCloseTo(0.9);

  await user.click(screen.getByRole("button", { name: "添加河流" }));
  await expandEntryPrecision(user, "河流水体条目");
  fireEvent.change(screen.getByLabelText("河流控制点1 X"), { target: { value: "-20" } });
  expect(useDirectorStore.getState().project.world?.waterBodies[1]?.river?.points[0]).toEqual([-20, 0.2, -16]);

  // Width profile stays aligned with the control-point count.
  await user.click(screen.getByLabelText("宽度剖面"));
  expect(useDirectorStore.getState().project.world?.waterBodies[1]?.river?.widthProfile).toEqual([1, 1, 1, 1]);

  await user.click(screen.getByLabelText("添加河流控制点"));
  const riverAfterAdd = useDirectorStore.getState().project.world?.waterBodies[1]?.river;
  expect(riverAfterAdd?.points).toHaveLength(5);
  expect(riverAfterAdd?.widthProfile).toEqual([1, 1, 1, 1, 1]);

  fireEvent.change(screen.getByLabelText("河流宽度倍率2滑杆"), { target: { value: "1.8" } });
  expect(useDirectorStore.getState().project.world?.waterBodies[1]?.river?.widthProfile?.[1]).toBeCloseTo(1.8);

  await user.click(screen.getByLabelText("删除河流控制点5"));
  const riverAfterRemove = useDirectorStore.getState().project.world?.waterBodies[1]?.river;
  expect(riverAfterRemove?.points).toHaveLength(4);
  expect(riverAfterRemove?.widthProfile).toHaveLength(4);
});

it("adds wildlife groups with species defaults", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "生态" }));
  await user.click(screen.getByRole("button", { name: "添加动物群" }));

  const world = useDirectorStore.getState().project.world;
  expect(world?.wildlife).toHaveLength(1);
  expect(world?.wildlife[0]?.species).toBe("birds");
  expect(world?.wildlife[0]?.count).toBe(24);
  expect(world?.wildlife[0]?.altitude).toEqual({ minM: 8, maxM: 25 });
});

it("authors wildlife roaming area, scales, and altitude band", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "生态" }));
  await user.click(screen.getByRole("button", { name: "添加动物群" }));
  await expandEntryPrecision(user, "鸟群动物群条目");

  fireEvent.change(screen.getByLabelText("鸟群活动中心 Z"), { target: { value: "-12" } });
  fireEvent.change(screen.getByLabelText("鸟群活动半径滑杆"), { target: { value: "40" } });
  fireEvent.change(screen.getByLabelText("鸟群速度倍率滑杆"), { target: { value: "1.5" } });
  fireEvent.change(screen.getByLabelText("鸟群尺寸倍率滑杆"), { target: { value: "2" } });

  const group = useDirectorStore.getState().project.world?.wildlife[0];
  expect(group?.area.center).toEqual([0, 0, -12]);
  expect(group?.area.radius).toBe(40);
  expect(group?.speedScale).toBeCloseTo(1.5);
  expect(group?.sizeScale).toBeCloseTo(2);

  // Raising the floor above the ceiling drags the ceiling up so the band stays valid.
  fireEvent.change(screen.getByLabelText("鸟群最低高度滑杆"), { target: { value: "30" } });
  expect(useDirectorStore.getState().project.world?.wildlife[0]?.altitude).toEqual({ minM: 30, maxM: 30 });
});

it("adds, edits, and removes traffic roads from the traffic tab", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "交通" }));
  expect(screen.getByText("尚未添加道路")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "添加道路" }));
  await expandEntryPrecision(user, "道路道路条目");

  let world = useDirectorStore.getState().project.world;
  expect(world?.roads).toHaveLength(1);
  const road = world!.roads[0]!;
  expect(road.widthM).toBe(8);
  expect(road.loop).toBe(true);
  expect(road.vehicleCount).toBe(6);
  expect(road.speedKph).toBe(40);
  expect(road.showSurface).toBe(true);
  expect(screen.getByRole("tab", { name: /交通/ })).toHaveTextContent("交通1");

  fireEvent.change(screen.getByLabelText("道路车速滑杆"), { target: { value: "60" } });
  fireEvent.change(screen.getByLabelText("道路车辆数滑杆"), { target: { value: "12" } });
  fireEvent.change(screen.getByLabelText("道路路宽滑杆"), { target: { value: "10" } });
  await user.click(screen.getByLabelText("环路"));
  await user.click(screen.getByLabelText("显示路面"));
  fireEvent.change(screen.getByLabelText("道路控制点1 X"), { target: { value: "20" } });

  world = useDirectorStore.getState().project.world;
  const edited = world!.roads[0]!;
  expect(edited.speedKph).toBe(60);
  expect(edited.vehicleCount).toBe(12);
  expect(edited.widthM).toBe(10);
  expect(edited.loop).toBe(false);
  expect(edited.showSurface).toBe(false);
  expect(edited.points[0]).toEqual([20, 0.05, 15]);

  await user.click(screen.getByLabelText("添加道路控制点"));
  expect(useDirectorStore.getState().project.world?.roads[0]?.points).toHaveLength(9);

  await user.click(screen.getByLabelText("删除道路"));
  expect(useDirectorStore.getState().project.world?.roads).toHaveLength(0);
});

it("renames world entries through the name field", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await enableWorld(user);
  await user.click(screen.getByRole("tab", { name: "效果" }));
  await user.click(screen.getByRole("button", { name: "添加效果" }));

  fireEvent.change(screen.getByLabelText("火焰名称"), { target: { value: "篝火" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.name).toBe("篝火");

  // Clearing the field keeps the last committed name instead of writing an empty one.
  fireEvent.change(screen.getByLabelText("篝火名称"), { target: { value: "" } });
  expect(useDirectorStore.getState().project.world?.effects[0]?.name).toBe("篝火");
});
