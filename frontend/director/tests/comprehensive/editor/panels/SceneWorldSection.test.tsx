import { render, screen } from "@testing-library/react";
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
  expect(screen.getByText("风场")).toBeInTheDocument();
  expect(screen.getByText("天气")).toBeInTheDocument();
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["气候", "效果", "水体", "生态", "交通"]);
});

it("adds and removes ambient effects through the store", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));
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

  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));

  await user.click(screen.getByRole("button", { name: "天气预设" }));
  await user.click(screen.getByRole("option", { name: "风暴" }));

  const world = useDirectorStore.getState().project.world;
  expect(world?.settings.weather.preset).toBe("storm");
  // Unrelated weather fields keep their defaults after the partial patch.
  expect(world?.settings.weather.intensity).toBeCloseTo(0.5);
  expect(screen.getByText("湿润")).toBeInTheDocument();
});

it("adds a river water body with a spline and channel width control", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));
  await user.click(screen.getByRole("tab", { name: "水体" }));
  await user.click(screen.getByRole("button", { name: "添加河流" }));

  const world = useDirectorStore.getState().project.world;
  expect(world?.waterBodies).toHaveLength(1);
  const river = world?.waterBodies[0];
  expect(river?.river?.points.length).toBeGreaterThanOrEqual(2);
  expect(river?.river?.widthM).toBe(6);
  expect(screen.getByText(`${river!.name}（河流）`)).toBeInTheDocument();
  expect(screen.getByLabelText(`${river!.name}河道宽度`)).toBeInTheDocument();
});

it("adds wildlife groups with species defaults", async () => {
  const user = userEvent.setup();
  render(<SceneWorldSection />);

  await expandSection(user);
  await user.click(screen.getByLabelText("启用世界系统"));
  await user.click(screen.getByRole("tab", { name: "生态" }));
  await user.click(screen.getByRole("button", { name: "添加动物群" }));

  const world = useDirectorStore.getState().project.world;
  expect(world?.wildlife).toHaveLength(1);
  expect(world?.wildlife[0]?.species).toBe("birds");
  expect(world?.wildlife[0]?.count).toBe(24);
  expect(world?.wildlife[0]?.altitude).toEqual({ minM: 8, maxM: 25 });
});
