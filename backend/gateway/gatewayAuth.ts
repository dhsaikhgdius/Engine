import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const DEFAULT_BROWSER_PORTS = [5175, 4173, 8787];

/**
 * The CORS `access-control-allow-headers` value for browser control-plane
 * requests. Every custom header the browser client sends
 * (`agentGatewayClient.ts`: the auth token and the observability trace-source
 * tag) must be listed, or cross-origin fetches fail the preflight with an
 * opaque "Failed to fetch".
 */
export const DIRECTOR_CORS_ALLOWED_REQUEST_HEADERS = "content-type, x-director-browser-token, x-director-trace-source";

function configuredPort(value: string | undefined) {
  if (!value?.trim()) return null;
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
}

function defaultBrowserOrigins() {
  const ports = new Set(DEFAULT_BROWSER_PORTS);
  const uiPort = configuredPort(process.env.DIRECTOR_UI_PORT);
  if (uiPort) ports.add(uiPort);
  const gatewayPort = configuredPort(process.env.STAGE_GATEWAY_PORT);
  if (gatewayPort) ports.add(gatewayPort);
  const origins = new Set<string>();
  for (const port of ports) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }
  return origins;
}

function directorWeakGatewayTokenAllowed() {
  return process.env.DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN?.trim() === "1";
}

/**
 * Returns whether anonymous bootstrap (requests without an `Origin` header and
 * without an existing gateway token) may receive the master gateway secret.
 * Disabled by default; set `DIRECTOR_ALLOW_ANONYMOUS_BOOTSTRAP=1` to opt in.
 */
export function directorAnonymousBootstrapAllowed() {
  return process.env.DIRECTOR_ALLOW_ANONYMOUS_BOOTSTRAP?.trim() === "1";
}

/**
 * Returns the gateway secret, preferring the configured environment variable.
 * When no explicit token is set, generates a random 32-byte base64url token.
 * Short explicit tokens are rejected unless `DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN=1`.
 *
 * @param configured - Optional pre-configured token (defaults to `DIRECTOR_GATEWAY_TOKEN`).
 */
export function createDirectorGatewaySecret(configured = process.env.DIRECTOR_GATEWAY_TOKEN) {
  const explicit = configured?.trim();
  if (explicit && explicit.length < 24 && !directorWeakGatewayTokenAllowed()) {
    throw new Error(
      "DIRECTOR_GATEWAY_TOKEN is shorter than the required 24 characters. Set DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN=1 for local development only.",
    );
  }
  return explicit || randomBytes(32).toString("base64url");
}

/**
 * Returns whether a bootstrap request may receive the master gateway secret.
 * Trusted browser origins and requests that already present the gateway token
 * are always allowed; anonymous no-Origin clients require an explicit opt-in.
 */
export function directorBootstrapRequestAllowed(
  request: IncomingMessage,
  gatewaySecret: string,
  allowedOrigins = directorAllowedOrigins(),
) {
  const origin = typeof request.headers.origin === "string" ? request.headers.origin : undefined;
  if (origin) return trustedDirectorOrigin(origin, allowedOrigins);
  if (directorGatewayTokenMatches(requestDirectorGatewayToken(request, new URL("http://local/")), gatewaySecret)) {
    return true;
  }
  return directorAnonymousBootstrapAllowed();
}

/** Generates a random 32-byte base64url preview capability token. */
export function createDirectorPreviewSecret() {
  return randomBytes(32).toString("base64url");
}

/**
 * Returns the set of allowed browser origins. Starts with localhost on default
 * dev/preview ports, adds the configured UI and gateway ports, then appends
 * any origins from `DIRECTOR_ALLOWED_ORIGINS`.
 *
 * @param configured - Optional comma-separated origin list (defaults to `DIRECTOR_ALLOWED_ORIGINS`).
 */
export function directorAllowedOrigins(configured = process.env.DIRECTOR_ALLOWED_ORIGINS) {
  const origins = defaultBrowserOrigins();
  configured
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((origin) => origins.add(origin));
  return origins;
}

/**
 * Returns whether an origin is trusted. Native CLI/MCP clients that do not
 * send an `Origin` header are always trusted.
 *
 * @param origin - The `Origin` header value.
 * @param allowed - The set of allowed origins (defaults to {@link directorAllowedOrigins} result).
 */
export function trustedDirectorOrigin(origin: string | undefined, allowed = directorAllowedOrigins()) {
  if (!origin) return true; // Native CLI/MCP clients do not send Origin.
  return allowed.has(origin);
}

/**
 * Extracts the gateway authentication token from the `x-director-browser-token`
 * header or the `browser_token` query parameter.
 *
 * @param request - The incoming HTTP request.
 * @param url - The parsed request URL.
 */
export function requestDirectorGatewayToken(request: IncomingMessage, url?: URL) {
  const header = request.headers["x-director-browser-token"];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const fromQuery = url?.searchParams.get("browser_token")?.trim() || "";
  return fromHeader?.trim() || fromQuery;
}

/**
 * Extracts the preview capability token from the `preview_token` query parameter.
 *
 * @param url - The parsed request URL.
 */
export function requestDirectorPreviewToken(url: URL) {
  return url.searchParams.get("preview_token")?.trim() || "";
}

/**
 * Timing-safe comparison of a provided token against the expected token.
 *
 * @param provided - The token from the request.
 * @param expected - The gateway's secret token.
 */
export function directorGatewayTokenMatches(provided: string, expected: string) {
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Returns whether the request path requires gateway authentication.
 * Health checks and the bootstrap endpoint are exempt.
 *
 * @param _request - The incoming HTTP request (unused; reserved for future checks).
 * @param url - The parsed request URL.
 */
export function requiresDirectorGatewayAuth(_request: IncomingMessage, url: URL) {
  if (url.pathname === "/health" || url.pathname === "/te-man/director/agent/bootstrap") return false;
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/te-man/director/agent/") ||
    url.pathname.startsWith("/te-man/director/productions/") ||
    url.pathname.startsWith("/te-man/director/scenes/")
  );
}

/**
 * Authorizes a protected HTTP route. Preview links use a process-epoch,
 * read-only capability so an Agent or browser can render an image URL without
 * exposing the master gateway token. The master token remains valid for
 * operator-driven preview downloads.
 */
export function directorGatewayRequestAuthorized(
  request: IncomingMessage,
  url: URL,
  gatewaySecret: string,
  previewSecret: string,
) {
  if (directorGatewayTokenMatches(requestDirectorGatewayToken(request, url), gatewaySecret)) return true;
  return (
    request.method === "GET" &&
    url.pathname === "/api/preview" &&
    directorGatewayTokenMatches(requestDirectorPreviewToken(url), previewSecret)
  );
}

/**
 * Constructs an authenticated preview URL by appending the preview token to
 * the `/api/preview` path. This allows an agent or browser to render an image
 * without exposing the master gateway token.
 *
 * @param baseUrl - The gateway base URL (e.g. `http://127.0.0.1:8787`).
 * @param previewSecret - The process-epoch preview capability token.
 * @returns The fully qualified authenticated preview URL.
 */
export function authenticatedDirectorPreviewUrl(baseUrl: string, previewSecret: string) {
  const url = new URL("/api/preview", baseUrl);
  url.searchParams.set("preview_token", previewSecret);
  return url.toString();
}
