import { bootstrapDirectorAgent, clearDirectorAgentClient, directorAgentFetch } from "../assistant/agentGatewayClient";

const CONTROL_PLANE_ORIGIN = (import.meta.env.VITE_STAGE_GATEWAY_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");

/**
 * Builds an absolute URL from a path relative to the control-plane gateway.
 *
 * @param path - A path that may or may not start with "/".
 * @returns The fully qualified control-plane URL.
 */
export function directorControlPlaneUrl(path: string) {
  return `${CONTROL_PLANE_ORIGIN}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Shared authenticated HTTP transport for every control-plane domain.
 *
 * Delegates to the agent gateway's fetch so every request carries the
 * browser token and session headers automatically.
 *
 * @param path - The API path relative to the control-plane origin.
 * @param init - Standard fetch options merged with auth headers.
 * @returns The fetch Response promise.
 */
export function directorControlPlaneFetch(path: string, init: RequestInit = {}) {
  return directorAgentFetch(directorControlPlaneUrl(path), init);
}

/**
 * Builds an EventSource URL with a short-lived epoch token in the query string.
 *
 * EventSource cannot add headers, so the browser token is passed as a query
 * parameter instead.
 *
 * @param path - The SSE endpoint path relative to the control-plane origin.
 * @param query - The URLSearchParams to append the token to.
 * @returns A fully qualified EventSource URL with the token appended.
 */
export async function directorControlPlaneEventUrl(path: string, query: URLSearchParams) {
  const bootstrap = await bootstrapDirectorAgent();
  query.set("browser_token", bootstrap.browserToken);
  return `${directorControlPlaneUrl(path)}?${query}`;
}

/**
 * Clears the cached agent client credentials.
 *
 * Call this when the current browser tab is no longer the active target,
 * so the next request re-authenticates.
 */
export function resetDirectorControlPlaneCredentials() {
  clearDirectorAgentClient();
}
