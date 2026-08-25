import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import {
  compareUnityEditorVersionsDesc,
  DIRECTOR_UNITY_HUB_EDITORS_ENV,
  discoverUnityEditorExecutableCandidates,
  UNITY_STATIC_EDITOR_PATHS,
} from "../../dcc/unityProbe";
import { createDirectorDccEngineBridge } from "../../dcc/engineBridge";

/** The real repository root, so the bridge validates the committed connector. */
const repositoryRoot = resolve(__dirname, "..", "..", "..", "..");

describe("Unity editor version ordering", () => {
  it("orders Unity Hub version directories newest-first across major eras", () => {
    const versions = ["2021.3.8f1", "6000.0.32f1", "2022.3.45f1", "2022.3.9f1", "2023.2.0b12", "2023.2.0f1"];
    expect([...versions].sort(compareUnityEditorVersionsDesc)).toEqual([
      "6000.0.32f1",
      "2023.2.0f1",
      "2023.2.0b12",
      "2022.3.45f1",
      "2022.3.9f1",
      "2021.3.8f1",
    ]);
  });

  it("sorts non-version directory names last", () => {
    expect(["notes", "2022.3.45f1", ".DS_Store"].sort(compareUnityEditorVersionsDesc)[0]).toBe("2022.3.45f1");
  });
});

describe("Unity editor candidate discovery per platform", () => {
  const listDirectory = vi.fn(async (path: string): Promise<string[]> => {
    if (path.endsWith("Hub/Editor") || path.endsWith("Hub\\Editor")) return ["2021.3.8f1", "6000.0.32f1"];
    throw new Error(`ENOENT: ${path}`);
  });

  it("scans the Linux Unity Hub home root and appends containerized layouts", async () => {
    const candidates = await discoverUnityEditorExecutableCandidates({
      environment: { HOME: "/home/director" },
      platform: "linux",
      listDirectory,
    });
    expect(candidates).toEqual([
      "/home/director/Unity/Hub/Editor/6000.0.32f1/Editor/Unity",
      "/home/director/Unity/Hub/Editor/2021.3.8f1/Editor/Unity",
      "/opt/unity/Editor/Unity",
      "/opt/Unity/Editor/Unity",
    ]);
  });

  it("scans the Windows Program Files Hub root with backslash paths", async () => {
    const candidates = await discoverUnityEditorExecutableCandidates({
      environment: { PROGRAMFILES: "D:\\Programs" },
      platform: "win32",
      listDirectory,
    });
    expect(candidates).toEqual([
      "D:\\Programs\\Unity\\Hub\\Editor\\6000.0.32f1\\Editor\\Unity.exe",
      "D:\\Programs\\Unity\\Hub\\Editor\\2021.3.8f1\\Editor\\Unity.exe",
      "C:\\Program Files\\Unity\\Editor\\Unity.exe",
    ]);
  });

  it("scans the macOS Hub app-bundle layout and keeps the legacy installer path", async () => {
    const candidates = await discoverUnityEditorExecutableCandidates({
      environment: {},
      platform: "darwin",
      listDirectory,
    });
    expect(candidates).toEqual([
      "/Applications/Unity/Hub/Editor/6000.0.32f1/Unity.app/Contents/MacOS/Unity",
      "/Applications/Unity/Hub/Editor/2021.3.8f1/Unity.app/Contents/MacOS/Unity",
      "/Applications/Unity/Unity.app/Contents/MacOS/Unity",
    ]);
  });

  it("prefers the DIRECTOR_UNITY_HUB_EDITORS override root before platform defaults", async () => {
    const lister = vi.fn(async (path: string): Promise<string[]> => {
      if (path === "/data/hub-editors") return ["2022.3.45f1"];
      throw new Error(`ENOENT: ${path}`);
    });
    const candidates = await discoverUnityEditorExecutableCandidates({
      environment: { [DIRECTOR_UNITY_HUB_EDITORS_ENV]: "/data/hub-editors", HOME: "/home/director" },
      platform: "linux",
      listDirectory: lister,
    });
    expect(candidates[0]).toBe("/data/hub-editors/2022.3.45f1/Editor/Unity");
    expect(lister).toHaveBeenCalledWith("/home/director/Unity/Hub/Editor");
  });

  it("ignores unreadable hub roots instead of failing discovery", async () => {
    const candidates = await discoverUnityEditorExecutableCandidates({
      environment: { HOME: "/nonexistent-home" },
      platform: "linux",
      listDirectory: vi.fn().mockRejectedValue(new Error("EACCES")),
    });
    expect(candidates).toEqual(UNITY_STATIC_EDITOR_PATHS.linux);
  });
});

describe("engine bridge Unity discovery through the probe", () => {
  it("finds a Unity Hub editor via the override root without DIRECTOR_UNITY_BIN", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-unity-hub-"));
    const hubRoot = resolve(root, "hub-editors");
    const platformSubpath =
      process.platform === "darwin"
        ? "Unity.app/Contents/MacOS/Unity"
        : process.platform === "win32"
          ? "Editor/Unity.exe"
          : "Editor/Unity";
    const editorPath = resolve(hubRoot, "2022.3.45f1", platformSubpath);
    await mkdir(dirname(editorPath), { recursive: true });
    await writeFile(editorPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const bridge = createDirectorDccEngineBridge({
      workspaceRoot: repositoryRoot,
      dataDirectory: resolve(root, "data"),
      exchangePackager: { exportPackage: vi.fn() },
      environment: { PATH: "", [DIRECTOR_UNITY_HUB_EDITORS_ENV]: hubRoot },
      probeHostVersion: async () => "Unity 2022.3.45f1 fixture",
      healthTtlMs: 0,
    });
    const health = await bridge.health("unity");
    expect(health.executable).toBe(editorPath);
    expect(health.checks).toContainEqual(expect.objectContaining({ id: "executable", ok: true }));
  });
});
