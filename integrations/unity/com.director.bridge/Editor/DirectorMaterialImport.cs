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
    /// importer; this pass only covers the explicit <c>material</c> override a
    /// Director object may carry in the exchange manifest (glTF
    /// metallic-roughness parameterization). Unsupported material graphs
    /// (transmission, clearcoat, IOR, HDRP/custom pipelines) warn-and-omit
    /// instead of guessing. Textures resolve strictly by assetRefId against
    /// the hash-verified package assets — never by array index.
    /// </summary>
    public static class DirectorMaterialImport
    {
        /// <summary>
        /// Result of one Director PBR fallback attempt: a saved Material when
        /// the pipeline can host it, plus zero or more typed omit records
        /// (whole-fallback failures and/or unsupported_channels while the
        /// Lit/Standard fallback still applies).
        /// </summary>
        public sealed class MaterialImportResult
        {
            public Material Material;
            public readonly List<JObject> OmittedMaterials = new List<JObject>();
        }

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
        /// returns typed omits when the active pipeline has no supported lit
        /// shader. Unsupported graph features / unbound texture slots still
        /// emit typed <c>unsupported_channels</c> while the fallback Material
        /// is created for channels Unity can carry. The material asset lives
        /// under the package folder so re-imports overwrite deterministically.
        /// </summary>
        public static MaterialImportResult CreateFallbackMaterial(
            JObject materialJson,
            string directorId,
            string renderPipeline,
            string materialFolder,
            Func<string, Texture2D> resolveTexture,
            List<string> warnings,
            out int appliedTextureCount)
        {
            appliedTextureCount = 0;
            var result = new MaterialImportResult();
            Shader shader = FindLitShader(renderPipeline, directorId, warnings, out JObject omit);
            if (shader == null)
            {
                result.OmittedMaterials.Add(omit);
                return result;
            }
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
                float smoothness = 1f - (float)(double)materialJson["roughness"];
                material.SetFloat(universal ? "_Smoothness" : "_Glossiness", smoothness);
            }
            ApplyOpacity(material, materialJson, universal, directorId, warnings);
            ApplyEmission(material, materialJson, universal);
            ApplySides(material, materialJson, universal, directorId, warnings);
            var unboundSlots = new List<string>();
            appliedTextureCount = ApplyTextures(
                material, materialJson, universal, resolveTexture, directorId, warnings, unboundSlots);
            JObject channelsOmit = CollectUnsupportedChannelsOmit(
                materialJson, unboundSlots, directorId, renderPipeline, warnings);
            if (channelsOmit != null)
            {
                result.OmittedMaterials.Add(channelsOmit);
            }

            System.IO.Directory.CreateDirectory(materialFolder);
            string assetPath = $"{materialFolder}/{DirectorGlbImport.SafeFileStem(directorId)}.mat";
            AssetDatabase.CreateAsset(material, assetPath);
            result.Material = material;
            return result;
        }

        /// <summary>
        /// Typed omit when a Director material was authored but the GameObject
        /// has no Renderer to receive the fallback (empty / missing mesh).
        /// </summary>
        public static JObject MakeNoMeshTargetOmit(string directorId, string renderPipeline, List<string> warnings)
        {
            const string code = "no_mesh_target";
            string reason =
                $"Object {directorId}: a Director material was authored but the payload has no mesh " +
                $"Renderer to apply it to (warn-and-omit code: {code}).";
            warnings.Add(reason);
            return MakeOmit(directorId, code, renderPipeline, reason);
        }

        /// <summary>Builds the typed omittedMaterials record the Gateway schema expects.</summary>
        private static JObject MakeOmit(string directorId, string code, string renderPipeline, string reason)
        {
            return new JObject
            {
                ["directorId"] = directorId,
                ["code"] = code,
                ["renderPipeline"] = renderPipeline,
                ["reason"] = reason,
            };
        }

        /// <summary>
        /// Resolves the lit fallback shader for the active pipeline, or null
        /// plus a typed omit (shader_missing / pipeline_unsupported) when the
        /// pipeline cannot host the Director PBR parameterization.
        /// </summary>
        private static Shader FindLitShader(
            string renderPipeline, string directorId, List<string> warnings, out JObject omit)
        {
            omit = null;
            switch (renderPipeline)
            {
                case "urp":
                {
                    Shader shader = Shader.Find("Universal Render Pipeline/Lit");
                    if (shader == null)
                    {
                        const string code = "shader_missing";
                        string reason =
                            $"Object {directorId}: URP is active but Universal Render Pipeline/Lit was not " +
                            $"found; material fallback omitted (warn-and-omit code: {code}).";
                        warnings.Add(reason);
                        omit = MakeOmit(directorId, code, renderPipeline, reason);
                    }
                    return shader;
                }
                case "built-in":
                {
                    Shader shader = Shader.Find("Standard");
                    if (shader == null)
                    {
                        const string code = "shader_missing";
                        string reason =
                            $"Object {directorId}: the Standard shader was not found; material fallback " +
                            $"omitted (warn-and-omit code: {code}).";
                        warnings.Add(reason);
                        omit = MakeOmit(directorId, code, renderPipeline, reason);
                    }
                    return shader;
                }
                default:
                {
                    const string code = "pipeline_unsupported";
                    string reason =
                        $"Object {directorId}: Director PBR fallback supports URP and Built-in; the active " +
                        $"{renderPipeline} pipeline uses an unsupported material graph, so the override was " +
                        $"omitted (warn-and-omit code: {code}). GLB payload materials still import through the glTF importer.";
                    warnings.Add(reason);
                    omit = MakeOmit(directorId, code, renderPipeline, reason);
                    return null;
                }
            }
        }

        /// <summary>
        /// Maps opacity below 1 onto alpha-blended transparency, using the
        /// pipeline-specific surface/blend property sets (URP _Surface vs
        /// Standard _Mode) that shader keywords alone do not switch.
        /// </summary>
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
                material.SetFloat("_Surface", 1f);
                material.SetFloat("_Blend", 0f);
                material.SetOverrideTag("RenderType", "Transparent");
                material.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
                material.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
                material.SetInt("_ZWrite", 0);
                material.EnableKeyword("_SURFACE_TYPE_TRANSPARENT");
            }
            else
            {
                material.SetFloat("_Mode", 2f);
                material.SetOverrideTag("RenderType", "Transparent");
                material.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
                material.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
                material.SetInt("_ZWrite", 0);
                material.EnableKeyword("_ALPHABLEND_ON");
            }
            material.renderQueue = (int)RenderQueue.Transparent;
            warnings.Add($"Object {directorId}: opacity {opacity:0.###} mapped to alpha-blended transparency.");
        }

        /// <summary>Applies emissive color x intensity and enables the emission keyword.</summary>
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

        /// <summary>
        /// Maps Director's side property (front/back/double) onto URP cull
        /// modes; the Built-in Standard shader has no cull control, so
        /// non-front sides warn-and-omit there.
        /// </summary>
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

        /// <summary>
        /// Binds manifest texture slots with a faithful 1:1 Unity property
        /// (base color, normal, emissive, AO). Slots Unity packs differently
        /// (e.g. metallic+smoothness in one map) are collected as unbound and
        /// surface in the unsupported_channels omit instead of being guessed.
        /// Returns the number of textures actually applied.
        /// </summary>
        private static int ApplyTextures(
            Material material,
            JObject materialJson,
            bool universal,
            Func<string, Texture2D> resolveTexture,
            string directorId,
            List<string> warnings,
            List<string> unboundSlots)
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
                        unboundSlots.Add(binding.Key);
                        warnings.Add(
                            $"Object {directorId}: texture slot {binding.Key} has no 1:1 Unity binding " +
                            "(Unity packs metallic and smoothness into one map); omitted (warn-and-omit).");
                        break;
                }
            }
            return applied;
        }

        /// <summary>
        /// Resolves one assetRefId through the package-verified texture cache
        /// and assigns it; missing payloads warn-and-omit rather than fail.
        /// </summary>
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

        /// <summary>
        /// Aggregates every Director material channel the Lit/Standard
        /// fallback cannot carry (transmission, IOR, clearcoat, wireframe,
        /// unbound texture slots) into one unsupported_channels omit, or null
        /// when the material mapped cleanly.
        /// </summary>
        private static JObject CollectUnsupportedChannelsOmit(
            JObject materialJson,
            List<string> unboundSlots,
            string directorId,
            string renderPipeline,
            List<string> warnings)
        {
            var unsupported = new List<string>();
            foreach (string feature in new[] { "transmission", "ior", "clearcoat", "clearcoatRoughness" })
            {
                if (materialJson[feature] != null)
                {
                    unsupported.Add(feature);
                }
            }
            if (materialJson["wireframe"] != null && (bool)materialJson["wireframe"])
            {
                unsupported.Add("wireframe");
            }
            foreach (string slot in unboundSlots)
            {
                unsupported.Add(slot);
            }
            if (unsupported.Count == 0) return null;
            const string code = "unsupported_channels";
            string reason =
                $"Object {directorId}: Director material channels {string.Join(", ", unsupported)} have no " +
                $"faithful URP/Built-in Lit binding; omitted (warn-and-omit code: {code}).";
            warnings.Add(reason);
            return MakeOmit(directorId, code, renderPipeline, reason);
        }
    }
}
