import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const script = resolve(dirname(fileURLToPath(import.meta.url)), "director_return_export.py");
const bridgeScript = resolve(dirname(fileURLToPath(import.meta.url)), "director_bridge.py");
const signatureScript = resolve(dirname(fileURLToPath(import.meta.url)), "director_signature.py");

async function runPython(source: string) {
  return execFileAsync("python3", ["-c", source, script]);
}

describe("Blender return exporter CLI", () => {
  it("is import-safe without bpy and exposes the documented CLI", async () => {
    const { stdout } = await execFileAsync("python3", [script, "--", "--help"]);
    expect(stdout).toContain("--source-manifest");
    expect(stdout).toContain("--output-dir");
    expect(stdout).toContain("--report");
  });

  it("contains stable-ID extras, hashing, and no remote execution primitives", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) => readFile(script, "utf8"));
    expect(source).toContain('root["director"]');
    expect(source).toContain('"stableId"');
    expect(source).toContain("inject_stable_id_extras");
    expect(source).toContain("sha256_file");
    expect(source).toContain("mesh_content_signature");
    expect(source).toContain("Matrix.Identity(4)");
    expect(source).toContain("with asset_space_root(root)");
    expect(source).not.toMatch(/\b(requests|urllib|eval|exec)\s*\(/);
  });

  it("shares one mesh_content_signature implementation between export and return bridges", async () => {
    const { readFile } = await import("node:fs/promises");
    const [returnSource, bridgeSource, sharedSource] = await Promise.all([
      readFile(script, "utf8"),
      readFile(bridgeScript, "utf8"),
      readFile(signatureScript, "utf8"),
    ]);
    for (const source of [returnSource, bridgeSource]) {
      expect(source).toMatch(/from director_signature import [^\n]*\bmesh_content_signature\b/);
      expect(source).toMatch(/from director_signature import [^\n]*\barmature_pose_fingerprint\b/);
      expect(source).not.toContain("def mesh_content_signature");
      expect(source).not.toContain("def armature_pose_fingerprint");
    }
    expect(sharedSource).toContain("def mesh_content_signature");
    expect(sharedSource).toContain("def armature_pose_fingerprint");
    expect(sharedSource).not.toMatch(/\b(requests|urllib|eval|exec)\s*\(/);
  });

  it("keeps the stamped mesh signature algorithm byte-stable for existing .blend baselines", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
shared = sys.modules["director_signature"]

class FakeCollection:
    def __init__(self, count, values):
        self._count = count
        self._values = values
    def __len__(self):
        return self._count
    def __bool__(self):
        return self._count > 0
    def foreach_get(self, attribute, values):
        for index in range(len(values)):
            values[index] = self._values[index % len(self._values)]

class FakeMaterial:
    name = "Fixture material"
    diffuse_color = (0.5, 0.25, 0.125, 1.0)
    use_nodes = False
    node_tree = None

class FakeUvLayer:
    def __init__(self):
        self.data = FakeCollection(4, [0.25, 0.75])

class FakeMesh:
    def __init__(self, vertices):
        self.vertices = FakeCollection(3, vertices)
        self.edges = FakeCollection(3, [0, 1, 2])
        self.loops = FakeCollection(3, [2, 0, 1])
        self.polygons = FakeCollection(1, [0, 3, 0])
        self.uv_layers = [FakeUvLayer()]
        self.shape_keys = None
        self.materials = [FakeMaterial()]
    def update(self):
        pass

class FakeChild:
    def __init__(self, vertices):
        self.type = "MESH"
        self.matrix_local = [[1.0,0.0,0.0,0.25],[0.0,1.0,0.0,-0.5],[0.0,0.0,1.0,2.0],[0.0,0.0,0.0,1.0]]
        self.animation_data = None
        self.data = FakeMesh(vertices)
        self.children_recursive = []

class FakeRoot:
    def __init__(self, vertices):
        self.type = "EMPTY"
        self.children_recursive = [FakeChild(vertices)]

signature = module.mesh_content_signature(FakeRoot([0.0, 1.0, -1.5]))
changed = module.mesh_content_signature(FakeRoot([0.0, 1.0, -1.25]))
print(json.dumps({
    "shared": module.mesh_content_signature is shared.mesh_content_signature,
    "signature": signature,
    "changed": changed != signature,
}))
`);
    expect(JSON.parse(stdout)).toEqual({
      shared: true,
      // Computed with the pre-refactor duplicated implementation; a mismatch
      // means every stamped .blend would misreport mesh_changed on return.
      signature: "adeb708ec47ef03189e328066c55743155761321d53b29c6bc9731c98ecdde6e",
      changed: true,
    });
  });

  it("treats opposite-sign quaternions as the same rotation", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
base = {"location":[1,2,3],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
opposite = {"location":[1,2,3],"rotationQuaternion":[0,0,0,-1],"scale":[1,1,1]}
changed = {"location":[1,2,3],"rotationQuaternion":[0,0.2,0,0.98],"scale":[1,1,1]}
print(json.dumps([module.transforms_equal(base, opposite), module.transforms_equal(base, changed)]))
`);
    expect(JSON.parse(stdout)).toEqual([true, false]);
  });

  it("emits no changes for stored no-op mesh and camera baselines", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
aimed = {"location":[0,0,0],"rotationQuaternion":[0,0,0,-1],"scale":[1,1,1]}
class Root(dict):
    def __init__(self, name, kind, director_id, baseline, signature=None):
        super().__init__(director_id=director_id, director_source_transform=json.dumps(baseline))
        if signature is not None:
            self["director_source_mesh_signature"] = signature
        self.name, self.type, self.parent, self.children_recursive = name, kind, None, []
mesh = Root("Mesh", "EMPTY", "object-1", identity, "same")
camera = Root("Camera", "CAMERA", "camera-1", aimed)
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [mesh, camera]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda root: identity if root is mesh else aimed
module.descendant_meshes = lambda root: [object()] if root is mesh else []
module.mesh_content_signature = lambda root: "same"
source = {
  "packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64,
  "objects":[{"id":"object-1","name":"Object","kind":"prop","transform":identity}],
  "cameras":[{"id":"camera-1","transform":identity}]
}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps(result["changes"]))
`);
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it("emits only a transform update when mesh content is unchanged", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
moved = {"location":[2,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
class Root(dict):
    def __init__(self):
        super().__init__(director_id="object-1", director_source_transform=json.dumps(identity), director_source_mesh_signature="same")
        self.name, self.type, self.parent, self.children_recursive = "Mesh", "EMPTY", None, []
root = Root()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [root]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: moved
module.descendant_meshes = lambda unused: [object()]
module.mesh_content_signature = lambda unused: "same"
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[{"id":"object-1","name":"Object","kind":"prop","transform":identity}], "cameras":[]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps(result["changes"]))
`);
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({
        kind: "transform_update",
        directorId: "object-1",
        transform: { location: [2, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      }),
    ]);
  });

  it("keeps an unchanged Director wrapper transform out of a mesh-only replacement", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
class Root(dict):
    def __init__(self):
        super().__init__(director_id="object-1", director_source_transform=json.dumps(identity), director_source_mesh_signature="before")
        self.name, self.type, self.parent, self.children_recursive = "Mesh", "EMPTY", None, []
root = Root()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [root]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: identity
module.descendant_meshes = lambda unused: [object()]
module.mesh_content_signature = lambda unused: "after"
module.unapplied_modifier_warnings = lambda unused: []
module.export_glb = lambda unused_root, destination, unused_source: destination.write_bytes(b"glb")
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[{"id":"object-1","name":"Object","kind":"prop","transform":identity}], "cameras":[]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps(result["changes"]))
`);
    expect(JSON.parse(stdout)).toEqual([expect.objectContaining({ kind: "mesh_replacement", directorId: "object-1" })]);
    expect(JSON.parse(stdout)[0]).not.toHaveProperty("transform");
  });

  it("keeps Director targets authoritative and stamps their evaluated camera baseline", async () => {
    const bridge = await import("node:fs/promises").then(({ readFile }) => readFile(bridgeScript, "utf8"));
    expect(bridge).toContain('aim_camera(camera_object, item["target"])');
    expect(bridge).toContain('camera_object["director_camera_orientation_authority"] = "target"');
    expect(bridge).toContain('aim_camera(camera_object, keyframe.get("lookTarget", base_target))');
    expect(bridge).toContain("stamp_source_baselines(payload)");
  });

  it("imports Director lights, stamps pose controls, and stamps optics baselines in the bridge", async () => {
    const bridge = await import("node:fs/promises").then(({ readFile }) => readFile(bridgeScript, "utf8"));
    // Lights: concrete Blender datablocks with the deterministic energy already
    // computed by the scene package builder, plus a diffable baseline.
    expect(bridge).toContain("def add_light(");
    expect(bridge).toContain('BLENDER_LIGHT_TYPES = {"directional": "SUN", "point": "POINT", "spot": "SPOT", "rect-area": "AREA"}');
    expect(bridge).toContain("light_object[SOURCE_LIGHT_PROPERTY]");
    // Director sends the authored lights; the default previz rig must not double-light them.
    expect(bridge).toMatch(/if payload\.get\("lights"\):\n[^\n]*\n[^\n]*\n\s+return/);
    // Pose controls: immutable baseline JSON plus editable per-control properties.
    expect(bridge).toContain("root[POSE_CONTROLS_BASELINE_PROPERTY]");
    expect(bridge).toContain("root[POSE_CONTROL_PREFIX + control] = float(value)");
    // Optics baseline is stamped from evaluated camera data after frame_set.
    expect(bridge).toContain("def camera_optics_state(");
    expect(bridge).toContain("root[SOURCE_CAMERA_OPTICS_PROPERTY]");
    expect(bridge).toContain("root[SOURCE_POSE_FINGERPRINT_PROPERTY]");
  });

  it("emits camera_update with only the changed optics and bundles the moved transform", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
moved = {"location":[1,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
baseline = {"focalLengthMm":35.0,"apertureFStop":2.8,"focusDistanceM":3.0,"nearClipM":0.1,"farClipM":500.0,"sensorWidthMm":36.0,"sensorHeightMm":20.25,"sensorFormat":"super35"}
class Root(dict):
    def __init__(self):
        super().__init__(director_id="camera-1", director_source_transform=json.dumps(identity), director_source_camera_optics=json.dumps(baseline))
        self.name, self.type, self.parent, self.children_recursive = "Camera", "CAMERA", None, []
root = Root()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [root]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: moved
module.current_camera_optics = lambda unused: {**baseline, "focalLengthMm": 85.0, "focusDistanceM": 1.5}
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[], "cameras":[{"id":"camera-1","transform":identity}]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps({"changes": result["changes"], "warnings": result["warnings"]}))
`);
    const result = JSON.parse(stdout);
    expect(result.changes).toEqual([
      {
        kind: "camera_update",
        directorId: "camera-1",
        entityType: "camera",
        optics: { focalLengthMm: 85, focusDistanceM: 1.5 },
        transform: { location: [1, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("warns and omits Blender sensor-dimension edits instead of guessing a Director sensor gate", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
baseline = {"focalLengthMm":35.0,"apertureFStop":2.8,"focusDistanceM":3.0,"nearClipM":0.1,"farClipM":500.0,"sensorWidthMm":36.0,"sensorHeightMm":20.25}
current = {**baseline, "sensorWidthMm": 54.12}
optics, warnings = module.diff_camera_optics(baseline, current)
print(json.dumps({"optics": optics, "warnings": warnings}))
`);
    const result = JSON.parse(stdout);
    expect(result.optics).toEqual({});
    expect(result.warnings).toEqual([expect.stringContaining("named gates")]);
  });

  it("omits legacy-blend optics edits with a re-export warning instead of guessing", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
class Root(dict):
    def __init__(self):
        super().__init__(director_id="camera-1", director_source_transform=json.dumps(identity))
        self.name, self.type, self.parent, self.children_recursive = "Camera", "CAMERA", None, []
root = Root()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [root]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: identity
module.current_camera_optics = lambda unused: {"focalLengthMm": 85.0, "apertureFStop": 2.8, "focusDistanceM": 3.0, "nearClipM": 0.1, "farClipM": 500.0}
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[], "cameras":[{"id":"camera-1","transform":identity,"focalLengthMm":35.0,"apertureFStop":2.8,"focusDistanceM":3.0,"nearClipM":0.1,"farClipM":500.0}]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps({"changes": result["changes"], "warnings": result["warnings"]}))
`);
    const result = JSON.parse(stdout);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("predates stamped optics baselines")]);
  });

  it("emits light_update for edited director_id lights and inverts the stamped watts factor", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[2,1,3],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
baseline = {"type":"point","position":[2.0,1.0,3.0],"color":"#ffaa00","intensity":40.0,"energy":2000.0,"wattsPerIntensity":50.0}
class Light(dict):
    def __init__(self):
        super().__init__(director_id="light-1", director_source_transform=json.dumps(identity), director_source_light=json.dumps(baseline))
        self.name, self.type, self.parent, self.children_recursive = "Key", "LIGHT", None, []
light = Light()
untouched_baseline = {**baseline, "position": [0.0, 0.0, 5.0]}
class Untouched(dict):
    def __init__(self):
        super().__init__(director_id="light-2", director_source_transform=json.dumps(identity), director_source_light=json.dumps(untouched_baseline))
        self.name, self.type, self.parent, self.children_recursive = "Fill", "LIGHT", None, []
untouched = Untouched()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [light, untouched]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: identity
def fake_state(root, base):
    if root is light:
        return {"position": [4.0, 1.0, 3.0], "color": "#ffaa00", "energy": 3000.0}
    return {"position": base["position"], "color": base["color"], "energy": base["energy"]}
module.current_light_state = fake_state
source = {
  "packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64,
  "objects":[], "cameras":[],
  "lights":[{"id":"light-1", **baseline}, {"id":"light-2", **untouched_baseline}],
}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps({"changes": result["changes"], "warnings": result["warnings"]}))
`);
    const result = JSON.parse(stdout);
    expect(result.changes).toEqual([
      {
        kind: "light_update",
        directorId: "light-1",
        entityType: "light",
        properties: { position: [4, 1, 3], intensity: 60 },
      },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("bakes out-of-range light energy to Director's 0-100 intensity with a warning", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
baseline = {"type":"point","position":[0.0,0.0,0.0],"color":"#ffffff","intensity":40.0,"energy":2000.0,"wattsPerIntensity":50.0}
current = {"position":[0.0,0.0,0.0],"color":"#ffffff","energy":999999.0}
properties, warnings = module.light_update_properties(baseline, current)
print(json.dumps({"properties": properties, "warnings": warnings}))
`);
    const result = JSON.parse(stdout);
    expect(result.properties).toEqual({ intensity: 100 });
    expect(result.warnings).toEqual([expect.stringContaining("baked to 100")]);
  });

  it("warns about untracked Blender lights but stays silent about the Director previz rig", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Plain:
    def __init__(self, name, kind):
        self.name, self.type, self.parent, self.children_recursive = name, kind, None, []
    def get(self, key, default=None):
        return default
rig = Plain("Director_Key_Light", "LIGHT")
foreign = Plain("Artist_Light", "LIGHT")
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [rig, foreign]})()})(), "app": type("App", (), {"version_string": "test"})()})()
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[], "cameras":[]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps({"changes": result["changes"], "warnings": result["warnings"]}))
`);
    const result = JSON.parse(stdout);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("Artist_Light")]);
    expect(result.warnings[0]).toContain("does not auto-create lights");
  });

  it("emits a full pose_update sample with root motion when director_pose.* controls change", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
moved = {"location":[0.5,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
baseline = {"head.yaw": 0.0, "leftElbow.bend": 15.0}
class Root(dict):
    def __init__(self):
        super().__init__(
            director_id="character-1",
            director_source_transform=json.dumps(identity),
            director_source_mesh_signature="same",
            director_pose_controls=json.dumps(baseline),
        )
        self["director_pose.head.yaw"] = 25.0
        self["director_pose.leftElbow.bend"] = 15.0
        self["director_pose.not.a.control"] = 3.0
        self.name, self.type, self.parent, self.children_recursive = "Hero", "EMPTY", None, []
root = Root()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [root]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: moved
module.descendant_meshes = lambda unused: [object()]
module.mesh_content_signature = lambda unused: "same"
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[{"id":"character-1","name":"Hero","kind":"character","transform":identity}], "cameras":[]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps({"changes": result["changes"], "warnings": result["warnings"]}))
`);
    const result = JSON.parse(stdout);
    expect(result.changes).toEqual([
      {
        kind: "pose_update",
        directorId: "character-1",
        entityType: "object",
        controls: { "head.yaw": 25, "leftElbow.bend": 15 },
        transform: { location: [0.5, 0, 0], rotationQuaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      },
    ]);
    expect(result.warnings).toEqual([expect.stringContaining("not a portable Director control")]);
  });

  it("prefers mesh_replacement over a simultaneous pose edit and warns instead of dropping it silently", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
baseline = {"head.yaw": 0.0}
class Root(dict):
    def __init__(self):
        super().__init__(
            director_id="character-1",
            director_source_transform=json.dumps(identity),
            director_source_mesh_signature="before",
            director_pose_controls=json.dumps(baseline),
        )
        self["director_pose.head.yaw"] = 20.0
        self.name, self.type, self.parent, self.children_recursive = "Hero", "EMPTY", None, []
root = Root()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [root]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: identity
module.descendant_meshes = lambda unused: [object()]
module.mesh_content_signature = lambda unused: "after"
module.unapplied_modifier_warnings = lambda unused: []
module.export_glb = lambda unused_root, destination, unused_source: destination.write_bytes(b"glb")
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[{"id":"character-1","name":"Hero","kind":"character","transform":identity}], "cameras":[]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps({"kinds": [change["kind"] for change in result["changes"]], "warnings": result["warnings"]}))
`);
    const result = JSON.parse(stdout);
    expect(result.kinds).toEqual(["mesh_replacement"]);
    expect(result.warnings).toEqual([expect.stringContaining("pose sample was omitted")]);
  });

  it("warns about direct armature pose-bone edits instead of pretending to reconcile them", async () => {
    const { stdout } = await runPython(String.raw`
