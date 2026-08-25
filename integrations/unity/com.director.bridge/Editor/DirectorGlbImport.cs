using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// GLB payload import for the Director exchange package. Payloads are
    /// copied into the project under content-hashed relative names (the first
    /// 12 hex digits of the manifest SHA-256, which
    /// DirectorExchange.LoadExchangePackage has already verified), imported
    /// synchronously through whatever glTF ScriptedImporter the project has
    /// installed (for example com.unity.cloud.gltfast), and inspected for
    /// skinned meshes so the skeleton pass can build Avatars. Missing
    /// importers warn-and-omit; the connector never parses GLB bytes itself.
    /// </summary>
    public static class DirectorGlbImport
    {
        /// <summary>One imported GLB payload and what the importer produced for it.</summary>
        public sealed class ImportedPayload
        {
            /// <summary>Prefab produced by the project's glTF importer, or null.</summary>
            public GameObject Prefab;

            /// <summary>Project-relative path of the copied GLB asset.</summary>
            public string AssetPath;

            /// <summary>True when the imported hierarchy contains a SkinnedMeshRenderer.</summary>
            public bool HasSkinnedMesh;
        }

        /// <summary>
        /// True when the project has a ScriptedImporter registered for `.glb`
        /// files, probed through the AssetDatabase importer registry (never by
        /// hard-coding a package name).
        /// </summary>
        public static bool GltfImporterAvailable()
        {
            try
            {
                Type[] importers = AssetDatabase.GetAvailableImporters("Assets/Director/probe.glb");
                return importers != null && importers.Length > 0;
            }
            catch (Exception)
            {
                return false;
            }
        }

        /// <summary>
        /// Copies one verified GLB payload into the package asset folder under
        /// a content-hashed name and imports it synchronously.
        /// </summary>
        public static ImportedPayload ImportPayload(
            string assetRefId,
            string sourcePath,
            string sha256,
            string assetFolder,
            List<string> warnings)
        {
            Directory.CreateDirectory(assetFolder);
            string hashedName = $"{HashPrefix(sha256)}-{SafeFileStem(assetRefId)}.glb";
            string destination = $"{assetFolder}/{hashedName}";
            File.Copy(sourcePath, destination, true);
            AssetDatabase.ImportAsset(destination, ImportAssetOptions.ForceSynchronousImport);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(destination);
            if (prefab == null)
            {
                warnings.Add(
                    $"No glTF importer produced a prefab for {destination}; install com.unity.cloud.gltfast " +
                    "(or another glTF importer) for mesh payloads. Created an empty GameObject (warn-and-omit).");
                return new ImportedPayload { Prefab = null, AssetPath = destination, HasSkinnedMesh = false };
            }
            return new ImportedPayload
            {
                Prefab = prefab,
                AssetPath = destination,
                HasSkinnedMesh = prefab.GetComponentsInChildren<SkinnedMeshRenderer>(true).Length > 0,
            };
        }

        /// <summary>
        /// Copies one verified image payload under a content-hashed name and
        /// imports it as a texture. Returns null (with a warning) when the
        /// import produces no readable texture.
        /// </summary>
        public static Texture2D ImportTexture(
            string assetRefId,
            string sourcePath,
            string sha256,
            string assetFolder,
            List<string> warnings)
        {
            string extension = Path.GetExtension(sourcePath).ToLowerInvariant();
            Directory.CreateDirectory(assetFolder);
            string destination = $"{assetFolder}/{HashPrefix(sha256)}-{SafeFileStem(assetRefId)}{extension}";
            File.Copy(sourcePath, destination, true);
            AssetDatabase.ImportAsset(destination, ImportAssetOptions.ForceSynchronousImport);
            var texture = AssetDatabase.LoadAssetAtPath<Texture2D>(destination);
            if (texture == null)
            {
                warnings.Add($"Texture payload {assetRefId} did not import as a Texture2D; binding omitted.");
            }
            return texture;
        }

        /// <summary>First 12 hex digits of the verified SHA-256, or "unhashed".</summary>
        private static string HashPrefix(string sha256)
        {
            if (string.IsNullOrEmpty(sha256)) return "unhashed";
            return sha256.Substring(0, Math.Min(12, sha256.Length));
        }

        /// <summary>Filesystem-safe stem derived from a Director asset id.</summary>
        public static string SafeFileStem(string value)
        {
            char[] characters = (value ?? string.Empty)
                .Select(c => char.IsLetterOrDigit(c) || c == '_' || c == '-' ? c : '_')
                .ToArray();
            string stem = new string(characters, 0, Math.Min(characters.Length, 64)).Trim('_');
            return stem.Length > 0 ? stem : "asset";
        }
    }
}
