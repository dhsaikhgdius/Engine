using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using Newtonsoft.Json.Linq;

namespace Director.Bridge.Editor
{
    /// <summary>
    /// Reads and verifies director-dcc-exchange-package-v1 manifests, and
    /// writes director-dcc-return-v1 packages plus
    /// director-dcc-engine-report-v1 receipts. Pure file I/O; no scene code.
    /// </summary>
    public static class DirectorExchange
    {
        public const string ExchangeContract = "director-dcc-exchange-package-v1";
        public const string ReturnContract = "director-dcc-return-v1";
        public const string ReportContract = "director-dcc-engine-report-v1";
        public const string Provider = "unity";
        public const string ConnectorVersion = "0.3.4";

        public static string Sha256File(string path)
        {
            using var sha = SHA256.Create();
            using var stream = File.OpenRead(path);
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", string.Empty).ToLowerInvariant();
        }

        private static string EnsureInside(string root, string candidate)
        {
            string resolvedRoot = Path.GetFullPath(root);
            string resolved = Path.GetFullPath(candidate);
            if (resolved != resolvedRoot &&
                !resolved.StartsWith(resolvedRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                throw new InvalidDataException($"Package path escapes the package root: {candidate}");
            }
            return resolved;
        }

        /// <summary>Loads and hash-verifies an exchange package manifest.</summary>
        public static JObject LoadExchangePackage(string packageDir)
        {
            string manifestPath = Path.Combine(packageDir, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                throw new InvalidDataException($"Exchange package is missing manifest.json: {packageDir}");
            }
            var manifest = JObject.Parse(File.ReadAllText(manifestPath));
            if ((string)manifest["contract"] != ExchangeContract)
            {
                throw new InvalidDataException($"Unexpected exchange contract: {manifest["contract"]}");
            }
            if ((string)manifest["provider"] != Provider)
            {
                throw new InvalidDataException(
                    $"Exchange package targets provider {manifest["provider"]}, expected {Provider}");
            }
            foreach (string section in new[] { "formats", "assets" })
            {
                foreach (JToken entry in (JArray)(manifest[section] ?? new JArray()))
                {
                    string relativePath = (string)entry["relativePath"];
                    string absolute = EnsureInside(packageDir, Path.Combine(packageDir, relativePath));
                    if (!File.Exists(absolute))
                    {
                        throw new InvalidDataException($"Exchange package file is missing: {relativePath}");
                    }
                    string actual = Sha256File(absolute);
                    if (actual != (string)entry["sha256"])
                    {
                        throw new InvalidDataException(
                            $"SHA-256 mismatch for {relativePath}: expected {entry["sha256"]}, found {actual}");
                    }
                }
            }
            return manifest;
        }

        public static string ResolvePackageFile(string packageDir, string relativePath)
        {
            return EnsureInside(packageDir, Path.Combine(packageDir, relativePath));
        }

        /// <summary>
        /// Writes a director-dcc-return-v1 package. Changes must already be in
        /// Director canonical space (converted at the provider boundary).
        /// </summary>
        public static string WriteReturnPackage(
            string returnDir,
            string hostVersion,
            string sourcePackageId,
            string sourceRevision,
            JArray changes,
            IEnumerable<string> warnings)
        {
            Directory.CreateDirectory(returnDir);
            var manifest = new JObject
            {
                ["schemaVersion"] = 1,
                ["contract"] = ReturnContract,
                ["packageId"] = $"{Provider}-return-{sourcePackageId}",
                ["sourcePackageId"] = sourcePackageId,
                ["sourceRevision"] = sourceRevision,
                ["exportedAt"] = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"),
                ["provider"] = Provider,
                ["hostVersion"] = hostVersion,
                ["connectorVersion"] = ConnectorVersion,
                ["coordinateSystem"] = new JObject
                {
                    ["source"] = "right-handed-y-up-negative-z-forward",
                    ["destination"] = "right-handed-y-up-negative-z-forward",
                    ["unit"] = "meter",
                    ["linearMap"] = "identity",
                },
                ["changes"] = changes,
                ["warnings"] = new JArray(warnings),
                ["fileHashes"] = new JObject(),
            };
            string manifestPath = Path.Combine(returnDir, "manifest.json");
            File.WriteAllText(manifestPath, manifest.ToString(Newtonsoft.Json.Formatting.Indented) + "\n");
            return manifestPath;
        }

        /// <summary>
        /// Writes the director-dcc-engine-report-v1 receipt the Gateway
        /// validates. The optional unity block carries connector-specific
        /// facts (render pipeline, glTF importer availability, baked clip and
        /// avatar counts) matching directorDccUnityEngineReportDetailsSchema.
        /// </summary>
        public static void WriteReport(
            string reportPath,
            string hostVersion,
            string packageId,
            string sourceRevision,
            int importedObjectCount,
            int importedCameraCount,
            string scenePath,
            string returnPackageDir,
            IEnumerable<string> warnings,
            JObject unityDetails = null)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(reportPath) ?? ".");
            var report = new JObject
            {
                ["ok"] = true,
                ["contract"] = ReportContract,
                ["provider"] = Provider,
                ["hostVersion"] = hostVersion,
                ["connectorVersion"] = ConnectorVersion,
                ["packageId"] = packageId,
                ["sourceRevision"] = sourceRevision,
                ["importedObjectCount"] = importedObjectCount,
                ["importedCameraCount"] = importedCameraCount,
                ["scenePath"] = scenePath == null ? JValue.CreateNull() : (JToken)scenePath,
                ["returnPackageDir"] = returnPackageDir == null ? JValue.CreateNull() : (JToken)returnPackageDir,
                ["warnings"] = new JArray(warnings),
            };
            if (unityDetails != null)
            {
                report["unity"] = unityDetails;
            }
            File.WriteAllText(reportPath, report.ToString(Newtonsoft.Json.Formatting.Indented) + "\n");
        }

        /// <summary>Writes an ok:false report so the Gateway fails the job with a reason.</summary>
        public static void WriteFailureReport(string reportPath, string error)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(reportPath) ?? ".");
            var report = new JObject { ["ok"] = false, ["error"] = error };
            File.WriteAllText(reportPath, report.ToString(Newtonsoft.Json.Formatting.Indented) + "\n");
        }
    }
}
