import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDirectorDccEngineFrameRenderer } from "../../dcc/engineCapture";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function createEngineHarness(provider: "godot" | "unity") {
  const root = await mkdtemp(resolve(tmpdir(), `director-${provider}-frame-`));
  temporaryRoots.push(root);
  const projectPath = resolve(root, "Project");
  const dataDirectory = resolve(root, "data");
  const argvCapture = resolve(root, "argv.txt");
  const executable = resolve(root, provider);
  await mkdir(projectPath, { recursive: true });
  await writeFile(
    executable,
    `#!/bin/sh
printf '%s\\n' "$@" > ${JSON.stringify(argvCapture)}
output=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--write-movie' ] || [ "$1" = '-directorRenderOutput' ]; then
    shift
    output="$1"
  fi
  shift
done
printf 'fixture-png' > "$output"
`,
    { mode: 0o755 },
  );
  const environment = {
    PATH: "",
    ...(provider === "godot"
      ? { DIRECTOR_GODOT_BIN: executable, DIRECTOR_GODOT_PROJECT: projectPath }
      : { DIRECTOR_UNITY_BIN: executable, DIRECTOR_UNITY_PROJECT: projectPath }),
  };
  return { root, projectPath, dataDirectory, argvCapture, executable, environment };
}

describe("Director DCC engine frame renderer", () => {
  it("renders a Godot scene through Movie Maker and returns the resulting image", async () => {
    const harness = await createEngineHarness("godot");
    const renderer = createDirectorDccEngineFrameRenderer({
      dataDirectory: harness.dataDirectory,
      environment: harness.environment,
    });

    const result = await renderer.render("godot", {
      scene: "res://scenes/main.tscn",
      width: 800,
      height: 450,
    });

    expect(result.receipt).toMatchObject({ provider: "godot", status: "rendered", width: 800, height: 450 });
    expect(Buffer.from(result.imageBase64!, "base64").toString("utf8")).toBe("fixture-png");
    const argv = (await readFile(harness.argvCapture, "utf8")).trim().split("\n");
    expect(argv).toEqual([
      "--path",
      await realpath(harness.projectPath),
      "--resolution",
      "800x450",
      "--write-movie",
      expect.stringMatching(/engine-frames\/godot\/.+\/frame\.png$/),
      "--fixed-fps",
      "24",
      "--quit-after",
      "2",
      "res://scenes/main.tscn",
    ]);
  });

  it("renders a Unity project scene without disabling graphics", async () => {
    const harness = await createEngineHarness("unity");
    const renderer = createDirectorDccEngineFrameRenderer({
      dataDirectory: harness.dataDirectory,
      environment: harness.environment,
    });

    const result = await renderer.render("unity", {
      scene: "Assets/Scenes/Main.unity",
      camera: "Gameplay Camera",
      width: 1_280,
      height: 720,
    });

    expect(result.receipt).toMatchObject({ provider: "unity", status: "rendered", width: 1_280, height: 720 });
    const argv = (await readFile(harness.argvCapture, "utf8")).trim().split("\n");
    expect(argv).toContain("Director.Bridge.Editor.DirectorBridgeCli.Render");
    expect(argv).toContain("Assets/Scenes/Main.unity");
    expect(argv).toContain("Gameplay Camera");
    expect(argv).not.toContain("-nographics");
  });

  it("requires an existing send job before rendering an Unreal level", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "director-unreal-frame-"));
    temporaryRoots.push(root);
    const renderer = createDirectorDccEngineFrameRenderer({ dataDirectory: root });

    await expect(renderer.render("unreal")).rejects.toMatchObject({
      code: "engine_run_invalid",
      status: 400,
    });
  });
});
