import { expect, it } from "vitest";
import {
  isDirectorCreativeWorkspace,
  parseDirectorAppWorkspace,
  writeDirectorAppWorkspaceToLocation,
} from "../../../../src/comprehensive/app/layout/directorAppWorkspace";

it("parses top-bar workspaces and maps the retired Gallery alias to Stage", () => {
  expect(parseDirectorAppWorkspace("canvas")).toBe("canvas");
  expect(parseDirectorAppWorkspace("stage")).toBe("stage");
  expect(parseDirectorAppWorkspace("video")).toBe("video");
  expect(parseDirectorAppWorkspace("agent")).toBe("agent");
  expect(parseDirectorAppWorkspace("gallery")).toBe("stage");
  expect(parseDirectorAppWorkspace("paint")).toBeNull();
  expect(parseDirectorAppWorkspace(null)).toBeNull();
});

it("treats Agent as a UI workspace that does not mutate the creative store", () => {
  expect(isDirectorCreativeWorkspace("stage")).toBe(true);
  expect(isDirectorCreativeWorkspace("agent")).toBe(false);
});

it("writes the Agent workspace into the location search string", () => {
  window.history.replaceState(null, "", "/?workspace=stage");
  writeDirectorAppWorkspaceToLocation("agent");
  expect(new URL(window.location.href).searchParams.get("workspace")).toBe("agent");
});
