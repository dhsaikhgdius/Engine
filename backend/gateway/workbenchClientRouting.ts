import type { DirectorWorkbenchOperation } from "@director/agent-engine";

/**
 * Pure routing policy for choosing which connected browser tab executes an
 * unbound workbench operation. Capture-producing ops must only reach tabs
 * that can actually render (a hidden or non-stage tab would return a blank
 * frame), so the ranking is: capture-ready > stage workspace > anything,
 * then visible over hidden, then most recently seen.
 */

/** Which Director workspace a connected browser tab is showing. */
export type DirectorBrowserWorkspace = "canvas" | "stage" | "video" | "unknown";

/** What a tab last reported about itself, used purely for ranking. */
export type WorkbenchClientRoutingRegistration = {
  visible: boolean;
  lastSeenAt: number;
  workspace: DirectorBrowserWorkspace;
  /** True when the tab can produce real captures (visible stage viewport). */
  captureReady: boolean;
};

/**
 * The routing-relevant slice of a workbench operation: always the op name,
 * plus the compare endpoints when present so a stage-rendering comparison can
 * be pinned to capture-ready tabs while pure media/keyframe comparisons stay
 * routable to any tab.
 */
export type WorkbenchRoutingOperation =
  | Pick<Extract<DirectorWorkbenchOperation, { op: "compare" }>, "op" | "reference" | "candidate">
  | Pick<Exclude<DirectorWorkbenchOperation, { op: "compare" }>, "op">;

/** True when the op needs a rendering-capable tab (capture or stage compare). */
export function workbenchOperationRequiresCapture(operation: WorkbenchRoutingOperation): boolean {
  if (operation.op === "compare") {
    return operation.reference.kind === "stage" || operation.candidate.kind === "stage";
  }
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
  operation: WorkbenchRoutingOperation,
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
