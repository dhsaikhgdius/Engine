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
      expect(source).toContain("from director_signature import mesh_content_signature");
      expect(source).not.toContain("def mesh_content_signature");
    }
    expect(sharedSource).toContain("def mesh_content_signature");
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
});
