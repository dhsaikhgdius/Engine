import type { IncomingMessage, ServerResponse } from "node:http";
import { publicControlPlaneCapabilities, type DirectorControlPlaneConfig } from "../controlPlane/controlPlaneConfig";
import { directorToolManifest } from "../controlPlane/toolManifest";

type JsonWriter = (response: ServerResponse, status: number, body: unknown) => void;

export type ControlPlaneRouteDependencies = {
  json: JsonWriter;
  config: DirectorControlPlaneConfig;
  listAgentProfiles: () => unknown[];
  videoCapabilities: () => Promise<unknown>;
};

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
    dependencies.json(response, 200, directorToolManifest());
    return true;
  }
  if (url.pathname === "/api/agent/profiles") {
    dependencies.json(response, 200, { profiles: dependencies.listAgentProfiles() });
    return true;
  }
  if (url.pathname === "/api/video/providers") {
    dependencies.json(response, 200, await dependencies.videoCapabilities());
    return true;
  }
  return false;
}
