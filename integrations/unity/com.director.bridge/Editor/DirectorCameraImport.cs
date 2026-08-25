using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Director camera import with physical-optics approximation.
    ///
    /// Orientation: Director cameras aim at their target point, so the Unity
    /// camera rotation derives from <see cref="DirectorCameraMath.LookQuaternion"/>
    /// in canonical space (matching the glTF/USD exporters), not from the
    /// authored Euler rotation, which Director itself treats as a fallback.
    ///
    /// Optics: focal length, crop gate, aperture, ISO, shutter angle, focus
    /// distance, lens shift, and clip planes map onto Unity's physical camera.
    /// The sensor is set to the *used* (cropped) Director gate with vertical
    /// gate fit, so the vertical field of view matches Director exactly on any
    /// output aspect. Anamorphic squeeze and handheld shake have no Unity
    /// base-camera equivalent and warn-and-omit.
    /// </summary>
    public static class DirectorCameraImport
    {
        /// <summary>Creates one Unity camera GameObject for a Director camera entity.</summary>
        public static GameObject CreateCamera(
            JObject cameraJson,
            JObject scene,
            double fps,
            Func<string, double[]> resolveObjectWorldPoint,
            List<string> warnings)
        {
            string directorId = (string)cameraJson["id"];
            var gameObject = new GameObject((string)cameraJson["name"]);
            Camera camera = gameObject.AddComponent<Camera>();

            JObject transform = (JObject)cameraJson["transform"];
            double[] scenePosition = Vec3(scene["position"]);
            double[] sceneRotation = Vec3(scene["rotation"]);
            double sceneScale = (double)scene["scale"];

            DirectorSpace.ComposeWorldTransform(
                scenePosition, sceneRotation, sceneScale,
                Vec3(transform["position"]),
                DirectorSpace.QuaternionFromEulerXyz(
                    (double)transform["rotation"][0], (double)transform["rotation"][1],
                    (double)transform["rotation"][2]),
                Vec3(transform["scale"]),
                out double[] worldPosition, out double[] composedQuaternion, out _);

            double[] worldTarget = ResolveWorldTarget(
                cameraJson, scenePosition, sceneRotation, sceneScale, resolveObjectWorldPoint, directorId, warnings);
            double[] worldQuaternion = LookOrFallback(worldPosition, worldTarget, composedQuaternion);

            gameObject.transform.SetPositionAndRotation(
                DirectorSpace.DirectorPointToUnity(worldPosition[0], worldPosition[1], worldPosition[2]),
                DirectorSpace.DirectorQuaternionToUnity(
                    worldQuaternion[0], worldQuaternion[1], worldQuaternion[2], worldQuaternion[3]));

            ApplyOptics(camera, cameraJson, fps, directorId, warnings);
            return gameObject;
        }

        /// <summary>
        /// Canonical-space look target for a camera: the target object's world
        /// position in object mode, otherwise the authored target point mapped
        /// through the scene transform.
        /// </summary>
        public static double[] ResolveWorldTarget(
            JObject cameraJson,
            double[] scenePosition,
            double[] sceneRotation,
            double sceneScale,
            Func<string, double[]> resolveObjectWorldPoint,
            string directorId,
            List<string> warnings)
        {
            string targetMode = (string)cameraJson["targetMode"];
            string targetObjectId = (string)cameraJson["targetObjectId"];
            if (targetMode == "object" && targetObjectId != null)
            {
                double[] resolved = resolveObjectWorldPoint(targetObjectId);
                if (resolved != null)
                {
                    return resolved;
                }
                warnings.Add(
                    $"Camera {directorId}: target object {targetObjectId} was not found; " +
                    "fell back to the authored target point.");
            }
            return DirectorSpace.ComposeWorldPoint(
                scenePosition, sceneRotation, sceneScale, Vec3(cameraJson["target"]));
        }

        /// <summary>
        /// Look-at quaternion in canonical space, falling back to the composed
        /// scene rotation when the camera sits on its target.
        /// </summary>
        public static double[] LookOrFallback(double[] position, double[] target, double[] fallbackQuaternion)
        {
            double dx = target[0] - position[0];
            double dy = target[1] - position[1];
            double dz = target[2] - position[2];
            if (dx * dx + dy * dy + dz * dz <= double.Epsilon)
            {
                return fallbackQuaternion;
            }
            // The Euler fallback inside LookQuaternion is unreachable here.
            return DirectorCameraMath.LookQuaternion(position, target, new double[] { 0, 0, 0 });
        }

        private static void ApplyOptics(
            Camera camera, JObject cameraJson, double fps, string directorId, List<string> warnings)
        {
            string aspectRatio = (string)cameraJson["aspectRatio"] ?? "16:9";
            string sensorFormat = (string)cameraJson["sensorFormat"] ?? "fullFrame";
            double? focalLengthMm = (double?)cameraJson["focalLengthMm"];

            if ((string)cameraJson["projectionType"] == "orthographic")
            {
                camera.orthographic = true;
                // Director/Blender orthographic scale spans the larger view
                // dimension; Unity orthographicSize is the half-height.
                double scale = (double?)cameraJson["orthographicScaleM"] ?? 10.0;
                double aspectValue = DirectorCameraMath.AspectValue(aspectRatio);
                camera.orthographicSize = (float)(aspectValue >= 1.0 ? scale / (2.0 * aspectValue) : scale / 2.0);
            }
            else if (focalLengthMm != null)
            {
                camera.usePhysicalProperties = true;
                camera.focalLength = (float)focalLengthMm.Value;
                double usedHeight = DirectorCameraMath.UsedSensorHeight(aspectRatio, sensorFormat);
                double usedWidth = usedHeight * DirectorCameraMath.AspectValue(aspectRatio);
                camera.sensorSize = new Vector2((float)usedWidth, (float)usedHeight);
                camera.gateFit = Camera.GateFitMode.Vertical;
                camera.aperture = (float)((double?)cameraJson["apertureFStop"] ?? 2.8);
                camera.iso = (int)((double?)cameraJson["iso"] ?? 800.0);
                double shutterAngle = (double?)cameraJson["shutterAngle"] ?? 180.0;
                camera.shutterSpeed = (float)(shutterAngle / (360.0 * Math.Max(1.0, fps)));
                camera.focusDistance = (float)((double?)cameraJson["focusDistanceM"] ?? 5.0);
                double lensShiftX = (double?)cameraJson["lensShiftX"] ?? 0.0;
                double lensShiftY = (double?)cameraJson["lensShiftY"] ?? 0.0;
                camera.lensShift = new Vector2((float)lensShiftX, (float)lensShiftY);
            }
            else
            {
                // Legacy fov-only camera: keep the authored vertical fov.
                camera.fieldOfView = (float)(double)cameraJson["fov"];
            }

            camera.nearClipPlane = (float)((double?)cameraJson["nearClipM"] ?? 0.1);
            camera.farClipPlane = (float)((double?)cameraJson["farClipM"] ?? 2000.0);

            double anamorphicSqueeze = (double?)cameraJson["anamorphicSqueeze"] ?? 1.0;
            if (Math.Abs(anamorphicSqueeze - 1.0) > 1e-9)
            {
                warnings.Add(
                    $"Camera {directorId}: anamorphic squeeze {anamorphicSqueeze:0.###} has no Unity base-camera " +
                    "equivalent (HDRP-only); omitted (warn-and-omit).");
            }
            string handheldShake = (string)cameraJson["handheldShake"];
            if (handheldShake != null && handheldShake != "off")
            {
                warnings.Add(
                    $"Camera {directorId}: handheld shake \"{handheldShake}\" is a Director viewport effect; " +
                    "omitted (warn-and-omit).");
            }
        }

        private static double[] Vec3(JToken token)
        {
            return new[] { (double)token[0], (double)token[1], (double)token[2] };
        }
    }
}
