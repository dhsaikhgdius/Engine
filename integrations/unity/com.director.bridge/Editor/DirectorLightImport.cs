using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Director light import. Directional, point, spot, and rect-area lights
    /// become Unity Light GameObjects tagged with their director_id. Ambient
    /// and hemisphere lights have no scene GameObject transform in either
    /// tool, so they map onto Unity's scene ambient RenderSettings and are
    /// also stamped as typed omittedLights records (warn-and-document: the
    /// look is applied, but no spawnable actor exists). Unknown vocabulary
    /// types are omitted without a RenderSettings side effect. Physical
    /// decay curves and similar approximations warn-and-omit rather than
    /// guessing. All positions arrive in Director canonical space (scene
    /// transform already applied by the caller) and convert through
    /// DirectorSpace.
    /// </summary>
    public static class DirectorLightImport
    {
        /// <summary>
        /// Creates every importable light in the manifest. Returns imported
        /// Light GameObject count plus typed omittedLights records for types
        /// Unity cannot spawn as GameObjects (unknown vocabulary;
        /// ambient/hemisphere after RenderSettings apply).
        /// </summary>
        public sealed class LightImportResult
        {
            public int ImportedLightCount;
            public JArray OmittedLights = new JArray();
        }

        public static LightImportResult ImportLights(
            JArray lights,
            Func<double[], Vector3> directorWorldPointToUnity,
            Dictionary<string, GameObject> byDirectorId,
            List<string> warnings)
        {
            var result = new LightImportResult();
            if (lights == null)
            {
                return result;
            }
            foreach (JToken lightToken in lights)
            {
                var lightJson = (JObject)lightToken;
                string directorId = (string)lightJson["id"];
                string lightType = (string)lightJson["type"];
                switch (lightType)
                {
                    case "ambient":
                        ApplyAmbient(lightJson, warnings, result);
                        break;
                    case "hemisphere":
                        ApplyHemisphere(lightJson, warnings, result);
                        break;
                    case "directional":
                    case "point":
                    case "spot":
                    case "rect-area":
                    {
                        GameObject gameObject = CreateLightObject(
                            lightJson, lightType, directorWorldPointToUnity, warnings);
                        DirectorId marker = gameObject.AddComponent<DirectorId>();
                        marker.directorId = directorId;
                        marker.entityType = "light";
                        byDirectorId[directorId] = gameObject;
                        result.ImportedLightCount += 1;
                        break;
                    }
                    default:
                    {
                        const string code = "light_type_unknown";
                        string reason =
                            $"Light {directorId}: unknown light type \"{lightType}\"; omitted (warn-and-omit code: {code}).";
                        warnings.Add(reason);
                        result.OmittedLights.Add(new JObject
                        {
                            ["directorId"] = directorId,
                            ["code"] = code,
                            ["lightType"] = lightType ?? "unknown",
                            ["reason"] = reason,
                        });
                        break;
                    }
                }
            }
            return result;
        }

        private static void ApplyAmbient(JObject lightJson, List<string> warnings, LightImportResult result)
        {
            string directorId = (string)lightJson["id"];
            const string code = "light_ambient_render_settings";
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
            RenderSettings.ambientLight = ParseColor(lightJson) * Intensity(lightJson);
            string reason =
                $"Light {directorId}: ambient light has no scene GameObject equivalent; " +
                "mapped onto RenderSettings.ambientLight (flat mode) and recorded as an omitted " +
                $"GameObject spawn (warn-and-omit code: {code}).";
            warnings.Add(reason);
            result.OmittedLights.Add(new JObject
            {
                ["directorId"] = directorId,
                ["code"] = code,
                ["lightType"] = "ambient",
                ["reason"] = reason,
            });
        }

        private static void ApplyHemisphere(JObject lightJson, List<string> warnings, LightImportResult result)
        {
            string directorId = (string)lightJson["id"];
            const string code = "light_hemisphere_render_settings";
            float intensity = Intensity(lightJson);
            Color sky = ParseColor(lightJson) * intensity;
            Color ground = sky;
            string groundColor = (string)lightJson["groundColor"];
            if (groundColor != null && ColorUtility.TryParseHtmlString(groundColor, out Color parsedGround))
            {
                ground = parsedGround * intensity;
            }
            RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Trilight;
            RenderSettings.ambientSkyColor = sky;
            RenderSettings.ambientEquatorColor = Color.Lerp(sky, ground, 0.5f);
            RenderSettings.ambientGroundColor = ground;
            string reason =
                $"Light {directorId}: hemisphere light has no scene GameObject equivalent; " +
                "mapped onto RenderSettings trilight ambient (sky/ground) and recorded as an omitted " +
                $"GameObject spawn (warn-and-omit code: {code}).";
            warnings.Add(reason);
            result.OmittedLights.Add(new JObject
            {
                ["directorId"] = directorId,
                ["code"] = code,
                ["lightType"] = "hemisphere",
                ["reason"] = reason,
            });
        }

        private static GameObject CreateLightObject(
            JObject lightJson,
            string lightType,
            Func<double[], Vector3> directorWorldPointToUnity,
            List<string> warnings)
        {
            string directorId = (string)lightJson["id"];
            var gameObject = new GameObject((string)lightJson["name"]);
            Light light = gameObject.AddComponent<Light>();
            light.color = ParseColor(lightJson);
            light.intensity = Intensity(lightJson);
            light.shadows = lightJson["castShadow"] != null && (bool)lightJson["castShadow"]
                ? LightShadows.Soft
                : LightShadows.None;

            Vector3 position = lightJson["position"] != null
                ? directorWorldPointToUnity(Vec3(lightJson["position"]))
                : Vector3.zero;
            gameObject.transform.position = position;
            if (lightJson["target"] != null)
            {
                Vector3 target = directorWorldPointToUnity(Vec3(lightJson["target"]));
                Vector3 forward = target - position;
                if (forward.sqrMagnitude > 1e-12f)
                {
                    gameObject.transform.rotation = Quaternion.LookRotation(forward.normalized, Vector3.up);
                }
            }

            switch (lightType)
            {
                case "directional":
                    light.type = LightType.Directional;
                    break;
                case "point":
                    light.type = LightType.Point;
                    light.range = Range(lightJson, directorId, warnings);
                    break;
                case "spot":
                    light.type = LightType.Spot;
                    light.range = Range(lightJson, directorId, warnings);
                    // Director angle is the half-angle in radians (three.js);
                    // Unity spotAngle is the full cone angle in degrees.
                    double halfAngle = (double?)lightJson["angle"] ?? Math.PI / 6.0;
                    light.spotAngle = (float)(halfAngle * 2.0 * 180.0 / Math.PI);
                    double penumbra = (double?)lightJson["penumbra"] ?? 0.0;
                    light.innerSpotAngle = (float)(light.spotAngle * (1.0 - penumbra));
                    break;
                case "rect-area":
                    light.type = LightType.Rectangle;
                    light.areaSize = new Vector2(
                        (float)((double?)lightJson["width"] ?? 1.0),
                        (float)((double?)lightJson["height"] ?? 1.0));
                    warnings.Add(
                        $"Light {directorId}: rect-area lights are baked-only in Unity's Built-in and URP " +
                        "pipelines; the light is created but only contributes after a lightmap bake.");
                    break;
            }

            double decay = (double?)lightJson["decay"] ?? 2.0;
            if ((lightType == "point" || lightType == "spot") && Math.Abs(decay - 2.0) > 1e-9)
            {
                warnings.Add(
                    $"Light {directorId}: decay {decay:0.###} has no Unity equivalent (Unity uses its own " +
                    "falloff curve); kept Unity's default falloff (warn-and-omit).");
            }
            if (lightJson["visible"] != null && !(bool)lightJson["visible"])
            {
                gameObject.SetActive(false);
            }
            return gameObject;
        }

        private static Color ParseColor(JObject lightJson)
        {
            string color = (string)lightJson["color"];
            return color != null && ColorUtility.TryParseHtmlString(color, out Color parsed) ? parsed : Color.white;
        }

        private static float Intensity(JObject lightJson)
        {
            return (float)((double?)lightJson["intensity"] ?? 1.0);
        }

        private static float Range(JObject lightJson, string directorId, List<string> warnings)
        {
            double distance = (double?)lightJson["distance"] ?? 0.0;
            if (distance > 0.0)
            {
                return (float)distance;
            }
            // Director distance 0 means "no cutoff" (three.js); Unity needs a
            // finite range, so use a large stage-scale default.
            warnings.Add(
                $"Light {directorId}: distance 0 (unlimited) approximated with a 100m Unity range.");
            return 100f;
        }

        private static double[] Vec3(JToken token)
        {
            return new[] { (double)token[0], (double)token[1], (double)token[2] };
        }
    }
}
