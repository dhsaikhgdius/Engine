import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { applyDirectorAuthoringActions } from "@director/agent-engine";
import {
  createDefaultDirectorProject,
  createInitialDirectorState,
  useDirectorStore,
} from "../../../../src/comprehensive/editor/store/directorStore";
import { ProceduralToolsDialog } from "../../../../src/comprehensive/editor/procedural/ProceduralToolsDialog";

beforeEach(() => {
  window.localStorage.clear();
  const project = applyDirectorAuthoringActions(createDefaultDirectorProject(), [
    {
      action: "add_object",
      id: "procedural-ui-source",
      name: "UI crate",
      kind: "prop",
      geometry_type: "box",
      placement_mode: "grounded",
      transform: { position: [1, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  ]).project;
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
    project,
    undoStack: [],
    redoStack: [],
  });
});

it("previews and applies one procedural recipe as a single undoable mutation", async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const onApplied = vi.fn();
  render(<ProceduralToolsDialog onApplied={onApplied} onClose={onClose} />);

  expect(screen.getByText("4 个输出")).toBeInTheDocument();
  const copies = screen.getByLabelText("副本数");
  await user.clear(copies);
  await user.type(copies, "3");
  const offsetX = screen.getByLabelText("每份偏移 X");
  await user.clear(offsetX);
  await user.type(offsetX, "3");
  expect(screen.getByText("3 个输出")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "应用到片场" }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(onApplied).toHaveBeenCalledWith(expect.stringContaining("3 个可编辑物体"));

  const recipe = useDirectorStore.getState().project.proceduralRecipes?.at(-1);
  expect(recipe?.operation).toMatchObject({ kind: "linear-array", copies: 3, offset: [3, 0, 0] });
  expect(
    useDirectorStore
      .getState()
      .project.objects.filter((object) => recipe?.outputObjectIds.includes(object.id))
      .map((object) => object.transform.position),
  ).toEqual([
    [4, 0, 2],
    [7, 0, 2],
    [10, 0, 2],
  ]);

  act(() => useDirectorStore.getState().undo());
  expect(useDirectorStore.getState().project.proceduralRecipes).toBeUndefined();
  expect(
    useDirectorStore.getState().project.objects.some((object) => recipe?.outputObjectIds.includes(object.id)),
  ).toBe(false);
});

it("focuses the dialog on open, closes on Escape, and restores the trigger focus", async () => {
  const user = userEvent.setup();
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          打开程序化工具
        </button>
        {open ? <ProceduralToolsDialog onClose={() => setOpen(false)} /> : null}
      </>
    );
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "打开程序化工具" });

  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "程序化建模工具" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "关闭程序化建模" })).toHaveFocus();

  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "程序化建模工具" })).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});

it("labels primitive terrain as blocking and updates its bounded live count", async () => {
  const user = userEvent.setup();
  render(<ProceduralToolsDialog onClose={vi.fn()} />);
  await user.selectOptions(screen.getByLabelText("程序化操作"), "terrain");
  expect(screen.getByText("64 个输出")).toBeInTheDocument();
  expect(screen.getByText(/primitive-cell/)).toBeInTheDocument();

  const resolution = screen.getByLabelText("网格分辨率");
  await user.clear(resolution);
  await user.type(resolution, "4");
  expect(screen.getByText("16 个输出")).toBeInTheDocument();
});
