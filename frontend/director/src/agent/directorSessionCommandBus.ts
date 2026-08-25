/**
 * Session-only command bus for Player Mode and Camera Pilot.
 *
 * These commands mutate live browser session state (not project revision).
 * DirectorCanvas owns the handlers; the workbench executor only publishes.
 */

export type DirectorPlayerSessionCommand =
  | { type: "enter"; actor_id?: string }
  | { type: "exit" }
  | { type: "set_actor"; actor_id: string }
  | { type: "teleport"; position: [number, number, number]; object_id?: string }
  | { type: "walk_to"; position?: [number, number, number]; object_id?: string }
  | { type: "interact"; object_id?: string }
  | { type: "enter_vehicle"; object_id?: string }
  | { type: "exit_vehicle" }
  | { type: "record_start" }
  | { type: "record_stop" };

export type DirectorPilotSessionCommand =
  | { type: "start"; camera_id?: string }
  | { type: "stop" }
  | {
      type: "set_view";
      position: [number, number, number];
      target?: [number, number, number];
      fov?: number;
    }
  | { type: "record_waypoint" };

export type DirectorSessionCommand =
  | { surface: "player"; command: DirectorPlayerSessionCommand; requestId: string }
  | { surface: "pilot"; command: DirectorPilotSessionCommand; requestId: string };

export type DirectorSessionCommandResult = {
  requestId: string;
  ok: boolean;
  error?: string;
  result?: Record<string, unknown>;
};

type Listener = (command: DirectorSessionCommand) => void;

const listeners = new Set<Listener>();
const pendingResults = new Map<
  string,
  { resolve: (value: DirectorSessionCommandResult) => void; timer: ReturnType<typeof setTimeout> }
>();

export function subscribeDirectorSessionCommands(listener: Listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishDirectorSessionCommandResult(result: DirectorSessionCommandResult) {
  const pending = pendingResults.get(result.requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingResults.delete(result.requestId);
  pending.resolve(result);
}

/**
 * Dispatch a session command to the live Stage tab and wait for a receipt.
 * Times out if no DirectorCanvas handler is mounted.
 */
export function dispatchDirectorSessionCommand(
  command: Omit<DirectorSessionCommand, "requestId">,
  timeoutMs = 4_000,
): Promise<DirectorSessionCommandResult> {
  const requestId = `session-command:${crypto.randomUUID()}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingResults.delete(requestId);
      resolve({
        requestId,
        ok: false,
        error:
          "No live Director Stage tab handled this session command. Keep a Stage viewport open and retry.",
      });
    }, timeoutMs);
    pendingResults.set(requestId, { resolve, timer });
    const envelope = { ...command, requestId } as DirectorSessionCommand;
    if (!listeners.size) {
      publishDirectorSessionCommandResult({
        requestId,
        ok: false,
        error:
          "No live Director Stage tab is subscribed for Player/Pilot session commands. Open Stage and retry.",
      });
      return;
    }
    listeners.forEach((listener) => listener(envelope));
  });
}
