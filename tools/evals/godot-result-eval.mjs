#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const referencePath = resolve(repoRoot, "tools/evals/fixtures/godot-room-reference.ppm");
const resultDirectory = resolve(repoRoot, ".runtime/evals/godot-result");
const width = 640;
const height = 360;
const minimumScore = 82;

const projectSettings = `[application]
config/name="Director Godot Result Eval"
run/main_scene="res://main.tscn"

[display]
window/size/viewport_width=${width}
window/size/viewport_height=${height}
window/size/window_width_override=${width}
window/size/window_height_override=${height}

[rendering]
renderer/rendering_method="gl_compatibility"
renderer/rendering_method.mobile="gl_compatibility"
environment/defaults/default_clear_color=Color(0.025, 0.035, 0.065, 1)
`;

const scene = `[gd_scene load_steps=2 format=3]

[ext_resource path="res://main.gd" type="Script" id="1"]

[node name="ResultRoom" type="Node3D"]
script = ExtResource("1")
`;

const roomScript = `extends Node3D

var rendered_frames := 0

func box(name: String, size: Vector3, position: Vector3, color: Color) -> void:
    var body := StaticBody3D.new()
    body.name = name
    body.position = position
    var mesh := MeshInstance3D.new()
    var shape := BoxMesh.new()
    shape.size = size
    var material := StandardMaterial3D.new()
    material.albedo_color = color
    material.roughness = 0.72
    shape.material = material
    mesh.mesh = shape
    body.add_child(mesh)
    var collision := CollisionShape3D.new()
    var collision_shape := BoxShape3D.new()
    collision_shape.size = size
    collision.shape = collision_shape
    body.add_child(collision)
    add_child(body)

func _ready() -> void:
    print("DIRECTOR_GODOT_RESULT_RUNNABLE")
    box("Floor", Vector3(10.0, 0.2, 8.0), Vector3(0.0, -0.1, 0.0), Color("34445f"))
    box("BackWall", Vector3(10.0, 3.2, 0.25), Vector3(0.0, 1.6, -4.0), Color("64748b"))
    box("LeftWall", Vector3(0.25, 3.2, 8.0), Vector3(-5.0, 1.6, 0.0), Color("52627a"))
    box("RightWall", Vector3(0.25, 3.2, 8.0), Vector3(5.0, 1.6, 0.0), Color("52627a"))
    box("CoverA", Vector3(1.2, 1.1, 1.2), Vector3(-2.2, 0.55, -0.8), Color("e9a23b"))
    box("CoverB", Vector3(1.4, 0.75, 2.0), Vector3(2.0, 0.375, 0.7), Color("37b7a5"))
    box("Goal", Vector3(1.2, 2.2, 0.22), Vector3(0.0, 1.1, -3.82), Color("e95478"))

    var light := DirectionalLight3D.new()
    light.rotation_degrees = Vector3(-52.0, -28.0, 0.0)
    light.light_energy = 1.25
    light.shadow_enabled = true
    add_child(light)

    var fill := OmniLight3D.new()
    fill.position = Vector3(0.0, 3.8, 1.5)
    fill.light_color = Color("9ec7ff")
    fill.light_energy = 4.0
    fill.omni_range = 12.0
    add_child(fill)

    var camera := Camera3D.new()
    camera.name = "GameplayCamera"
    camera.position = Vector3(7.8, 6.6, 9.6)
    camera.fov = 47.0
    add_child(camera)
    camera.look_at_from_position(camera.position, Vector3(0.0, 0.75, -0.5))
    camera.current = true

func _process(_delta: float) -> void:
    rendered_frames += 1
    if rendered_frames != 6:
        return
    set_process(false)
    await RenderingServer.frame_post_draw
    var image := get_viewport().get_texture().get_image()
    var output_path := OS.get_environment("DIRECTOR_GODOT_RESULT_FRAME")
    var grid_path := OS.get_environment("DIRECTOR_GODOT_RESULT_GRID")
    image.save_png(output_path)
    var sample := image.duplicate()
    sample.resize(16, 9, Image.INTERPOLATE_LANCZOS)
    var pixels: Array = []
    for y in range(sample.get_height()):
        for x in range(sample.get_width()):
            var pixel: Color = sample.get_pixel(x, y)
            pixels.append([pixel.r8, pixel.g8, pixel.b8])
    var file := FileAccess.open(grid_path, FileAccess.WRITE)
    file.store_string(JSON.stringify({"width": 16, "height": 9, "pixels": pixels}))
    print("DIRECTOR_GODOT_RESULT_CAPTURED")
    get_tree().quit()
`;

