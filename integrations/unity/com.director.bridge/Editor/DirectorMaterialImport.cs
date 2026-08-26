using System;
using System.Collections.Generic;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Director PBR manifest material fallback for URP and the Built-in
    /// pipeline. GLB payload materials are translated by the project's glTF
    /// importer; this pass only covers the explicit `material` override a
    /// Director object may carry in the exchange manifest (glTF
    /// metallic-roughness parameterization). Unsupported material graphs
    /// (transmission, clearcoat, IOR, HDRP/custom pipelines) warn-and-omit
    /// instead of guessing. Textures resolve strictly by assetRefId against
    /// the hash-verified package assets — never by array index.
    /// </summary>
    public static class DirectorMaterialImport
    {
        /// <summary>The render pipeline the fallback targets, as reported to the Gateway.</summary>
        public static string DetectRenderPipeline()
        {
            RenderPipelineAsset pipeline =
                GraphicsSettings.currentRenderPipeline != null
                    ? GraphicsSettings.currentRenderPipeline
                    : GraphicsSettings.defaultRenderPipeline;
            if (pipeline == null) return "built-in";
            string typeName = pipeline.GetType().FullName ?? string.Empty;
            if (typeName.Contains("Universal")) return "urp";
            if (typeName.Contains("HighDefinition") || typeName.Contains("HDRenderPipeline")) return "hdrp";
            return "custom";
        }

        /// <summary>
        /// Creates and saves a fallback material for one Director object, or
        /// returns null (with a warning) when the active pipeline has no
        /// supported lit shader. The material asset lives under the package
        /// folder so re-imports overwrite deterministically.
        /// </summary>
        public static Material CreateFallbackMaterial(
            JObject materialJson,
            string directorId,
            string renderPipeline,
            string materialFolder,
            Func<string, Texture2D> resolveTexture,
            List<string> warnings,
            out int appliedTextureCount)
        {
            appliedTextureCount = 0;
            Shader shader = FindLitShader(renderPipeline, directorId, warnings);
            if (shader == null) return null;
            bool universal = renderPipeline == "urp";
            var material = new Material(shader);

            if (materialJson["baseColor"] != null &&
                ColorUtility.TryParseHtmlString((string)materialJson["baseColor"], out Color baseColor))
            {
                material.SetColor(universal ? "_BaseColor" : "_Color", baseColor);
            }
            if (materialJson["metalness"] != null)
            {
                material.SetFloat("_Metallic", (float)(double)materialJson["metalness"]);
            }
            if (materialJson["roughness"] != null)
            {
                // glTF metallic-roughness to Unity smoothness.
                float smoothness = 1f - (float)(double)materialJson["roughness"];
                material.SetFloat(universal ? "_Smoothness" : "_Glossiness", smoothness);
            }
            ApplyOpacity(material, materialJson, universal, directorId, warnings);
            ApplyEmission(material, materialJson, universal);
            ApplySides(material, materialJson, universal, directorId, warnings);
            appliedTextureCount = ApplyTextures(material, materialJson, universal, resolveTexture, directorId, warnings);
            WarnUnsupportedGraphFeatures(materialJson, directorId, warnings);

            System.IO.Directory.CreateDirectory(materialFolder);
            string assetPath = $"{materialFolder}/{DirectorGlbImport.SafeFileStem(directorId)}.mat";
            AssetDatabase.CreateAsset(material, assetPath);
            return material;
        }

        private static Shader FindLitShader(string renderPipeline, string directorId, List<string> warnings)
        {
            switch (renderPipeline)
            {
                case "urp":
                {
                    Shader shader = Shader.Find("Universal Render Pipeline/Lit");
                    if (shader == null)
                    {
                        warnings.Add(
                            $"Object {directorId}: URP is active but Universal Render Pipeline/Lit was not " +
                            "found; material fallback omitted.");
                    }
                    return shader;
                }
                case "built-in":
                {
                    Shader shader = Shader.Find("Standard");
                    if (shader == null)
                    {
                        warnings.Add($"Object {directorId}: the Standard shader was not found; material fallback omitted.");
                    }
                    return shader;
                }
                default:
                    warnings.Add(
                        $"Object {directorId}: Director PBR fallback supports URP and Built-in; the active " +
                        $"{renderPipeline} pipeline uses an unsupported material graph, so the override was " +
                        "omitted (warn-and-omit). GLB payload materials still import through the glTF importer.");
                    return null;
            }
        }

        private static void ApplyOpacity(
            Material material, JObject materialJson, bool universal, string directorId, List<string> warnings)
        {
            double opacity = (double?)materialJson["opacity"] ?? 1.0;
            if (opacity >= 1.0) return;
            string colorProperty = universal ? "_BaseColor" : "_Color";
            Color color = material.GetColor(colorProperty);
            color.a = (float)opacity;
            material.SetColor(colorProperty, color);
            if (universal)
            {
                material.SetFloat("_Surface", 1f); // transparent
                material.SetFloat("_Blend", 0f); // alpha
                material.SetOverrideTag("RenderType", "Transparent");
                material.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
                material.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
                material.SetInt("_ZWrite", 0);
                material.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            }
            else
            {
                material.SetFloat("_Mode", 2f); // fade
                material.SetOverrideTag("RenderType", "Transparent");
                material.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
                material.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
                material.SetInt("_ZWrite", 0);
                material.EnableKeyword("_ALPHABLEND_ON");
            }
            material.renderQueue = (int)RenderQueue.Transparent;
            warnings.Add($"Object {directorId}: opacity {opacity:0.###} mapped to alpha-blended transparency.");
        }

        private static void ApplyEmission(Material material, JObject materialJson, bool universal)
        {
            if (materialJson["emissiveColor"] == null &&
                materialJson["emissiveIntensity"] == null)
            {
                return;
            }
            Color emissive = Color.black;
            if (materialJson["emissiveColor"] != null)
            {
                ColorUtility.TryParseHtmlString((string)materialJson["emissiveColor"], out emissive);
            }
            float intensity = (float)((double?)materialJson["emissiveIntensity"] ?? 1.0);
            material.EnableKeyword("_EMISSION");
            material.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            material.SetColor("_EmissionColor", emissive * intensity);
            if (!universal)
            {
                material.SetFloat("_EmissionEnabled", 1f);
            }
        }

        private static void ApplySides(
            Material material, JObject materialJson, bool universal, string directorId, List<string> warnings)
        {
            string side = (string)materialJson["side"];
            if (side == null || side == "front") return;
            if (universal)
            {
                material.SetFloat("_Cull", (float)CullMode.Off);
                if (side == "back")
                {
                    material.SetFloat("_Cull", (float)CullMode.Front);
                }
            }
            else
            {
                warnings.Add(
                    $"Object {directorId}: the Standard shader cannot render side \"{side}\"; kept front faces " +
                    "(warn-and-omit).");
            }
        }

        private static int ApplyTextures(
            Material material,
            JObject materialJson,
            bool universal,
            Func<string, Texture2D> resolveTexture,
            string directorId,
            List<string> warnings)
        {
            var textures = (JObject)materialJson["textures"];
            if (textures == null) return 0;
            int applied = 0;
            foreach (KeyValuePair<string, JToken> binding in textures)
            {
                string assetRefId = (string)binding.Value;
                if (string.IsNullOrEmpty(assetRefId)) continue;
                switch (binding.Key)
                {
                    case "baseColorMapAssetId":
                        if (AssignTexture(material, universal ? "_BaseMap" : "_MainTex", assetRefId,
                            resolveTexture, directorId, binding.Key, warnings))
                        {
                            applied += 1;
                        }
                        break;
                    case "normalMapAssetId":
                        if (AssignTexture(material, "_BumpMap", assetRefId, resolveTexture, directorId,
                                binding.Key, warnings))
                        {
                            material.EnableKeyword("_NORMALMAP");
                            applied += 1;
                        }
                        break;
                    case "emissiveMapAssetId":
                        if (AssignTexture(material, "_EmissionMap", assetRefId, resolveTexture, directorId,
                                binding.Key, warnings))
                        {
                            material.EnableKeyword("_EMISSION");
                            applied += 1;
                        }
                        break;
                    case "aoMapAssetId":
                        if (AssignTexture(material, "_OcclusionMap", assetRefId, resolveTexture, directorId,
                            binding.Key, warnings))
                        {
                            applied += 1;
                        }
                        break;
                    default:
                        // Unity's lit shaders expect packed metallic-smoothness;
                        // loose roughness/metalness/alpha maps cannot bind 1:1.
                        warnings.Add(
                            $"Object {directorId}: texture slot {binding.Key} has no 1:1 Unity binding " +
                            "(Unity packs metallic and smoothness into one map); omitted (warn-and-omit).");
                        break;
                }
            }
            return applied;
        }

        private static bool AssignTexture(
            Material material,
            string property,
            string assetRefId,
            Func<string, Texture2D> resolveTexture,
            string directorId,
            string slot,
            List<string> warnings)
        {
            Texture2D texture = resolveTexture(assetRefId);
            if (texture == null)
            {
                warnings.Add(
                    $"Object {directorId}: texture slot {slot} references asset {assetRefId} that is not " +
                    "bundled in the exchange package; omitted (warn-and-omit).");
                return false;
            }
            if (!material.HasProperty(property)) return false;
            material.SetTexture(property, texture);
            return true;
        }

        private static void WarnUnsupportedGraphFeatures(
            JObject materialJson, string directorId, List<string> warnings)
        {
            foreach (string feature in new[] { "transmission", "ior", "clearcoat", "clearcoatRoughness" })
            {
                if (materialJson[feature] != null)
                {
                    warnings.Add(
                        $"Object {directorId}: material feature {feature} has no URP/Built-in Lit equivalent; " +
                        "omitted (warn-and-omit).");
                }
            }
            if (materialJson["wireframe"] != null && (bool)materialJson["wireframe"])
            {
                warnings.Add($"Object {directorId}: wireframe rendering is a Director viewport effect; omitted.");
            }
        }
    }
}
