using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Fixed batch-mode entry points for the Director Unity connector. The
    /// Director Gateway invokes these methods with
    /// <c>-batchmode -nographics -quit -executeMethod
    /// Director.Bridge.Editor.DirectorBridgeCli.Import</c> plus
    /// <c>-directorPackage/-directorReport/-directorReturnDir</c> arguments.
    /// Request-supplied C# is never executed; every path is verified against
    /// the hash-checked exchange package.
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

        /// <summary>
        /// Prints a JSON health line with host and connector versions plus the
        /// facts the Gateway needs to distinguish installed from nativeReady:
        /// active render pipeline, glTF importer availability, and Timeline
        /// package presence.
        /// </summary>
        public static void Health()
        {
            var payload = new JObject
            {
                ["ok"] = true,
                ["provider"] = DirectorExchange.Provider,
                ["hostVersion"] = HostVersion,
                ["connectorVersion"] = DirectorExchange.ConnectorVersion,
                ["renderPipeline"] = DirectorMaterialImport.DetectRenderPipeline(),
                ["gltfImporterAvailable"] = DirectorGlbImport.GltfImporterAvailable(),
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
                var omissions = new JArray();
                var posedCharacterIds = new HashSet<string>();
                JObject manifest = DirectorExchange.LoadExchangePackage(packageDir);
                string packageId = (string)manifest["packageId"];
                string shortId = SafeName(packageId.Substring(0, Math.Min(8, packageId.Length)));

                string renderPipeline = DirectorMaterialImport.DetectRenderPipeline();
                bool gltfImporterAvailable = DirectorGlbImport.GltfImporterAvailable();
                if (!gltfImporterAvailable)
                {
                    warnings.Add(
                        "No glTF ScriptedImporter is installed in this project; GLB mesh payloads import as " +
                        "empty GameObjects. Install com.unity.cloud.gltfast (or another glTF importer).");
                }

                Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var counters = new ImportCounters();
                var byDirectorId = BuildSceneEntities(
                    manifest, packageDir, shortId, renderPipeline, warnings, omissions, posedCharacterIds, counters,
                    out Dictionary<string, GameObject> cameras);
                DirectorTimelineBuilder.Result timelineResult = DirectorTimelineBuilder.Build(
                    manifest, shortId, byDirectorId, cameras, warnings, omissions);
                posedCharacterIds.UnionWith(timelineResult.PoseBakedEntityIds);

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

                var unityDetails = new JObject
                {
                    ["timelinePath"] = timelineResult.TimelinePath == null
                        ? JValue.CreateNull()
                        : (JToken)timelineResult.TimelinePath,
                    ["renderPipeline"] = renderPipeline,
                    ["gltfImporterAvailable"] = gltfImporterAvailable,
                    ["importedLightCount"] = counters.ImportedLightCount,
                    ["omittedLightCount"] = counters.OmittedLights.Count,
                    ["omittedLights"] = counters.OmittedLights,
                    ["bakedAnimationClipCount"] = timelineResult.BakedAnimationClipCount,
                    ["humanoidAvatarCount"] = counters.HumanoidAvatarCount,
                    ["genericAvatarCount"] = counters.GenericAvatarCount,
                    ["materialFallbackCount"] = counters.MaterialFallbackCount,
                    ["appliedTextureCount"] = counters.AppliedTextureCount,
                    ["omittedMaterialCount"] = counters.OmittedMaterials.Count,
                    ["omittedMaterials"] = counters.OmittedMaterials,
                    ["mappedShotCount"] = timelineResult.MappedShotCount,
                    ["omittedShotCount"] = timelineResult.OmittedShots.Count,
                    ["omittedShots"] = timelineResult.OmittedShots,
                    ["posedCharacterCount"] = posedCharacterIds.Count,
                    ["omittedChannels"] = omissions,
                };
                DirectorExchange.WriteReport(
                    reportPath, HostVersion, packageId, (string)manifest["sourceRevision"],
                    counters.ObjectCount, counters.CameraCount, scenePath, returnPackageDir, warnings, unityDetails);
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
        /// entity that moved relative to the exchange package baseline. Only
        /// objects and cameras round-trip; lights carry a director_id for
        /// inspection but the return contract has no light entity type.
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
                    if (marker.entityType == "light")
                    {
                        continue;
                    }
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

        /// <summary>
        /// Renders one PNG frame of a project scene through a chosen camera.
        /// Invoked by the Director Gateway with <c>-batchmode -quit</c> but
        /// deliberately WITHOUT <c>-nographics</c>, so the editor keeps a GPU
        /// device for <see cref="Camera.Render"/>. Arguments:
        /// <c>-directorRenderOutput</c> (PNG path), <c>-directorScene</c>
        /// (project scene path), optional <c>-directorCamera</c> (camera name
        /// or director_id), optional <c>-directorWidth/-directorHeight</c>.
        /// </summary>
        public static void Render()
        {
            string outputPath = Argument("-directorRenderOutput");
            string scenePath = Argument("-directorScene");
            string cameraName = Argument("-directorCamera");
            try
            {
                if (outputPath == null || scenePath == null)
                {
                    throw new InvalidDataException("-directorRenderOutput and -directorScene are required.");
                }
                int width = ParseRenderSide(Argument("-directorWidth"), 960);
                int height = ParseRenderSide(Argument("-directorHeight"), 540);
                EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Single);
                byte[] png = CaptureFrame(cameraName, width, height);
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outputPath)) ?? ".");
                File.WriteAllBytes(outputPath, png);
                Debug.Log($"Director render wrote {outputPath}");
                ExitBatch(0);
            }
            catch (Exception error)
            {
                Debug.LogError($"Director render failed: {error}");
                ExitBatch(1);
            }
        }

        /// <summary>Renders the open editor scene without restarting Unity.</summary>
        internal static byte[] CaptureFrame(string cameraName, int width, int height)
        {
            Camera camera = PickRenderCamera(cameraName);
            if (camera == null)
            {
                throw new InvalidDataException(
                    cameraName == null
                        ? "The scene contains no camera to render through."
                        : $"No camera named or tagged \"{cameraName}\" was found in the scene.");
            }
            var renderTexture = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            RenderTexture previousTarget = camera.targetTexture;
            RenderTexture previousActive = RenderTexture.active;
            Texture2D image = null;
            try
            {
                camera.targetTexture = renderTexture;
                camera.Render();
                RenderTexture.active = renderTexture;
                image = new Texture2D(width, height, TextureFormat.RGBA32, false);
                image.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                image.Apply();
                return image.EncodeToPNG();
            }
            finally
            {
                camera.targetTexture = previousTarget;
                RenderTexture.active = previousActive;
                renderTexture.Release();
                UnityEngine.Object.DestroyImmediate(renderTexture);
                if (image != null) UnityEngine.Object.DestroyImmediate(image);
            }
        }

        private static Camera PickRenderCamera(string cameraName)
        {
            Camera[] cameras = UnityEngine.Object.FindObjectsByType<Camera>(
                FindObjectsInactive.Include, FindObjectsSortMode.None);
            if (cameraName != null)
            {
                foreach (Camera candidate in cameras)
                {
                    DirectorId marker = candidate.GetComponent<DirectorId>();
                    if (candidate.name == cameraName || (marker != null && marker.directorId == cameraName))
                    {
                        return candidate;
                    }
                }
                return null;
            }
            foreach (Camera candidate in cameras)
            {
                if (candidate.enabled)
                {
                    return candidate;
                }
            }
            return cameras.Length > 0 ? cameras[0] : null;
        }

        private static int ParseRenderSide(string value, int fallback)
        {
            return int.TryParse(value, out int parsed) ? Math.Max(64, Math.Min(1920, parsed)) : fallback;
        }

        private sealed class ImportCounters
        {
            public int ObjectCount;
            public int CameraCount;
            public int ImportedLightCount;
            public JArray OmittedLights = new JArray();
            public int HumanoidAvatarCount;
            public int GenericAvatarCount;
            public int MaterialFallbackCount;
            public int AppliedTextureCount;
            public JArray OmittedMaterials = new JArray();
        }

        private static Dictionary<string, GameObject> BuildSceneEntities(
            JObject manifest,
            string packageDir,
            string shortId,
            string renderPipeline,
            List<string> warnings,
            JArray omissions,
            HashSet<string> posedCharacterIds,
            ImportCounters counters,
            out Dictionary<string, GameObject> cameras)
        {
            JObject project = (JObject)manifest["project"];
            JObject scene = (JObject)project["scene"];
            double[] scenePosition = Vec3(scene["position"]);
            double[] sceneRotation = Vec3(scene["rotation"]);
            double sceneScale = (double)scene["scale"];
            var byDirectorId = new Dictionary<string, GameObject>();
            cameras = new Dictionary<string, GameObject>();
            string assetFolder = $"Assets/Director/Packages/{shortId}";

            var payloadsByAssetRefId = new Dictionary<string, (string Path, string Sha256)>();
            foreach (JToken assetEntry in (JArray)(manifest["assets"] ?? new JArray()))
            {
                payloadsByAssetRefId[(string)assetEntry["assetRefId"]] = (
                    DirectorExchange.ResolvePackageFile(packageDir, (string)assetEntry["relativePath"]),
                    (string)assetEntry["sha256"]);
            }
            var projectAssetsById = new Dictionary<string, JObject>();
            foreach (JToken assetToken in (JArray)project["assets"])
            {
                projectAssetsById[(string)assetToken["id"]] = (JObject)assetToken;
            }
            var importedPayloads = new Dictionary<string, DirectorGlbImport.ImportedPayload>();
            var importedTextures = new Dictionary<string, Texture2D>();

            Texture2D ResolveTexture(string assetRefId)
            {
                if (importedTextures.TryGetValue(assetRefId, out Texture2D cached))
                {
                    return cached;
                }
                Texture2D texture = null;
                if (payloadsByAssetRefId.TryGetValue(assetRefId, out (string Path, string Sha256) payload))
                {
                    texture = DirectorGlbImport.ImportTexture(
                        assetRefId, payload.Path, payload.Sha256, assetFolder, warnings);
                }
                importedTextures[assetRefId] = texture;
                return texture;
            }

            foreach (JToken entityToken in (JArray)project["objects"])
            {
                var entity = (JObject)entityToken;
                string directorId = (string)entity["id"];
                GameObject gameObject = InstantiatePayload(
                    entity, payloadsByAssetRefId, importedPayloads, assetFolder, warnings,
                    out DirectorGlbImport.ImportedPayload payloadInfo);
                gameObject.name = (string)entity["name"];
                ApplyCanonicalTransform(gameObject.transform, scene, (JObject)entity["transform"]);
                DirectorId marker = gameObject.AddComponent<DirectorId>();
                marker.directorId = directorId;
                marker.entityType = "object";
                if (entity["visible"] != null && !(bool)entity["visible"])
                {
                    gameObject.SetActive(false);
                }

                ApplyMaterialOverride(
                    entity, gameObject, renderPipeline, shortId, ResolveTexture, warnings, counters);
                BuildCharacterAvatar(
                    entity, gameObject, payloadInfo, projectAssetsById, assetFolder, warnings, omissions,
                    posedCharacterIds, counters);

                byDirectorId[directorId] = gameObject;
                counters.ObjectCount += 1;
            }

            // Restore the Director parent hierarchy while keeping world transforms.
            foreach (JToken entityToken in (JArray)project["objects"])
            {
                string parentId = (string)entityToken["parentObjectId"];
                string id = (string)entityToken["id"];
                if (parentId != null && byDirectorId.ContainsKey(parentId) && byDirectorId.ContainsKey(id))
                {
                    byDirectorId[id].transform.SetParent(byDirectorId[parentId].transform, true);
                }
            }

            double fps = (double?)scene["timeline"]?["fps"] ?? 24.0;
            string activeCameraId = (string)project["activeCameraId"];
            double[] ResolveObjectWorldPoint(string objectId)
            {
                return byDirectorId.TryGetValue(objectId, out GameObject target)
                    ? DirectorSpace.UnityPointToDirector(target.transform.position)
                    : null;
            }
            foreach (JToken cameraToken in (JArray)project["cameras"])
            {
                var cameraEntity = (JObject)cameraToken;
                string directorId = (string)cameraEntity["id"];
                GameObject gameObject = DirectorCameraImport.CreateCamera(
                    cameraEntity, scene, fps, ResolveObjectWorldPoint, warnings);
                Camera camera = gameObject.GetComponent<Camera>();
                camera.enabled = activeCameraId != null ? directorId == activeCameraId : counters.CameraCount == 0;
                DirectorId marker = gameObject.AddComponent<DirectorId>();
                marker.directorId = directorId;
                marker.entityType = "camera";
                byDirectorId[directorId] = gameObject;
                cameras[directorId] = gameObject;
                counters.CameraCount += 1;
            }

            var lightImport = DirectorLightImport.ImportLights(
                (JArray)project["lights"],
                point =>
                {
                    double[] world = DirectorSpace.ComposeWorldPoint(scenePosition, sceneRotation, sceneScale, point);
                    return DirectorSpace.DirectorPointToUnity(world[0], world[1], world[2]);
                },
                byDirectorId,
                warnings);
            counters.ImportedLightCount = lightImport.ImportedLightCount;
            counters.OmittedLights = lightImport.OmittedLights;

            return byDirectorId;
        }

        private static readonly IReadOnlyDictionary<string, PrimitiveType> GeometryPrimitives =
            new Dictionary<string, PrimitiveType>
            {
                ["box"] = PrimitiveType.Cube,
                ["sphere"] = PrimitiveType.Sphere,
                ["cylinder"] = PrimitiveType.Cylinder,
                ["plane"] = PrimitiveType.Plane,
                ["capsule"] = PrimitiveType.Capsule,
            };

        private static GameObject InstantiatePayload(
            JObject entity,
            Dictionary<string, (string Path, string Sha256)> payloadsByAssetRefId,
            Dictionary<string, DirectorGlbImport.ImportedPayload> importedPayloads,
            string assetFolder,
            List<string> warnings,
            out DirectorGlbImport.ImportedPayload payloadInfo)
        {
            payloadInfo = null;
            string directorId = (string)entity["id"];
            string assetRefId = (string)entity["assetRefId"];
            if (assetRefId != null && payloadsByAssetRefId.TryGetValue(assetRefId, out (string Path, string Sha256) payload) &&
                payload.Path.EndsWith(".glb", StringComparison.OrdinalIgnoreCase))
            {
                if (!importedPayloads.TryGetValue(assetRefId, out payloadInfo))
                {
                    payloadInfo = DirectorGlbImport.ImportPayload(
                        assetRefId, payload.Path, payload.Sha256, assetFolder, warnings);
                    importedPayloads[assetRefId] = payloadInfo;
                }
                return payloadInfo.Prefab != null
                    ? (GameObject)UnityEngine.Object.Instantiate(payloadInfo.Prefab)
                    : new GameObject();
            }

            string geometryType = (string)entity["geometryType"];
            if (geometryType != null)
            {
                if (GeometryPrimitives.TryGetValue(geometryType, out PrimitiveType primitive))
                {
                    return GameObject.CreatePrimitive(primitive);
                }
                warnings.Add(
                    $"Object {directorId}: geometry primitive \"{geometryType}\" has no Unity built-in mesh; " +
                    "created an empty GameObject (warn-and-omit).");
                return new GameObject();
            }
            if (assetRefId != null)
            {
                warnings.Add(
                    $"Object {directorId} references asset {assetRefId} without a GLB payload; " +
                    "created an empty GameObject (warn-and-omit).");
            }
            return new GameObject();
        }

        private static void ApplyMaterialOverride(
            JObject entity,
            GameObject gameObject,
            string renderPipeline,
            string shortId,
            Func<string, Texture2D> resolveTexture,
            List<string> warnings,
            ImportCounters counters)
        {
            var materialJson = (JObject)entity["material"];
            if (materialJson == null && entity["color"] != null)
            {
                // Plain-colored objects synthesize a one-property PBR override.
                materialJson = new JObject { ["baseColor"] = (string)entity["color"] };
            }
            if (materialJson == null)
            {
                return;
            }
            Renderer[] renderers = gameObject.GetComponentsInChildren<Renderer>(true);
            if (renderers.Length == 0)
            {
                return;
            }
            DirectorMaterialImport.MaterialImportResult materialResult = DirectorMaterialImport.CreateFallbackMaterial(
                materialJson, (string)entity["id"], renderPipeline,
                $"Assets/Director/Packages/{shortId}/Materials", resolveTexture, warnings,
                out int appliedTextures);
            if (materialResult.OmittedMaterial != null)
            {
                counters.OmittedMaterials.Add(materialResult.OmittedMaterial);
            }
            Material material = materialResult.Material;
            if (material == null)
            {
                return;
            }
            foreach (Renderer renderer in renderers)
            {
                renderer.sharedMaterials =
                    Enumerable.Repeat(material, Math.Max(1, renderer.sharedMaterials.Length)).ToArray();
            }
            counters.MaterialFallbackCount += 1;
            counters.AppliedTextureCount += appliedTextures;
        }

        private static void BuildCharacterAvatar(
            JObject entity,
            GameObject gameObject,
            DirectorGlbImport.ImportedPayload payloadInfo,
            Dictionary<string, JObject> projectAssetsById,
            string assetFolder,
            List<string> warnings,
            JArray omissions,
            HashSet<string> posedCharacterIds,
            ImportCounters counters)
        {
            string assetRefId = (string)entity["assetRefId"];
            JObject characterMetadata =
                assetRefId != null && projectAssetsById.TryGetValue(assetRefId, out JObject assetJson)
                    ? (JObject)assetJson["characterMetadata"]
                    : null;
            if (payloadInfo != null && payloadInfo.HasSkinnedMesh)
            {
                DirectorSkeletonImport.AvatarKind kind = DirectorSkeletonImport.BuildAvatar(
                    gameObject, characterMetadata, (string)entity["id"], $"{assetFolder}/Avatars", warnings);
                if (kind == DirectorSkeletonImport.AvatarKind.Humanoid)
                {
                    counters.HumanoidAvatarCount += 1;
                }
                else if (kind == DirectorSkeletonImport.AvatarKind.Generic)
                {
                    counters.GenericAvatarCount += 1;
                }
            }
            if (entity["characterRig"] == null)
            {
                return;
            }
            // The static pose applies only after BuildAvatar captured the
            // untouched bind pose in the Avatar's HumanDescription skeleton.
            if (DirectorPoseImport.ApplyStaticPose(entity, gameObject, characterMetadata, warnings, omissions))
            {
                posedCharacterIds.Add((string)entity["id"]);
            }
            DirectorPoseImport.RecordUnbakedRigState(entity, warnings, omissions);
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
                if (marker.entityType == "light")
                {
                    continue;
                }
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
