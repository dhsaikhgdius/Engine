import { beforeEach, expect, it } from "vitest";
import {
  getSceneCameraThumbnails,
  readSceneCameraThumbnail,
  rememberSceneCameraThumbnail,
  resetSceneCameraThumbnailCache,
} from "../../../../src/comprehensive/editor/production/sceneCameraThumbnailCache";

const FRAME =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlckH8AAAAASUVORK5CYII=";

beforeEach(() => {
  window.sessionStorage.clear();
  resetSceneCameraThumbnailCache();
});

it("keeps a genuine camera data URL out of scene JSON while sharing it between scene-card surfaces", () => {
  rememberSceneCameraThumbnail("scene-a", FRAME);

  expect(getSceneCameraThumbnails()).toEqual({ "scene-a": FRAME });
  expect(readSceneCameraThumbnail("scene-a")).toBe(FRAME);
  expect(window.sessionStorage.getItem("3d-director-ui:scene-camera-thumbnail:scene-a")).toBe(FRAME);
});
