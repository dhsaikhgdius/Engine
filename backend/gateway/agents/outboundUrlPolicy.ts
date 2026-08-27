import { isIP } from "node:net";

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata.google"]);

function normalizeComparableUrl(baseUrl: string) {
  const parsed = new URL(baseUrl);
  parsed.hash = "";
  parsed.search = "";
  let pathname = parsed.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/chat/completions")) pathname = pathname.slice(0, -"/chat/completions".length);
  if (pathname.endsWith("/messages")) pathname = pathname.slice(0, -"/messages".length);
  if (pathname.endsWith("/models")) pathname = pathname.slice(0, -"/models".length);
  parsed.pathname = pathname || "/";
  return parsed.toString().replace(/\/$/, "");
}

function isPrivateOrMetadataAddress(hostname: string) {
  const normalized = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  if (normalized === "0.0.0.0" || normalized.endsWith(".local")) return true;
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) {
    const parts = normalized.split(".").map((part) => Number(part));
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (ipVersion === 6) {
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80")
    );
  }
  return false;
}

/**
 * Rejects outbound provider URLs that target loopback, RFC1918, link-local,
 * or cloud metadata endpoints.
 */
export function assertAllowedOutboundProviderUrl(baseUrl: string) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Provider baseUrl must use HTTP or HTTPS");
  }
  if (isPrivateOrMetadataAddress(parsed.hostname)) {
    throw new Error("Provider baseUrl must not target private or metadata addresses");
  }
}

/**
 * When a stored provider credential is used, the requested baseUrl must match
 * the provider's saved endpoint so credentials cannot be exfiltrated elsewhere.
 */
export function assertStoredProviderBaseUrlMatches(storedBaseUrl: string, requestedBaseUrl: string) {
  if (normalizeComparableUrl(storedBaseUrl) !== normalizeComparableUrl(requestedBaseUrl)) {
    throw new Error("baseUrl must match the stored provider endpoint");
  }
}
