// @vitest-environment node

import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticatedDirectorPreviewUrl,
  createDirectorGatewaySecret,
  createDirectorPreviewSecret,
  DIRECTOR_CORS_ALLOWED_REQUEST_HEADERS,
  directorAllowedOrigins,
  directorBootstrapRequestAllowed,
  directorGatewayRequestAuthorized,
  directorGatewayTokenMatches,
  requestDirectorGatewayToken,
  requiresDirectorGatewayAuth,
  trustedDirectorOrigin,
} from "../../gatewayAuth";

describe("Director gateway authorization boundary", () => {
  const originalUiPort = process.env.DIRECTOR_UI_PORT;
  const originalGatewayPort = process.env.STAGE_GATEWAY_PORT;
  const originalAllowWeak = process.env.DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN;
  const originalAllowAnonymousBootstrap = process.env.DIRECTOR_ALLOW_ANONYMOUS_BOOTSTRAP;

  beforeEach(() => {
    delete process.env.DIRECTOR_UI_PORT;
    delete process.env.STAGE_GATEWAY_PORT;
    delete process.env.DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN;
    delete process.env.DIRECTOR_ALLOW_ANONYMOUS_BOOTSTRAP;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalUiPort === undefined) delete process.env.DIRECTOR_UI_PORT;
    else process.env.DIRECTOR_UI_PORT = originalUiPort;
    if (originalGatewayPort === undefined) delete process.env.STAGE_GATEWAY_PORT;
    else process.env.STAGE_GATEWAY_PORT = originalGatewayPort;
    if (originalAllowWeak === undefined) delete process.env.DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN;
    else process.env.DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN = originalAllowWeak;
    if (originalAllowAnonymousBootstrap === undefined) delete process.env.DIRECTOR_ALLOW_ANONYMOUS_BOOTSTRAP;
    else process.env.DIRECTOR_ALLOW_ANONYMOUS_BOOTSTRAP = originalAllowAnonymousBootstrap;
  });

  it("uses a configured or random process secret and rejects short tokens unless opted in", () => {
    expect(createDirectorGatewaySecret("x".repeat(32))).toBe("x".repeat(32));
    expect(createDirectorGatewaySecret("")).toHaveLength(43);
    expect(() => createDirectorGatewaySecret("too-short")).toThrow(/24 characters/);
    process.env.DIRECTOR_ALLOW_WEAK_GATEWAY_TOKEN = "1";
    expect(createDirectorGatewaySecret("too-short")).toBe("too-short");
  });

  it("allows only the local Director browser origins by default", () => {
    expect(trustedDirectorOrigin("http://127.0.0.1:5175")).toBe(true);
    expect(trustedDirectorOrigin("http://localhost:5175")).toBe(true);
    expect(trustedDirectorOrigin("http://127.0.0.1:4173")).toBe(true);
    expect(trustedDirectorOrigin(undefined)).toBe(true);
    expect(trustedDirectorOrigin("http://127.0.0.1:5176")).toBe(false);
    expect(trustedDirectorOrigin("http://127.0.0.1:5175.attacker.example")).toBe(false);
    expect(trustedDirectorOrigin("https://attacker.example")).toBe(false);
    expect(trustedDirectorOrigin("null")).toBe(false);
  });

  it("adds only explicitly configured browser origins", () => {
    const allowed = directorAllowedOrigins("https://director.example, http://127.0.0.1:6200");

    expect(trustedDirectorOrigin("https://director.example", allowed)).toBe(true);
    expect(trustedDirectorOrigin("http://127.0.0.1:6200", allowed)).toBe(true);
    expect(trustedDirectorOrigin("https://director.example.attacker.test", allowed)).toBe(false);
    expect(trustedDirectorOrigin("http://127.0.0.1:6201", allowed)).toBe(false);
  });

  it("preflight-approves every custom header the browser control-plane client sends", () => {
    const allowed = DIRECTOR_CORS_ALLOWED_REQUEST_HEADERS.split(",").map((header) => header.trim().toLowerCase());
    // Scan the browser client for X-Director-* request headers so a newly
    // added header cannot silently break cross-origin fetches again (the
    // observability trace-source tag once failed preflight as an opaque
    // "Failed to fetch").
    const clientSource = readFileSync(
      resolve(__dirname, "../../../../frontend/director/src/comprehensive/editor/assistant/agentGatewayClient.ts"),
      "utf8",
    );
    const sentHeaders = new Set(
      [...clientSource.matchAll(/["'](x-director-[a-z0-9-]+)["']/gi)].map((match) => match[1]!.toLowerCase()),
    );
    expect(sentHeaders.size).toBeGreaterThanOrEqual(2);
    for (const header of sentHeaders) {
      expect(allowed).toContain(header);
    }
  });

  it("admits the configured UI and gateway ports into the default origin allowlist", () => {
    process.env.DIRECTOR_UI_PORT = "6300";
    process.env.STAGE_GATEWAY_PORT = "9600";
    const allowed = directorAllowedOrigins("");

    expect(trustedDirectorOrigin("http://127.0.0.1:6300", allowed)).toBe(true);
    expect(trustedDirectorOrigin("http://localhost:6300", allowed)).toBe(true);
    expect(trustedDirectorOrigin("http://127.0.0.1:9600", allowed)).toBe(true);
    expect(trustedDirectorOrigin("http://localhost:9600", allowed)).toBe(true);
    expect(trustedDirectorOrigin("http://127.0.0.1:5175", allowed)).toBe(true);
    expect(trustedDirectorOrigin("http://127.0.0.1:6301", allowed)).toBe(false);
  });

  it("ignores malformed port environment values when building default origins", () => {
    process.env.DIRECTOR_UI_PORT = "not-a-port";
    process.env.STAGE_GATEWAY_PORT = "70000";
    const allowed = directorAllowedOrigins("");

    expect([...allowed].sort()).toEqual(
      [
        "http://127.0.0.1:5175",
        "http://localhost:5175",
        "http://127.0.0.1:4173",
        "http://localhost:4173",
        "http://127.0.0.1:8787",
        "http://localhost:8787",
      ].sort(),
    );
  });

  it("compares tokens exactly and accepts the EventSource/WebSocket query form", () => {
    expect(directorGatewayTokenMatches("secret-value", "secret-value")).toBe(true);
    expect(directorGatewayTokenMatches("secret-value-2", "secret-value")).toBe(false);
    const request = { headers: {} } as IncomingMessage;
    expect(requestDirectorGatewayToken(request, new URL("http://local/ws?browser_token=query-secret"))).toBe(
      "query-secret",
    );
  });

  it("protects state, production, agent, and preview routes while leaving bootstrap public", () => {
    const post = { method: "POST", headers: {} } as IncomingMessage;
    const get = { method: "GET", headers: {} } as IncomingMessage;
    expect(requiresDirectorGatewayAuth(post, new URL("http://local/api/tools/director_workbench"))).toBe(true);
    expect(requiresDirectorGatewayAuth(get, new URL("http://local/api/agent/sessions"))).toBe(true);
    expect(requiresDirectorGatewayAuth(get, new URL("http://local/te-man/director/agent/health"))).toBe(true);
    expect(requiresDirectorGatewayAuth(get, new URL("http://local/te-man/director/productions/main"))).toBe(true);
    expect(requiresDirectorGatewayAuth(get, new URL("http://local/te-man/director/scenes/scene-1"))).toBe(true);
    expect(requiresDirectorGatewayAuth(post, new URL("http://local/te-man/director/agent/bootstrap"))).toBe(false);
    expect(requiresDirectorGatewayAuth(get, new URL("http://local/api/preview"))).toBe(true);
  });

  it("accepts a scoped, process-epoch capability for preview reads only", () => {
    const gatewaySecret = "gateway-secret-value-that-is-long";
    const previewSecret = createDirectorPreviewSecret();
    const get = { method: "GET", headers: {} } as IncomingMessage;
    const post = { method: "POST", headers: {} } as IncomingMessage;
    const previewUrl = new URL(authenticatedDirectorPreviewUrl("http://127.0.0.1:8787", previewSecret));

    expect(previewSecret).toHaveLength(43);
    expect(previewUrl.searchParams.get("preview_token")).toBe(previewSecret);
    expect(directorGatewayRequestAuthorized(get, previewUrl, gatewaySecret, previewSecret)).toBe(true);
    expect(directorGatewayRequestAuthorized(post, previewUrl, gatewaySecret, previewSecret)).toBe(false);
    expect(
      directorGatewayRequestAuthorized(
        get,
        new URL(`http://local/api/stage?preview_token=${previewSecret}`),
        gatewaySecret,
        previewSecret,
      ),
    ).toBe(false);
    expect(
      directorGatewayRequestAuthorized(
        get,
        new URL("http://local/api/preview?preview_token=wrong"),
        gatewaySecret,
        previewSecret,
      ),
    ).toBe(false);
  });

  it("allows bootstrap only for trusted origins, existing tokens, or explicit anonymous opt-in", () => {
    const gatewaySecret = "gateway-secret-value-that-is-long";
    const anonymous = { method: "POST", headers: {} } as IncomingMessage;
    const browser = {
      method: "POST",
      headers: { origin: "http://127.0.0.1:5175" },
    } as IncomingMessage;
    const authenticated = {
      method: "POST",
      headers: { "x-director-browser-token": gatewaySecret } as IncomingMessage["headers"],
    } as IncomingMessage;

    expect(directorBootstrapRequestAllowed(anonymous, gatewaySecret)).toBe(false);
    expect(directorBootstrapRequestAllowed(browser, gatewaySecret)).toBe(true);
    expect(directorBootstrapRequestAllowed(authenticated, gatewaySecret)).toBe(true);

    process.env.DIRECTOR_ALLOW_ANONYMOUS_BOOTSTRAP = "1";
    expect(directorBootstrapRequestAllowed(anonymous, gatewaySecret)).toBe(true);
  });
});
