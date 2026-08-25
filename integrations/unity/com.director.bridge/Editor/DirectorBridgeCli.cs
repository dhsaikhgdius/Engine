using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Playables;
using UnityEngine.SceneManagement;
using UnityEngine.Timeline;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Fixed batch-mode entry points for the Director Unity connector. The
    /// Director Gateway invokes these methods with
    /// <c>-batchmode -nographics -quit -executeMethod
    /// Director.Bridge.Editor.DirectorBridgeCli.Import</c> plus
    /// <c>-directorPackage/-directorReport/-directorReturnDir</c> arguments.
    /// Request-supplied C# is never executed.
    /// </summary>
    public static class DirectorBridgeCli
    {
        private const double TransformTolerance = 1e-6;

        private static string HostVersion => $"Unity {Application.unityVersion}";

        private static string Argument(string name)
        {
            string[] arguments = Environment.GetCommandLineArgs();
            for (int index = 0; index < arguments.Length - 1; index += 1)
            {
                if (arguments[index] == name)
                {
                    return arguments[index + 1];
                }
            }
            return null;
        }

        /// <summary>Prints a JSON health line with host and connector versions.</summary>
        public static void Health()
        {
            var payload = new JObject
            {
                ["ok"] = true,
                ["provider"] = DirectorExchange.Provider,
                ["hostVersion"] = HostVersion,
                ["connectorVersion"] = DirectorExchange.ConnectorVersion,
            };
            Debug.Log(payload.ToString(Newtonsoft.Json.Formatting.None));
            if (Application.isBatchMode)
            {
                EditorApplication.Exit(0);
            }
        }

        /// <summary>Imports a Director exchange package into a new Unity scene.</summary>
        public static void Import()
        {
            string packageDir = Argument("-directorPackage");
            string reportPath = Argument("-directorReport");
            string returnDir = Argument("-directorReturnDir");
            try
            {
                if (packageDir == null || reportPath == null)
                {
                    throw new InvalidDataException("-directorPackage and -directorReport are required.");
                }
                var warnings = new List<string>();
                JObject manifest = DirectorExchange.LoadExchangePackage(packageDir);
                string packageId = (string)manifest["packageId"];
                string shortId = SafeName(packageId.Substring(0, Math.Min(8, packageId.Length)));

                Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var byDirectorId = BuildSceneEntities(manifest, packageDir, shortId, warnings,
                    out int objectCount, out int cameraCount, out Dictionary<string, GameObject> cameras);
                BuildTimeline(manifest, shortId, cameras, warnings);

                Directory.CreateDirectory("Assets/Director/Scenes");
                string scenePath = $"Assets/Director/Scenes/Director_{shortId}.unity";
                EditorSceneManager.SaveScene(scene, scenePath);
                AssetDatabase.SaveAssets();

                string returnPackageDir = null;
                if (returnDir != null)
                {
                    DirectorExchange.WriteReturnPackage(
                        returnDir,
                        HostVersion,
                        packageId,
                        (string)manifest["sourceRevision"],
                        EchoChanges(byDirectorId),
                        new[]
                        {
                            "Echo return package written immediately after import; edit the scene and re-export to send changes.",
                        });
                    returnPackageDir = RelativeTo(reportPath, returnDir);
                }

                DirectorExchange.WriteReport(
                    reportPath, HostVersion, packageId, (string)manifest["sourceRevision"],
                    objectCount, cameraCount, scenePath, returnPackageDir, warnings);
                ExitBatch(0);
            }
            catch (Exception error)
            {
                if (reportPath != null)
                {
                    DirectorExchange.WriteFailureReport(reportPath, error.ToString());
                }
                Debug.LogError($"Director import failed: {error}");
                ExitBatch(1);
            }
        }

        /// <summary>
        /// Exports the canonical-space transforms of every director_id-tagged
        /// entity that moved relative to the exchange package baseline.
        /// </summary>
        public static void Export()
        {
            string packageDir = Argument("-directorPackage");
            string reportPath = Argument("-directorReport");
            string returnDir = Argument("-directorReturnDir");
            try
            {
                if (packageDir == null || reportPath == null || returnDir == null)
                {
                    throw new InvalidDataException(
                        "-directorPackage, -directorReport, and -directorReturnDir are required.");
                }
                var warnings = new List<string>();
                JObject manifest = DirectorExchange.LoadExchangePackage(packageDir);
                string packageId = (string)manifest["packageId"];
                string shortId = SafeName(packageId.Substring(0, Math.Min(8, packageId.Length)));
                string scenePath = $"Assets/Director/Scenes/Director_{shortId}.unity";
                if (File.Exists(scenePath))
                {
                    EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
                }
                else
                {
                    warnings.Add($"Director scene {scenePath} was not found; exporting from the currently open scene.");
                }

                Dictionary<string, (string entityType, double[] location, double[] quaternion, double[] scale)>
                    baselines = BuildBaselines(manifest);
                var changes = new JArray();
                int seen = 0;
                foreach (DirectorId marker in UnityEngine.Object.FindObjectsByType<DirectorId>(
                             FindObjectsInactive.Include, FindObjectsSortMode.None))
                {
                    seen += 1;
                    (double[] location, double[] quaternion, double[] scale) = CanonicalFromUnity(marker.transform);
                    if (!baselines.TryGetValue(marker.directorId, out var baseline))
                    {
                        warnings.Add($"GameObject {marker.name} carries unknown director_id {marker.directorId}; skipped.");
                        continue;
                    }
                    if (Moved(location, quaternion, scale, baseline.location, baseline.quaternion, baseline.scale))
                    {
                        changes.Add(TransformUpdate(marker.directorId, baseline.entityType, location, quaternion, scale));
                    }
                }
                if (seen == 0)
                {
                    warnings.Add("No DirectorId components were found in the scene.");
                }

                DirectorExchange.WriteReturnPackage(
                    returnDir, HostVersion, packageId, (string)manifest["sourceRevision"], changes, warnings);
                DirectorExchange.WriteReport(
                    reportPath, HostVersion, packageId, (string)manifest["sourceRevision"],
                    0, 0, null, RelativeTo(reportPath, returnDir), warnings);
                ExitBatch(0);
            }
            catch (Exception error)
            {
                if (reportPath != null)
                {
                    DirectorExchange.WriteFailureReport(reportPath, error.ToString());
                }
                Debug.LogError($"Director export failed: {error}");
                ExitBatch(1);
            }
        }

        private static Dictionary<string, GameObject> BuildSceneEntities(
            JObject manifest,
            string packageDir,
            string shortId,
            List<string> warnings,
            out int objectCount,
            out int cameraCount,
            out Dictionary<string, GameObject> cameras)
        {
            JObject project = (JObject)manifest["project"];
            JObject scene = (JObject)project["scene"];
            var byDirectorId = new Dictionary<string, GameObject>();
            cameras = new Dictionary<string, GameObject>();

            var assetPathsById = new Dictionary<string, string>();
            foreach (JToken assetEntry in (JArray)(manifest["assets"] ?? new JArray()))
            {
                assetPathsById[(string)assetEntry["assetRefId"]] =
                    DirectorExchange.ResolvePackageFile(packageDir, (string)assetEntry["relativePath"]);
            }
            var importedAssets = new Dictionary<string, GameObject>();

            objectCount = 0;
            foreach (JToken entity in (JArray)project["objects"])
            {
                GameObject gameObject = InstantiatePayload(
                    entity, assetPathsById, importedAssets, shortId, warnings);
                gameObject.name = (string)entity["name"];
                ApplyCanonicalTransform(gameObject.transform, scene, (JObject)entity["transform"]);
                DirectorId marker = gameObject.AddComponent<DirectorId>();
                marker.directorId = (string)entity["id"];
                marker.entityType = "object";
                if (entity["visible"] != null && !(bool)entity["visible"])
                {
                    gameObject.SetActive(false);
                }
                byDirectorId[marker.directorId] = gameObject;
                objectCount += 1;
            }

            // Restore the Director parent hierarchy while keeping world transforms.
            foreach (JToken entity in (JArray)project["objects"])
            {
                string parentId = (string)entity["parentObjectId"];
                string id = (string)entity["id"];
                if (parentId != null && byDirectorId.ContainsKey(parentId) && byDirectorId.ContainsKey(id))
                {
                    byDirectorId[id].transform.SetParent(byDirectorId[parentId].transform, true);
                }
            }

            cameraCount = 0;
            foreach (JToken cameraEntity in (JArray)project["cameras"])
            {
                var gameObject = new GameObject((string)cameraEntity["name"]);
                Camera camera = gameObject.AddComponent<Camera>();
                camera.fieldOfView = (float)(double)cameraEntity["fov"];
                if (cameraEntity["focalLengthMm"] != null)
                {
                    camera.usePhysicalProperties = true;
                    camera.focalLength = (float)(double)cameraEntity["focalLengthMm"];
                }
                camera.enabled = cameraCount == 0;
                ApplyCanonicalTransform(gameObject.transform, scene, (JObject)cameraEntity["transform"]);
                DirectorId marker = gameObject.AddComponent<DirectorId>();
                marker.directorId = (string)cameraEntity["id"];
                marker.entityType = "camera";
                byDirectorId[marker.directorId] = gameObject;
                cameras[marker.directorId] = gameObject;
                cameraCount += 1;
            }
            return byDirectorId;
        }

        private static GameObject InstantiatePayload(
            JToken entity,
            Dictionary<string, string> assetPathsById,
            Dictionary<string, GameObject> importedAssets,
            string shortId,
            List<string> warnings)
        {
            string assetRefId = (string)entity["assetRefId"];
            if (assetRefId == null || !assetPathsById.TryGetValue(assetRefId, out string sourcePath) ||
                !sourcePath.EndsWith(".glb", StringComparison.OrdinalIgnoreCase))
            {
                if (assetRefId != null)
                {
                    warnings.Add(
                        $"Object {(string)entity["id"]} references asset {assetRefId} without a GLB payload; " +
                        "created an empty GameObject (warn-and-omit).");
                }
                return new GameObject();
            }
            if (!importedAssets.TryGetValue(assetRefId, out GameObject prefab))
            {
                string assetFolder = $"Assets/Director/Packages/{shortId}";
                Directory.CreateDirectory(assetFolder);
                string destination = $"{assetFolder}/{SafeName(assetRefId)}.glb";
                File.Copy(sourcePath, destination, true);
                AssetDatabase.ImportAsset(destination, ImportAssetOptions.ForceSynchronousImport);
                prefab = AssetDatabase.LoadAssetAtPath<GameObject>(destination);
                if (prefab == null)
                {
                    warnings.Add(
                        $"No GLB importer produced a prefab for {destination}; install com.unity.cloud.gltfast (or " +
                        "another glTF importer) for mesh payloads. Created an empty GameObject (warn-and-omit).");
                }
                importedAssets[assetRefId] = prefab;
            }
            return prefab != null
                ? (GameObject)UnityEngine.Object.Instantiate(prefab)
                : new GameObject();
        }

        private static void BuildTimeline(
            JObject manifest, string shortId, Dictionary<string, GameObject> cameras, List<string> warnings)
        {
            JObject project = (JObject)manifest["project"];
            var shots = ((JArray)(project["storyboard"]?["shots"] ?? new JArray()))
                .Where(shot => shot["cameraId"] != null && cameras.ContainsKey((string)shot["cameraId"]))
                .ToList();
            if (shots.Count == 0)
            {
                return;
            }
            try
            {
                double fps = (double?)project["scene"]?["timeline"]?["fps"] ?? 24.0;
                Directory.CreateDirectory("Assets/Director/Timelines");
                string timelinePath = $"Assets/Director/Timelines/Director_{shortId}.playable";
                var timeline = ScriptableObject.CreateInstance<TimelineAsset>();
                AssetDatabase.CreateAsset(timeline, timelinePath);
                foreach (JToken shot in shots)
                {
                    GameObject cameraObject = cameras[(string)shot["cameraId"]];
                    var track = timeline.CreateTrack<ActivationTrack>(null, (string)shot["title"] ?? "Shot");
                    TimelineClip clip = track.CreateDefaultClip();
                    clip.start = (double)shot["frameStart"] / fps;
                    clip.duration = Math.Max(1.0 / fps, ((double)shot["frameEnd"] - (double)shot["frameStart"]) / fps);
                    var director = cameraObject.GetComponent<PlayableDirector>() ??
                                   cameraObject.AddComponent<PlayableDirector>();
                    director.playableAsset = timeline;
                    director.SetGenericBinding(track, cameraObject);
                }
                AssetDatabase.SaveAssets();
                warnings.Add(
                    "Storyboard shots were mapped to Timeline activation tracks over each camera from the static " +
                    "snapshot; per-frame animation baking stays planned until the animation capability is promoted.");
            }
            catch (Exception error)
            {
                warnings.Add($"Timeline mapping was skipped: {error.Message}");
            }
        }

        private static void ApplyCanonicalTransform(Transform target, JObject scene, JObject transform)
        {
            DirectorSpace.ComposeWorldTransform(
                Vec3(scene["position"]),
                Vec3(scene["rotation"]),
                (double)scene["scale"],
                Vec3(transform["position"]),
                DirectorSpace.QuaternionFromEulerXyz(
                    (double)transform["rotation"][0], (double)transform["rotation"][1],
                    (double)transform["rotation"][2]),
                Vec3(transform["scale"]),
                out double[] location, out double[] quaternion, out double[] scale);
            target.SetPositionAndRotation(
                DirectorSpace.DirectorPointToUnity(location[0], location[1], location[2]),
                DirectorSpace.DirectorQuaternionToUnity(quaternion[0], quaternion[1], quaternion[2], quaternion[3]));
            target.localScale = DirectorSpace.DirectorScaleToUnity(scale[0], scale[1], scale[2]);
        }

        private static Dictionary<string, (string, double[], double[], double[])> BuildBaselines(JObject manifest)
        {
            JObject project = (JObject)manifest["project"];
            JObject scene = (JObject)project["scene"];
            var baselines = new Dictionary<string, (string, double[], double[], double[])>();
            foreach ((string entityType, string collection) in new[] { ("object", "objects"), ("camera", "cameras") })
            {
                foreach (JToken entity in (JArray)project[collection])
                {
                    JObject transform = (JObject)entity["transform"];
                    DirectorSpace.ComposeWorldTransform(
                        Vec3(scene["position"]), Vec3(scene["rotation"]), (double)scene["scale"],
                        Vec3(transform["position"]),
                        DirectorSpace.QuaternionFromEulerXyz(
                            (double)transform["rotation"][0], (double)transform["rotation"][1],
                            (double)transform["rotation"][2]),
                        Vec3(transform["scale"]),
                        out double[] location, out double[] quaternion, out double[] scale);
                    baselines[(string)entity["id"]] = (entityType, location, quaternion, scale);
                }
            }
            return baselines;
        }

        private static (double[], double[], double[]) CanonicalFromUnity(Transform transform)
        {
            return (
                DirectorSpace.UnityPointToDirector(transform.position),
                DirectorSpace.UnityQuaternionToDirector(transform.rotation),
                DirectorSpace.UnityScaleToDirector(transform.lossyScale));
        }

        private static bool Moved(
            double[] location, double[] quaternion, double[] scale,
            double[] baseLocation, double[] baseQuaternion, double[] baseScale)
        {
            for (int index = 0; index < 3; index += 1)
            {
                if (Math.Abs(location[index] - baseLocation[index]) > TransformTolerance) return true;
                if (Math.Abs(scale[index] - baseScale[index]) > TransformTolerance) return true;
            }
            double dot = 0.0;
            for (int index = 0; index < 4; index += 1)
            {
                dot += quaternion[index] * baseQuaternion[index];
            }
            return Math.Abs(Math.Abs(dot) - 1.0) > TransformTolerance;
        }

        private static JArray EchoChanges(Dictionary<string, GameObject> byDirectorId)
        {
            var changes = new JArray();
            foreach (KeyValuePair<string, GameObject> pair in byDirectorId)
            {
                DirectorId marker = pair.Value.GetComponent<DirectorId>();
                (double[] location, double[] quaternion, double[] scale) = CanonicalFromUnity(pair.Value.transform);
                changes.Add(TransformUpdate(pair.Key, marker.entityType, location, quaternion, scale));
            }
            return changes;
        }

        private static JObject TransformUpdate(
            string directorId, string entityType, double[] location, double[] quaternion, double[] scale)
        {
            return new JObject
            {
                ["kind"] = "transform_update",
                ["directorId"] = directorId,
                ["entityType"] = entityType,
                ["transform"] = new JObject
                {
                    ["location"] = new JArray(location),
                    ["rotationQuaternion"] = new JArray(quaternion),
                    ["scale"] = new JArray(scale),
                },
            };
        }

        private static double[] Vec3(JToken token)
        {
            return new[] { (double)token[0], (double)token[1], (double)token[2] };
        }

        private static string SafeName(string value)
        {
            var characters = value.Select(c => char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_').ToArray();
            return new string(characters, 0, Math.Min(characters.Length, 96));
        }

        private static string RelativeTo(string reportPath, string directory)
        {
            string reportDirectory = Path.GetDirectoryName(Path.GetFullPath(reportPath)) ?? ".";
            return Path.GetRelativePath(reportDirectory, Path.GetFullPath(directory)).Replace('\\', '/');
        }

        private static void ExitBatch(int code)
        {
            if (Application.isBatchMode)
            {
                EditorApplication.Exit(code);
            }
        }
    }
}
