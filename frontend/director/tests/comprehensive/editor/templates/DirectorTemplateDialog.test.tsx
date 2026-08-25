import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import {
  clearDirectorNotifications,
  getDirectorNotifications,
} from "../../../../src/comprehensive/app/notifications/directorNotificationStore";
import { LanguageProvider } from "../../../../src/comprehensive/i18n/language";
import {
  createDefaultDirectorProject,
  useDirectorStore,
} from "../../../../src/comprehensive/editor/store/directorStore";
import {
  DirectorTemplateDialog,
  isDirectorProjectFactoryDefault,
} from "../../../../src/comprehensive/editor/templates/DirectorTemplateDialog";
import { DIRECTOR_SCENE_TEMPLATES } from "../../../../src/comprehensive/editor/templates/index";

function renderDialog(onClose = vi.fn()) {
  render(
    <LanguageProvider>
      <DirectorTemplateDialog onClose={onClose} />
    </LanguageProvider>,
  );
  return onClose;
}

function loadModifiedDefaultProject() {
  const modified = createDefaultDirectorProject();
  modified.objects = modified.objects.map((object) =>
    object.kind === "character"
      ? { ...object, transform: { ...object.transform, position: [1.2, 0, -0.6] as [number, number, number] } }
      : object,
  );
  useDirectorStore.getState().replaceProject(modified);
}

beforeEach(() => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
  clearDirectorNotifications();
});

it("以可访问的模态对话框列出全部场景模板卡片", () => {
  renderDialog();
  const dialog = screen.getByRole("dialog", { name: "从模板新建 3D 片场" });
  expect(dialog).toHaveAttribute("aria-modal", "true");
  for (const template of DIRECTOR_SCENE_TEMPLATES) {
    const card = screen.getByRole("button", { name: `使用模板 ${template.name}` });
    expect(card).toHaveTextContent(template.description);
    expect(card).toHaveTextContent(template.useCase);
  }
});

it("识别出厂默认工程与被改动过的工程", () => {
  expect(isDirectorProjectFactoryDefault(useDirectorStore.getState().project)).toBe(true);
  loadModifiedDefaultProject();
  expect(isDirectorProjectFactoryDefault(useDirectorStore.getState().project)).toBe(false);
});

it("当前是空白默认工程时点选模板直接载入并发成功通知", async () => {
  const user = userEvent.setup();
  const onClose = renderDialog();

  await user.click(screen.getByRole("button", { name: "使用模板 双人对话" }));

  const project = useDirectorStore.getState().project;
  expect(project.objects.some((object) => object.id === "char_dialogue_host")).toBe(true);
  expect(project.objects.some((object) => object.id === "char_dialogue_guest")).toBe(true);
  expect(project.cameras).toHaveLength(3);
  expect(screen.queryByText("将替换当前 3D 片场工程（可用撤销恢复）")).not.toBeInTheDocument();
  expect(
    getDirectorNotifications().some(
      (notification) =>
        notification.severity === "success" && notification.title.includes("已从模板「双人对话」新建 3D 片场工程"),
    ),
  ).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();
});

it("当前工程被改动过时需要内联确认，确认后载入且可撤销恢复", async () => {
  const user = userEvent.setup();
  loadModifiedDefaultProject();
  const modifiedCharacter = useDirectorStore.getState().project.objects.find((object) => object.kind === "character");
  const onClose = renderDialog();

  await user.click(screen.getByRole("button", { name: "使用模板 环绕展示" }));
  expect(screen.getByText("将替换当前 3D 片场工程（可用撤销恢复）")).toBeInTheDocument();
  expect(useDirectorStore.getState().project.objects.some((object) => object.id === "char_orbit_subject")).toBe(false);

  await user.click(screen.getByRole("button", { name: /确认替换/ }));
  expect(useDirectorStore.getState().project.objects.some((object) => object.id === "char_orbit_subject")).toBe(true);
  expect(onClose).toHaveBeenCalledOnce();

  useDirectorStore.getState().undo();
  const restored = useDirectorStore.getState().project.objects.find((object) => object.kind === "character");
  expect(restored?.id).toBe(modifiedCharacter?.id);
  expect(restored?.transform.position).toEqual(modifiedCharacter?.transform.position);
});

it("内联确认可以取消，不改动当前工程", async () => {
  const user = userEvent.setup();
  loadModifiedDefaultProject();
  const before = useDirectorStore.getState().project;
  renderDialog();

  await user.click(screen.getByRole("button", { name: "使用模板 空场景" }));
  expect(screen.getByText("将替换当前 3D 片场工程（可用撤销恢复）")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "取消" }));

  expect(screen.queryByText("将替换当前 3D 片场工程（可用撤销恢复）")).not.toBeInTheDocument();
  expect(useDirectorStore.getState().project).toEqual(before);
});

it("Esc 键关闭对话框", async () => {
  const user = userEvent.setup();
  const onClose = renderDialog();
  await user.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledOnce();
});