import importlib.util, json, sys, tempfile
from pathlib import Path
spec = importlib.util.spec_from_file_location("director_return_export", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
identity = {"location":[0,0,0],"rotationQuaternion":[0,0,0,1],"scale":[1,1,1]}
class Root(dict):
    def __init__(self):
        super().__init__(
            director_id="character-1",
            director_source_transform=json.dumps(identity),
            director_source_mesh_signature="same",
            director_source_pose_bones="fingerprint-at-import",
        )
        self.name, self.type, self.parent, self.children_recursive = "Hero", "EMPTY", None, []
root = Root()
module.bpy = type("Bpy", (), {"context": type("Context", (), {"scene": type("Scene", (), {"objects": [root]})()})(), "app": type("App", (), {"version_string": "test"})()})()
module.blender_transform = lambda unused: identity
module.descendant_meshes = lambda unused: [object()]
module.mesh_content_signature = lambda unused: "same"
module.armature_pose_fingerprint = lambda unused: "fingerprint-after-edit"
source = {"packageId":"source", "sourceRevision":"director-project-revision:v1:sha256:" + "0" * 64, "objects":[{"id":"character-1","name":"Hero","kind":"character","transform":identity}], "cameras":[]}
with tempfile.TemporaryDirectory() as directory:
    result = module.build_return_package(source, Path(directory))
print(json.dumps({"changes": result["changes"], "warnings": result["warnings"]}))
`);
    const result = JSON.parse(stdout);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([expect.stringContaining("not\u0020reconciled")]);
  });
});
