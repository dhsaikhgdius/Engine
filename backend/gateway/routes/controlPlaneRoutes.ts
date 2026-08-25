import type { IncomingMessage, ServerResponse } from "node:http";
import { buildDirectorA2aAgentCard } from "../controlPlane/a2aAgentCard";
import { publicControlPlaneCapabilities, type DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import { buildDirectorToolManifest } from "../controlPlane/toolManifest";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type ControlPlaneRouteDependencies = {
  json: JsonWriter;
  config: DirectorControlPlaneConfig;
  listAgentProfiles: () => unknown[];
  /** Agent sessions that recently drove the workbench tool, newest first. */
  listAgentSessions: () => Array<{ sessionId: string; lastActiveAtMs: number }>;
  videoCapabilities: () => Promise<unknown>;
  /** The gateway's configured Director film role (raw value), or null when unset. */
  filmRole?: () => string | null;
};

// Untargeted HTTP callers that never identify themselves share this fallback
// session id; it is meaningless as a character-binding identity.
const ANONYMOUS_SESSION_ID = "http-default";
const ACTIVE_SESSION_WINDOW_MS = 10 * 60_000;

function publicAgentSession(session: { sessionId: string; lastActiveAtMs: number }, now: number) {
  return {
    id: session.sessionId,
    tool: "director_workbench",
    status: now - session.lastActiveAtMs <= ACTIVE_SESSION_WINDOW_MS ? "active" : "idle",
    last_active_at: new Date(session.lastActiveAtMs).toISOString(),
  };
}

/** Read-only discovery surface for the browser; provider secrets never cross this boundary. */
export async function handleControlPlaneRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  dependencies: ControlPlaneRouteDependencies,
): Promise<boolean> {
  if (request.method !== "GET") return false;
  if (url.pathname === "/api/control-plane/capabilities") {
    dependencies.json(response, 200, publicControlPlaneCapabilities(dependencies.config));
    return true;
  }
  if (url.pathname === "/api/control-plane/tool-manifest") {
    dependencies.json(response, 200, buildDirectorToolManifest());
    return true;
  }
  if (url.pathname === "/api/control-plane/a2a-agent-card") {
    const { host, port } = dependencies.config.http;
    const gatewayBaseUrl = `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
    dependencies.json(response, 200, buildDirectorA2aAgentCard(gatewayBaseUrl));
    return true;
  }
  if (url.pathname === "/api/control-plane/film-role") {
    // Same policy source the tool routes govern with (DIRECTOR_FILM_ROLE); the
    // browser applies the shared roleAllowsTool table to this value. No secrets.
    dependencies.json(response, 200, { role: dependencies.filmRole?.() ?? null });
    return true;
  }
  if (url.pathname === "/api/agent/profiles") {
    dependencies.json(response, 200, { profiles: dependencies.listAgentProfiles() });
    return true;
  }
  if (url.pathname === "/api/agent/sessions") {
    const now = Date.now();
    const sessions = dependencies
      .listAgentSessions()
      .filter((session) => session.sessionId !== ANONYMOUS_SESSION_ID)
      .map((session) => publicAgentSession(session, now));
    dependencies.json(response, 200, { sessions });
    return true;
  }
  if (url.pathname === "/api/video/providers") {
    dependencies.json(response, 200, await dependencies.videoCapabilities());
    return true;
  }
  return false;
}
