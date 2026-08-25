import { parseProject } from "../../../../src/comprehensive/editor/io/importProjectJson";
import { buildScreenshotMeta, filterVisibleObjectIdColors } from "../../../../src/comprehensive/editor/io/screenshotExport";
import { serializeProject } from "../../../../src/comprehensive/editor/io/exportProjectJson";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";

it("captures the required metadata for camera-mode screenshots", () => {
  expect(
    buildScreenshotMeta({
      mode: "camera",
      cameraId: "cam_1",
      fov: 50,
      position: [0, 2.2, 9],
      target: [0, 1.2, 0],
      frame: 24,
      revisionRequested: 9,
    }),
  ).toEqual({
    mode: "camera",
    cameraId: "cam_1",
    fov: 50,
    position: [0, 2.2, 9],
    target: [0, 1.2, 0],
    frame: 24,
    revisionRequested: 9,
  });
});

it("keeps only object ID colors present in the captured pixels", () => {
  expect(
    filterVisibleObjectIdColors(Uint8Array.from([12, 34, 56, 255, 0, 0, 0, 255]), {
      visible: [12, 34, 56],
      outsideFrame: [65, 43, 21],
    }),
  ).toEqual({ visible: [12, 34, 56] });
});

it("round-trips the project JSON without losing objects or cameras", () => {
  const json = serializeProject(createDefaultDirectorProject());
  const project = parseProject(json);

  expect(project.cameras[0].name).toBe("机位01");
  expect(project.objects.some((item) => item.kind === "character")).toBe(true);
});

it("rejects imported JSON with an invalid nested project field", () => {
  const project = createDefaultDirectorProject();
  project.scene.position = [0, 0] as unknown as [number, number, number];

  expect(() => parseProject(JSON.stringify(project))).toThrow(/项目数据无效/);
});
