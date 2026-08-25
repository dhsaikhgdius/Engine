// Director scene exporter for Unity (Editor-only).
//
// Exports the currently open (or explicitly requested) scene into a portable
// ``director-engine-scene-v1`` package that Director's gateway can validate,
// plan, and import. The package contains:
//
// - ``manifest.json`` — scene metadata, hierarchy snapshot, cameras, lights,
//   animation clip inventory, warnings, and SHA-256 hashes for every file.
// - ``assets/scene.glb`` — renderable scene geometry exported through the
//   ``com.unity.cloud.gltfast`` package when it is installed in the project.
//   Materials, skinned meshes, and animation data ride embedded in this GLB.
//
// Every transform written into the manifest is converted from Unity's
// left-handed Y-up meter convention into Director's right-handed Y-up meter
// convention using the documented linear map ``(x,y,z)->(-x,y,z)``.
//
// Run headless (Director's gateway does this for ``extract_engine_scene``;
// it copies this file into ``Assets/Editor/DirectorInterchange/`` first):
//
//     Unity -batchmode -nographics -quit -projectPath <project> \
//         -executeMethod DirectorInterchange.DirectorSceneExport.ExportFromCommandLine \
//         -directorOutputDir /abs/out [-directorScene Assets/Scenes/Main.unity] [-directorZip]
//
// The optional ``-directorZip`` flag additionally writes
// ``director-engine-scene.zip`` next to the output directory, ready to upload
// to ``POST /api/dcc/engine-scene/uploads?provider=unity``.

