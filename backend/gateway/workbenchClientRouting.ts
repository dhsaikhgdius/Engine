import type { DirectorWorkbenchOperation } from "@director/agent-engine";

export type DirectorBrowserWorkspace = "canvas" | "stage" | "video" | "unknown";

export type WorkbenchClientRoutingRegistration = {
  visible: boolean;
  lastSeenAt: number;
  workspace: DirectorBrowserWorkspace;
  captureReady: boolean;
};

export function workbenchOperationRequiresCapture(operation: Pick<DirectorWorkbenchOperation, "op">): boolean {
  return (
    operation.op === "capture" ||
    operation.op === "shot_package" ||
    operation.op === "deliver" ||
    operation.op === "storyboard_artifact"
  );
}

function workbenchCapabilityRank(registration: WorkbenchClientRoutingRegistration) {
  if (registration.captureReady) return 2;
  if (registration.workspace === "stage") return 1;
  return 0;
}

/**
 * Ranks only an as-yet unbound Workbench request. Exact target leases bypass
 * this helper entirely, so a later capture can never jump to another tab.
 */
export function rankUntargetedWorkbenchClients<Client>(
  entries: ReadonlyArray<readonly [Client, WorkbenchClientRoutingRegistration]>,
  operation: Pick<DirectorWorkbenchOperation, "op">,
) {
  const captureRequired = workbenchOperationRequiresCapture(operation);
  return entries
    .filter(([, registration]) => (captureRequired ? registration.captureReady : true))
    .sort(
      (left, right) =>
        workbenchCapabilityRank(right[1]) - workbenchCapabilityRank(left[1]) ||
        Number(right[1].visible) - Number(left[1].visible) ||
        right[1].lastSeenAt - left[1].lastSeenAt,
    )
    .map(([client]) => client);
}
