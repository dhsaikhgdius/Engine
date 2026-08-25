import type { DirectorAgentTargetWire } from "../../../../../../packages/protocol/src/agentGatewayProtocol";

let boundTarget: DirectorAgentTargetWire | null = null;

/** Small transport-neutral port shared by the gateway connection and API clients. */
export function setBoundDirectorBrowserTarget(target: DirectorAgentTargetWire | null) {
  boundTarget = target ? { ...target } : null;
}

/**
 * Returns a shallow copy of the currently bound browser target.
 *
 * Returns `null` when no target has been bound, so callers can safely
 * distinguish “not yet connected” from a connected target.
 *
 * @returns The bound target snapshot, or `null`.
 */
export function getBoundDirectorBrowserTarget() {
  return boundTarget ? { ...boundTarget } : null;
}