#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace DirectorInterchange
{
    public static class DirectorSceneExport
    {
        private const string ExporterName = "director-unity-scene-export";
        private const string ExporterVersion = "1.0.0";
        private const string Contract = "director-engine-scene-v1";
        private const int MaxNodes = 20000;
        private const float DefaultLookDistance = 10f;

        public static void ExportFromCommandLine()
        {
            try
            {
                var args = Environment.GetCommandLineArgs();
                var outputDir = ReadArgumentValue(args, "-directorOutputDir");
                if (string.IsNullOrWhiteSpace(outputDir))
                {
                    throw new ArgumentException("-directorOutputDir is required");
                }
                var scenePath = ReadArgumentValue(args, "-directorScene");
                var makeZip = args.Contains("-directorZip");
                Export(Path.GetFullPath(outputDir), scenePath, makeZip);
            }
            catch (Exception error)
            {
                Debug.LogError($"[director] Scene export failed: {error}");
                if (Application.isBatchMode)
                {
                    EditorApplication.Exit(1);
                }
                else
                {
                    throw;
                }
            }
        }

        public static string Export(string outputDir, string scenePath, bool makeZip)
        {
            if (!string.IsNullOrWhiteSpace(scenePath))
            {
                Debug.Log($"[director] Opening scene {scenePath}");
                EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
            }

            var scene = SceneManager.GetActiveScene();
            var warnings = new List<object>();
            var unsupported = new List<object>();
            var nodes = new List<object>();
            var cameras = new List<object>();
            var lights = new List<object>();
            var nodeIds = new HashSet<string>();
            var materials = new HashSet<Material>();
            var rootObjects = new List<GameObject>();
            int totalObjects = 0, meshCount = 0, skinnedCount = 0;
            var truncated = false;

            foreach (var root in scene.GetRootGameObjects())
            {
                rootObjects.Add(root);
                foreach (var transform in WalkDepthFirst(root.transform))
                {
                    totalObjects += 1;
                    var gameObject = transform.gameObject;
                    var kind = ClassifyNode(gameObject);
                    switch (kind)
                    {
                        case "camera":
                            if (cameras.Count < 512) cameras.Add(BuildCameraRecord(gameObject, warnings));
                            break;
                        case "light":
                            var record = BuildLightRecord(gameObject, warnings, unsupported);
                            if (record != null && lights.Count < 1024) lights.Add(record);
                            break;
                        case "mesh":
                            meshCount += 1;
                            break;
                        case "skinned-mesh":
                            skinnedCount += 1;
                            break;
                    }
                    foreach (var renderer in gameObject.GetComponents<Renderer>())
                    {
                        foreach (var material in renderer.sharedMaterials)
                        {
                            if (material != null) materials.Add(material);
                        }
                    }
                    if (nodes.Count < MaxNodes)
                    {
                        var node = new Dictionary<string, object>
                        {
                            ["sourceId"] = StableId(gameObject),
                            ["name"] = SafeName(gameObject.name, "GameObject"),
                            ["kind"] = kind,
                            ["transform"] = BuildTransformRecord(transform),
                        };
                        if (transform.parent != null)
                        {
                            node["parentSourceId"] = StableId(transform.parent.gameObject);
                        }
                        nodes.Add(node);
                        nodeIds.Add((string)node["sourceId"]);
                    }
                    else
                    {
                        truncated = true;
                    }
                }
            }
            if (truncated)
            {
                warnings.Add($"Hierarchy snapshot was truncated to {MaxNodes} nodes; the GLB bundle keeps the full scene.");
            }
            foreach (Dictionary<string, object> node in nodes)
            {
                if (node.TryGetValue("parentSourceId", out var parent) && !nodeIds.Contains((string)parent))
                {
                    node.Remove("parentSourceId");
                }
            }

            var ambient = BuildAmbientLightRecord(warnings);
            if (ambient != null && lights.Count < 1024) lights.Add(ambient);

            Directory.CreateDirectory(outputDir);
            Directory.CreateDirectory(Path.Combine(outputDir, "assets"));
            const string bundleRelative = "assets/scene.glb";
            var bundlePath = Path.Combine(outputDir, "assets", "scene.glb");
            var bundleWritten = ExportGlb(rootObjects, scene.name, bundlePath, warnings, unsupported, meshCount + skinnedCount);
            if (!bundleWritten && (meshCount > 0 || skinnedCount > 0))
            {
                foreach (Dictionary<string, object> node in nodes)
                {
                    var kind = (string)node["kind"];
                    if (kind == "mesh" || kind == "skinned-mesh")
                    {
                        unsupported.Add(new Dictionary<string, object>
                        {
                            ["kind"] = kind,
                            ["name"] = node["name"],
                            ["reason"] = "Geometry was not exported because the GLB bundle is unavailable.",
                        });
                    }
                }
                meshCount = 0;
                skinnedCount = 0;
            }

            var clips = CollectAnimationClips(warnings);
            var fileHashes = new Dictionary<string, object>();
            if (bundleWritten)
            {
                fileHashes[bundleRelative] = Sha256File(bundlePath);
            }

            var sceneName = SafeName(scene.name, "Scene");
            var projectName = SafeName(Application.productName, "UnityProject");
            var packageId = "unity-scene-" + Sha256Text(projectName + ":" + sceneName).Substring(0, 20);

            var manifest = new Dictionary<string, object>
            {
                ["schemaVersion"] = 1,
                ["contract"] = Contract,
                ["packageId"] = packageId,
                ["provider"] = "unity",
                ["exportedAt"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture),
                ["engineVersion"] = SafeName(Application.unityVersion, "unknown"),
                ["exporter"] = new Dictionary<string, object> { ["name"] = ExporterName, ["version"] = ExporterVersion },
                ["source"] = new Dictionary<string, object> { ["projectName"] = projectName, ["sceneName"] = sceneName },
                ["coordinateSystem"] = new Dictionary<string, object>
                {
                    ["source"] = "left-handed-y-up-z-forward-meter",
                    ["destination"] = "right-handed-y-up-negative-z-forward",
                    ["unit"] = "meter",
                    ["linearMap"] = "(x,y,z)->(-x,y,z)",
                },
                ["timeline"] = new Dictionary<string, object>
                {
                    ["frameStart"] = 0,
                    ["frameEnd"] = 0,
                    ["currentFrame"] = 0,
                    ["fps"] = 30,
                },
                ["scene"] = new Dictionary<string, object>
                {
                    ["name"] = sceneName,
                    ["bundleFile"] = bundleWritten ? bundleRelative : null,
                    ["nodeCount"] = Math.Max(totalObjects, nodes.Count),
                    ["meshCount"] = meshCount,
                    ["skinnedMeshCount"] = skinnedCount,
                    ["materialCount"] = materials.Count,
                    ["animationClipCount"] = clips.Count,
                },
                ["nodes"] = nodes,
                ["cameras"] = cameras,
                ["lights"] = lights,
                ["animationClips"] = clips,
                ["unsupported"] = Cap(unsupported, 20000),
                ["warnings"] = Cap(warnings, 20000),
                ["fileHashes"] = fileHashes,
            };

            var manifestPath = Path.Combine(outputDir, "manifest.json");
            File.WriteAllText(manifestPath, JsonWriter.Write(manifest), new UTF8Encoding(false));
            Debug.Log($"[director] Wrote {manifestPath}");

            if (makeZip)
            {
                var zipPath = Path.Combine(Directory.GetParent(outputDir).FullName, "director-engine-scene.zip");
                WriteZip(outputDir, zipPath);
                Debug.Log($"[director] Wrote {zipPath}");
            }
            return manifestPath;
        }

        // --- Coordinate conversion -------------------------------------------------
        // Basis change M = diag(-1, 1, 1) maps Unity's left-handed Y-up space into
        // Director's right-handed Y-up space. Points and directions map as
        // (x,y,z)->(-x,y,z); rotations conjugate as R' = M * R * M.

        private static double[] ToDirectorPoint(Vector3 point) =>
            new double[] { -point.x, point.y, point.z };

        private static double[] ToDirectorDirection(Vector3 direction) =>
            new double[] { -direction.x, direction.y, direction.z };

        private static double[] ToDirectorEulerXyz(Quaternion rotation)
        {
            var r = Matrix4x4.Rotate(rotation);
            // R' = M * R * M with M = diag(-1,1,1): negate row 0 and column 0.
            double m00 = r.m00, m01 = -r.m01, m02 = -r.m02;
            double m10 = -r.m10, m11 = r.m11, m12 = r.m12;
            double m20 = -r.m20, m21 = r.m21, m22 = r.m22;
            // Intrinsic XYZ Euler angles (radians) from the row-major matrix.
            var sy = Math.Max(-1.0, Math.Min(1.0, m02));
            var y = Math.Asin(sy);
            double x, z;
            if (Math.Abs(sy) < 0.999999)
            {
                x = Math.Atan2(-m12, m22);
                z = Math.Atan2(-m01, m00);
            }
            else
            {
                x = Math.Atan2(m21, m11);
                z = 0.0;
            }
            return new[] { x, y, z };
        }

        private static Dictionary<string, object> BuildTransformRecord(Transform transform)
        {
            var scale = transform.lossyScale;
            return new Dictionary<string, object>
            {
                ["position"] = ToDirectorPoint(transform.position),
                ["rotation"] = ToDirectorEulerXyz(transform.rotation),
                ["scale"] = new double[] { scale.x, scale.y, scale.z },
            };
        }

        // --- Node classification ---------------------------------------------------

        private static string ClassifyNode(GameObject gameObject)
        {
            if (gameObject.GetComponent<Camera>() != null) return "camera";
            if (gameObject.GetComponent<Light>() != null) return "light";
            if (gameObject.GetComponent<SkinnedMeshRenderer>() != null) return "skinned-mesh";
            if (gameObject.GetComponent<MeshRenderer>() != null && gameObject.GetComponent<MeshFilter>() != null) return "mesh";
            if (gameObject.transform.childCount > 0) return "group";
            return "other";
        }

        private static IEnumerable<Transform> WalkDepthFirst(Transform root)
        {
            yield return root;
            for (var i = 0; i < root.childCount; i += 1)
            {
                foreach (var child in WalkDepthFirst(root.GetChild(i)))
                {
                    yield return child;
                }
            }
        }

        private static string StableId(GameObject gameObject) =>
            Truncate(GlobalObjectId.GetGlobalObjectIdSlow(gameObject).ToString(), 240);

        // --- Cameras -----------------------------------------------------------------

        private static Dictionary<string, object> BuildCameraRecord(GameObject gameObject, List<object> warnings)
        {
            var camera = gameObject.GetComponent<Camera>();
            var name = SafeName(gameObject.name, "Camera");
            var position = ToDirectorPoint(gameObject.transform.position);
            var forward = ToDirectorDirection(gameObject.transform.forward);
            double focusDistance = 0;
            var record = new Dictionary<string, object>
            {
                ["sourceId"] = StableId(gameObject),
                ["name"] = name,
            };
            if (camera.usePhysicalProperties)
            {
                record["sensorWidthMm"] = Clamp(camera.sensorSize.x, 0.001, 1000);
                record["sensorHeightMm"] = Clamp(camera.sensorSize.y, 0.001, 1000);
                record["apertureFStop"] = Clamp(camera.aperture, 0.1, 256);
                if (camera.focusDistance > 0.01f)
                {
                    focusDistance = camera.focusDistance;
                    record["focusDistanceM"] = Clamp(focusDistance, 0.01, 1000000);
                }
            }
            else
            {
                warnings.Add($"Camera {name} is not a physical camera; sensor and aperture use Director defaults.");
            }
            var lookDistance = focusDistance > 0.01 ? focusDistance : DefaultLookDistance;
            var aspect = camera.aspect;
            if (float.IsNaN(aspect) || float.IsInfinity(aspect) || aspect <= 0f)
            {
                aspect = 16f / 9f;
                warnings.Add($"Camera {name} reported no valid aspect ratio (headless); 16:9 was assumed.");
            }
            record["position"] = position;
            record["lookTarget"] = new[]
            {
                position[0] + forward[0] * lookDistance,
                position[1] + forward[1] * lookDistance,
                position[2] + forward[2] * lookDistance,
            };
            record["verticalFovDegrees"] = Clamp(camera.fieldOfView, 0.1, 179);
            record["nearClipM"] = Clamp(camera.nearClipPlane, 0.0001, 100000);
            record["farClipM"] = Clamp(Math.Max(camera.farClipPlane, camera.nearClipPlane * 2f), 0.001, 10000000);
            record["renderAspectRatio"] = Clamp(aspect, 0.1, 20);
            return record;
        }

        // --- Lights --------------------------------------------------------------

        private static Dictionary<string, object> BuildLightRecord(
            GameObject gameObject,
            List<object> warnings,
            List<object> unsupported)
        {
            var light = gameObject.GetComponent<Light>();
            var name = SafeName(gameObject.name, "Light");
            var position = ToDirectorPoint(gameObject.transform.position);
            var forward = ToDirectorDirection(gameObject.transform.forward);
            var target = new[]
            {
                position[0] + forward[0] * DefaultLookDistance,
                position[1] + forward[1] * DefaultLookDistance,
                position[2] + forward[2] * DefaultLookDistance,
            };
            var record = new Dictionary<string, object>
            {
                ["sourceId"] = StableId(gameObject),
                ["name"] = name,
                ["color"] = ColorToHex(light.color),
                // Unity's unitless intensity (~1.0 for a typical light) maps directly
                // onto Director's unitless scale, clamped to the manifest range.
                ["intensity"] = Clamp(light.intensity, 0, 100),
                ["castShadow"] = light.shadows != LightShadows.None,
            };
            switch (light.type)
            {
                case LightType.Directional:
                    record["type"] = "directional";
                    record["position"] = position;
                    record["target"] = target;
                    return record;
                case LightType.Point:
                    record["type"] = "point";
                    record["position"] = position;
                    if (light.range > 0f) record["rangeM"] = Clamp(light.range, 0.001, 1000000);
                    return record;
                case LightType.Spot:
                    record["type"] = "spot";
                    record["position"] = position;
                    record["target"] = target;
                    record["angleDegrees"] = Clamp(light.spotAngle, 0.1, 179);
                    record["penumbra"] = light.spotAngle > 0f
                        ? Clamp(1f - light.innerSpotAngle / light.spotAngle, 0, 1)
                        : 0.0;
                    if (light.range > 0f) record["rangeM"] = Clamp(light.range, 0.001, 1000000);
                    return record;
                case LightType.Rectangle:
                    record["type"] = "rect-area";
                    record["position"] = position;
                    record["target"] = target;
                    record["widthM"] = Clamp(light.areaSize.x, 0.01, 1000000);
                    record["heightM"] = Clamp(light.areaSize.y, 0.01, 1000000);
                    warnings.Add($"Rect-area light {name} is baked-only in Unity; Director renders it in real time.");
                    return record;
                default:
                    unsupported.Add(new Dictionary<string, object>
                    {
                        ["kind"] = "light",
                        ["name"] = name,
                        ["reason"] = $"Unsupported Unity light type {light.type}; only directional, point, spot, and rectangle lights map to Director.",
                    });
                    return null;
            }
        }

        private static Dictionary<string, object> BuildAmbientLightRecord(List<object> warnings)
        {
            if (RenderSettings.ambientMode == AmbientMode.Flat)
            {
                warnings.Add("Flat ambient environment lighting was mapped to a Director ambient light.");
                return new Dictionary<string, object>
                {
                    ["sourceId"] = "unity-render-settings-ambient",
                    ["name"] = "Environment Ambient",
                    ["type"] = "ambient",
                    ["color"] = ColorToHex(RenderSettings.ambientLight),
                    ["intensity"] = Clamp(RenderSettings.ambientIntensity, 0, 100),
                };
            }
            warnings.Add($"Ambient mode {RenderSettings.ambientMode} (skybox/gradient) is not mapped to a Director light.");
            return null;
        }

        // --- Geometry (GLB via com.unity.cloud.gltfast, looked up reflectively) ----

        private static bool ExportGlb(
            List<GameObject> rootObjects,
            string sceneName,
            string bundlePath,
            List<object> warnings,
            List<object> unsupported,
            int renderableCount)
        {
            if (renderableCount == 0) return false;
            try
            {
                var exportType = AppDomain.CurrentDomain.GetAssemblies()
                    .Select(assembly => assembly.GetType("GLTFast.Export.GameObjectExport", false))
                    .FirstOrDefault(type => type != null);
                if (exportType == null)
                {
                    unsupported.Add(new Dictionary<string, object>
                    {
                        ["kind"] = "geometry",
                        ["name"] = "scene",
                        ["reason"] = "The com.unity.cloud.gltfast package is not installed; renderable geometry was skipped. Add it via the Unity Package Manager and re-export.",
                    });
                    return false;
                }
                var constructor = exportType.GetConstructors(BindingFlags.Public | BindingFlags.Instance).First();
                var export = constructor.Invoke(new object[constructor.GetParameters().Length]);
                var addScene = exportType
                    .GetMethods(BindingFlags.Public | BindingFlags.Instance)
                    .First(method =>
                    {
                        var parameters = method.GetParameters();
                        return method.Name == "AddScene"
                            && parameters.Length >= 1
                            && parameters[0].ParameterType == typeof(GameObject[])
                            && parameters.Skip(1).All(parameter => parameter.IsOptional || parameter.ParameterType == typeof(string));
                    });
                var addSceneArguments = new object[addScene.GetParameters().Length];
                addSceneArguments[0] = rootObjects.ToArray();
                for (var i = 1; i < addSceneArguments.Length; i += 1)
                {
                    var parameter = addScene.GetParameters()[i];
                    addSceneArguments[i] = parameter.ParameterType == typeof(string)
                        ? sceneName
                        : (parameter.HasDefaultValue ? parameter.DefaultValue : null);
                }
                addScene.Invoke(export, addSceneArguments);
                var save = exportType.GetMethod("SaveToFileAndDispose", new[] { typeof(string) });
                var task = (Task)save.Invoke(export, new object[] { bundlePath });
                task.Wait();
                var success = (bool)task.GetType().GetProperty("Result").GetValue(task);
                if (!success)
                {
                    unsupported.Add(new Dictionary<string, object>
                    {
                        ["kind"] = "geometry",
                        ["name"] = "scene",
                        ["reason"] = "glTF export reported a failure; geometry was skipped.",
                    });
                    return false;
                }
                warnings.Add("Scene geometry, materials, and skinned meshes are embedded in assets/scene.glb by com.unity.cloud.gltfast.");
                return true;
            }
            catch (Exception error)
            {
                unsupported.Add(new Dictionary<string, object>
                {
                    ["kind"] = "geometry",
                    ["name"] = "scene",
                    ["reason"] = $"glTF export failed: {Truncate(error.Message, 1800)}",
                });
                return false;
            }
        }

        // --- Animation inventory ---------------------------------------------------

        private static List<object> CollectAnimationClips(List<object> warnings)
        {
            var seen = new HashSet<string>();
            var clips = new List<object>();
            void Record(AnimationClip clip)
            {
                if (clip == null || clips.Count >= 512) return;
                var clipName = SafeName(clip.name, "Clip");
                if (!seen.Add(clipName)) return;
                clips.Add(new Dictionary<string, object>
                {
                    ["name"] = clipName,
                    ["durationSeconds"] = Clamp(clip.length, 0, 1000000),
                });
            }
            foreach (var animator in UnityEngine.Object.FindObjectsByType<Animator>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
            {
                var controller = animator.runtimeAnimatorController;
                if (controller == null) continue;
                foreach (var clip in controller.animationClips) Record(clip);
            }
            foreach (var animation in UnityEngine.Object.FindObjectsByType<Animation>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
            {
                foreach (var clip in AnimationUtility.GetAnimationClips(animation.gameObject)) Record(clip);
            }
            if (clips.Count > 0)
            {
                warnings.Add("Animation clips are inventoried by name; skinned animation data rides inside the GLB bundle when gltfast exports it.");
            }
            return clips;
        }

        // --- Utilities ---------------------------------------------------------------

        private static string ReadArgumentValue(string[] args, string flag)
        {
            for (var i = 0; i < args.Length - 1; i += 1)
            {
                if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase))
                {
                    return args[i + 1];
                }
            }
            return null;
        }

        private static string SafeName(string value, string fallback)
        {
            var trimmed = (value ?? string.Empty).Trim();
            return trimmed.Length == 0 ? fallback : Truncate(trimmed, 240);
        }

        private static string Truncate(string value, int maxLength) =>
            value.Length <= maxLength ? value : value.Substring(0, maxLength);

        private static double Clamp(double value, double minimum, double maximum)
        {
            if (double.IsNaN(value) || double.IsInfinity(value)) return minimum;
            return Math.Max(minimum, Math.Min(maximum, value));
        }

        private static List<object> Cap(List<object> values, int maximum) =>
            values.Count <= maximum ? values : values.Take(maximum).ToList();

        private static string ColorToHex(Color color)
        {
            int Channel(float value) => Mathf.Clamp(Mathf.RoundToInt(Mathf.Clamp01(value) * 255f), 0, 255);
            return $"#{Channel(color.r):x2}{Channel(color.g):x2}{Channel(color.b):x2}";
        }

        private static string Sha256File(string path)
        {
            using var sha = SHA256.Create();
            using var stream = File.OpenRead(path);
            return ToHex(sha.ComputeHash(stream));
        }

        private static string Sha256Text(string text)
        {
            using var sha = SHA256.Create();
            return ToHex(sha.ComputeHash(Encoding.UTF8.GetBytes(text)));
        }

        private static string ToHex(byte[] bytes)
        {
            var builder = new StringBuilder(bytes.Length * 2);
            foreach (var value in bytes) builder.Append(value.ToString("x2", CultureInfo.InvariantCulture));
            return builder.ToString();
        }

        private static void WriteZip(string sourceDir, string zipPath)
        {
            if (File.Exists(zipPath)) File.Delete(zipPath);
            using var archive = ZipFile.Open(zipPath, ZipArchiveMode.Create);
            var basePath = Path.GetFullPath(sourceDir);
            foreach (var file in Directory.EnumerateFiles(basePath, "*", SearchOption.AllDirectories))
            {
                var entryName = Path.GetRelativePath(basePath, file).Replace('\\', '/');
                archive.CreateEntryFromFile(file, entryName, System.IO.Compression.CompressionLevel.Optimal);
            }
        }

        /// <summary>Minimal dependency-free JSON writer for the manifest object model.</summary>
        private static class JsonWriter
        {
            public static string Write(object value)
            {
                var builder = new StringBuilder(64 * 1024);
                WriteValue(builder, value);
                return builder.ToString();
            }

            private static void WriteValue(StringBuilder builder, object value)
            {
                switch (value)
                {
                    case null:
                        builder.Append("null");
                        break;
                    case bool flag:
                        builder.Append(flag ? "true" : "false");
                        break;
                    case string text:
                        WriteString(builder, text);
                        break;
                    case int number:
                        builder.Append(number.ToString(CultureInfo.InvariantCulture));
                        break;
                    case long number:
                        builder.Append(number.ToString(CultureInfo.InvariantCulture));
                        break;
                    case float number:
                        WriteNumber(builder, number);
                        break;
                    case double number:
                        WriteNumber(builder, number);
                        break;
                    case IDictionary<string, object> map:
                        builder.Append('{');
                        var firstEntry = true;
                        foreach (var pair in map)
                        {
                            if (!firstEntry) builder.Append(',');
                            firstEntry = false;
                            WriteString(builder, pair.Key);
                            builder.Append(':');
                            WriteValue(builder, pair.Value);
                        }
                        builder.Append('}');
                        break;
                    case System.Collections.IEnumerable items:
                        builder.Append('[');
                        var firstItem = true;
                        foreach (var item in items)
                        {
                            if (!firstItem) builder.Append(',');
                            firstItem = false;
                            WriteValue(builder, item);
                        }
                        builder.Append(']');
                        break;
                    default:
                        throw new InvalidOperationException($"Unsupported JSON value type {value.GetType()}");
                }
            }

            private static void WriteNumber(StringBuilder builder, double number)
            {
                if (double.IsNaN(number) || double.IsInfinity(number)) number = 0;
                builder.Append(number.ToString("R", CultureInfo.InvariantCulture));
            }

            private static void WriteString(StringBuilder builder, string text)
            {
                builder.Append('"');
                foreach (var character in text)
                {
                    switch (character)
                    {
                        case '"': builder.Append("\\\""); break;
                        case '\\': builder.Append("\\\\"); break;
                        case '\b': builder.Append("\\b"); break;
                        case '\f': builder.Append("\\f"); break;
                        case '\n': builder.Append("\\n"); break;
                        case '\r': builder.Append("\\r"); break;
                        case '\t': builder.Append("\\t"); break;
                        default:
                            if (character < 0x20)
                            {
                                builder.Append("\\u").Append(((int)character).ToString("x4", CultureInfo.InvariantCulture));
                            }
                            else
                            {
                                builder.Append(character);
                            }
                            break;
                    }
                }
                builder.Append('"');
            }
        }
    }
}
#endif
