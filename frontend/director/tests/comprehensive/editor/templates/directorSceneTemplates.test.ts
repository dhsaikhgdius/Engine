import { beforeEach, describe, expect, it } from "vitest";
import {
  getDirectorCharacterAssetBindingIssues,
  getMixamoCharacterCatalogItem,
} from "../../../../src/comprehensive/editor/modelLibrary/mixamoCharacterCatalog";
import { safeParseDirectorProject } from "../../../../src/comprehensive/editor/schema/directorProjectSchema";
import { createDefaultDirectorProject, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { buildDirectorSceneTemplateProject, DIRECTOR_SCENE_TEMPLATES, getDirectorSceneTemplate } from "../../../../src/comprehensive/editor/templates/index";

beforeEach(() => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject());
});

describe("场景模板库数据", () => {
  it("提供 4–6 个元数据完整且 id 唯一的模板", () => {
    expect(DIRECTOR_SCENE_TEMPLATES.length).toBeGreaterThanOrEqual(4);
    expect(DIRECTOR_SCENE_TEMPLATES.length).toBeLessThanOrEqual(6);
    expect(new Set(DIRECTOR_SCENE_TEMPLATES.map((template) => template.id)).size).toBe(
      DIRECTOR_SCENE_TEMPLATES.length,
    );
    DIRECTOR_SCENE_TEMPLATES.forEach((template) => {
      expect(template.name.trim()).not.toBe("");
      expect(template.description.trim()).not.toBe("");
      expect(template.useCase.trim()).not.toBe("");
    });
    expect(getDirectorSceneTemplate("empty-stage")?.name).toBe("空场景");
    expect(getDirectorSceneTemplate("missing-template")).toBeNull();
  });

  it.each(DIRECTOR_SCENE_TEMPLATES.map((template) => [template.name, template] as const))(
    "模板「%s」通过严格 schema 校验，角色资产真实存在",
    (_name, template) => {
      const project = buildDirectorSceneTemplateProject(template);

      const strict = safeParseDirectorProject(project);
      expect(strict.success, strict.success ? undefined : strict.error).toBe(true);

      expect(getDirectorCharacterAssetBindingIssues(project)).toEqual([]);
      project.objects
        .filter((object) => object.kind === "character")
        .forEach((object) => {
          expect(object.assetRefId).toBeTruthy();
          expect(getMixamoCharacterCatalogItem(object.assetRefId!)).not.toBeNull();
        });

      // 结构完整性：活动机位存在，且每个机位都有配对的相机对象。
      expect(project.cameras.length).toBeGreaterThan(0);
      expect(project.cameras.some((camera) => camera.id === project.activeCameraId)).toBe(true);
      project.cameras.forEach((camera) => {
        expect(
          project.objects.some((object) => object.kind === "camera" && object.linkedCameraId === camera.id),
        ).toBe(true);
      });
    },
  );

  it.each(DIRECTOR_SCENE_TEMPLATES.map((template) => [template.name, template] as const))(
    "模板「%s」能通过 replaceProject 载入 store 并支持撤销",
    (_name, template) => {
      const defaultProject = useDirectorStore.getState().project;
      const project = buildDirectorSceneTemplateProject(template);

      expect(() => useDirectorStore.getState().replaceProject(project)).not.toThrow();

      const loaded = useDirectorStore.getState().project;
      expect(loaded.objects.map((object) => object.id)).toEqual(project.objects.map((object) => object.id));
      expect(loaded.cameras.map((camera) => camera.id)).toEqual(project.cameras.map((camera) => camera.id));
      expect(loaded.activeCameraId).toBe(project.activeCameraId);
      // 载入后的工程仍满足严格 schema（迁移只应补默认值）。
      const strict = safeParseDirectorProject(loaded);
      expect(strict.success, strict.success ? undefined : strict.error).toBe(true);

      useDirectorStore.getState().undo();
      expect(useDirectorStore.getState().project.objects.map((object) => object.id)).toEqual(
        defaultProject.objects.map((object) => object.id),
      );
    },
  );

  it("双人对话模板包含两个面对面的角色与三个机位", () => {
    const project = buildDirectorSceneTemplateProject(getDirectorSceneTemplate("dialogue-two-characters")!);
    const characters = project.objects.filter((object) => object.kind === "character");
    expect(characters).toHaveLength(2);
    expect(project.cameras).toHaveLength(3);
    expect(new Set(characters.map((character) => character.assetRefId)).size).toBe(2);
  });

  it("追随镜头模板的相机 follow 目标指向行走角色", () => {
    const project = buildDirectorSceneTemplateProject(getDirectorSceneTemplate("follow-shot")!);
    const walker = project.objects.find((object) => object.id === "char_walker");
    expect(walker?.animation?.keyframes.length).toBeGreaterThanOrEqual(2);
    expect(walker?.animation?.motion).toBe("walk");
    const camera = project.cameras[0];
    expect(camera.action?.mode).toBe("follow");
    expect(camera.action?.follow?.targetObjectId).toBe("char_walker");
  });

  it("环绕展示模板的机位带圆形轨迹动画", () => {
    const project = buildDirectorSceneTemplateProject(getDirectorSceneTemplate("orbit-showcase")!);
    const camera = project.cameras[0];
    expect(camera.animation?.preset).toBe("circle");
    expect(camera.animation?.circle?.radius).toBeGreaterThan(0);
    expect(camera.animation?.keyframes.length).toBeGreaterThanOrEqual(2);
  });

  it("引用目录外角色资产的模板会被拒绝", () => {
    const template = getDirectorSceneTemplate("empty-stage")!;
    const broken = {
      ...template,
      name: "坏模板",
      document: {
        ...template.document,
        objects: [
          ...(template.document.objects as Array<Record<string, unknown>>),
          {
            id: "char_ghost",
            name: "幽灵角色",
            kind: "character",
            characterSource: "asset",
            assetRefId: "mixamo:not-a-real-character",
            visible: true,
            locked: false,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          },
        ],
      },
    };
    expect(() => buildDirectorSceneTemplateProject(broken)).toThrow(/mixamo:not-a-real-character/);
  });
});