async function executablePath() {
  const candidates = [
    process.env.DIRECTOR_GODOT_BIN,
    process.platform === "darwin" ? "/Applications/Godot.app/Contents/MacOS/Godot" : undefined,
    "/usr/bin/godot4",
    "/usr/bin/godot",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (
      await access(candidate)
        .then(() => true)
        .catch(() => false)
    )
      return candidate;
  }
  throw new Error("Godot 4 was not found. Set DIRECTOR_GODOT_BIN to the editor executable.");
}

function run(executable, args, environment) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, args, {
      cwd: repoRoot,
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error(`Godot result eval exceeded 120 seconds.\n${output}`));
    }, 120_000);
    const append = (chunk) => {
      output = (output + chunk).slice(-64 * 1024);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveRun(output);
      else rejectRun(new Error(`Godot exited with code ${code ?? "unknown"}.\n${output}`));
    });
  });
}

function parsePpm(source) {
  const tokens = source
    .replace(/#[^\n]*/g, "")
    .trim()
    .split(/\s+/);
  if (tokens.shift() !== "P3") throw new Error("The Godot result reference must be a P3 PPM image.");
  const referenceWidth = Number(tokens.shift());
  const referenceHeight = Number(tokens.shift());
  const maximum = Number(tokens.shift());
  const values = tokens.map(Number);
  if (maximum !== 255 || values.length !== referenceWidth * referenceHeight * 3) {
    throw new Error("The Godot result reference dimensions or pixel count are invalid.");
  }
  const pixels = [];
  for (let index = 0; index < values.length; index += 3) pixels.push(values.slice(index, index + 3));
  return { width: referenceWidth, height: referenceHeight, pixels };
}

function score(actual, reference) {
  if (actual.width !== reference.width || actual.height !== reference.height) return 0;
  let difference = 0;
  for (let index = 0; index < reference.pixels.length; index += 1) {
    for (let channel = 0; channel < 3; channel += 1) {
      difference += Math.abs(actual.pixels[index][channel] - reference.pixels[index][channel]);
    }
  }
  return Math.max(0, 100 * (1 - difference / (reference.pixels.length * 3 * 255)));
}

async function main() {
  const executable = await executablePath();
  const temporaryProject = await mkdtemp(resolve(tmpdir(), "director-godot-result-"));
  const framePath = resolve(temporaryProject, "room.png");
  const gridPath = resolve(temporaryProject, "room-grid.json");
  try {
    await Promise.all([
      writeFile(resolve(temporaryProject, "project.godot"), projectSettings),
      writeFile(resolve(temporaryProject, "main.tscn"), scene),
      writeFile(resolve(temporaryProject, "main.gd"), roomScript),
    ]);
    const output = await run(
      executable,
      ["--path", temporaryProject, "--resolution", `${width}x${height}`, "--rendering-method", "gl_compatibility"],
      {
        DIRECTOR_GODOT_RESULT_FRAME: framePath,
        DIRECTOR_GODOT_RESULT_GRID: gridPath,
      },
    );
    const runnable = output.includes("DIRECTOR_GODOT_RESULT_RUNNABLE");
    const captured = output.includes("DIRECTOR_GODOT_RESULT_CAPTURED");
    const actual = JSON.parse(await readFile(gridPath, "utf8"));
    const reference = parsePpm(await readFile(referencePath, "utf8"));
    const visualScore = score(actual, reference);
    await mkdir(resultDirectory, { recursive: true });
    await cp(framePath, resolve(resultDirectory, "room.png"));
    const report = {
      provider: "godot",
      runnable,
      captured,
      visualScore: Number(visualScore.toFixed(2)),
      minimumScore,
      passed: runnable && captured && visualScore >= minimumScore,
      frame: resolve(resultDirectory, "room.png"),
      reference: referencePath,
    };
    await writeFile(resolve(resultDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.passed ? 0 : 1;
  } finally {
    await rm(temporaryProject, { recursive: true, force: true });
  }
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  return 1;
});
