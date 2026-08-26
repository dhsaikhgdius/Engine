import { z } from "zod";
import {
  directorDccEngineEditorLaunchSchema,
  directorDccEngineRunStatusSchema,
  type DirectorDccEngineEditorLaunch,
  type DirectorDccEngineRunStatus,
} from "../../../dcc/directorDccEngineRunContract";
import { directorDccEngineIdSchema, type DirectorDccEngineId } from "../../../dcc/directorDccEngineSpace";
import { directorControlPlaneFetch } from "./directorControlPlaneClient";

const launchResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccEngineEditorLaunchSchema,
});

const runResponseSchema = z.strictObject({
  success: z.literal(true),
  result: directorDccEngineRunStatusSchema,
});

const gatewayErrorSchema = z.looseObject({
  code: z.string().trim().min(1).optional(),
  error: z.string().trim().min(1).optional(),
  recovery: z.array(z.string()).optional(),
});

/** Error thrown when the gateway rejects an engine editor-launch or run call. */
export class DirectorDccEngineRunClientError extends Error {
  /** HTTP status code from the gateway response. */
  readonly status: number;
  /** Machine-readable error code from the gateway. */
  readonly code?: string;
  /** Ordered, user-actionable recovery steps from the gateway. */
  readonly recovery: string[];

  constructor(message: string, status: number, code?: string, recovery: string[] = []) {
    super(message);
    this.name = "DirectorDccEngineRunClientError";
    this.status = status;
    this.code = code;
    this.recovery = recovery;
  }
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function throwGatewayError(response: Response, body: unknown, fallback: string): never {
  const parsed = gatewayErrorSchema.safeParse(body);
  if (parsed.success && (parsed.data.error || parsed.data.code)) {
    throw new DirectorDccEngineRunClientError(
      parsed.data.error ?? fallback,
      response.status,
      parsed.data.code,
      parsed.data.recovery ?? [],
    );
  }
  throw new DirectorDccEngineRunClientError(
    `${fallback}: gateway response did not match the Director DCC contract`,
    response.ok ? 502 : response.status,
    "invalid_response",
  );
}

async function callDirectorDcc(input: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return directorControlPlaneFetch("/api/tools/director_dcc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
    ...(signal ? { signal } : {}),
  });
}

/**
 * Opens the configured engine project in its editor GUI. The gateway spawns
 * the discovered engine executable with a fixed argument vector, detached —
 * never a request-supplied script.
 *
 * @param provider - The engine to open ("unreal", "unity", or "godot").
 * @returns The validated launch receipt (executable, project, pid).
 */
export async function launchDirectorEngineEditor(
  provider: DirectorDccEngineId,
): Promise<DirectorDccEngineEditorLaunch> {
  const engine = directorDccEngineIdSchema.parse(provider);
  const response = await callDirectorDcc({ op: "launch_engine_editor", provider: engine });
  const body = await responseJson(response);
  const parsed = launchResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Engine editor launch failed");
}

/**
 * Starts the configured engine project run with bounded output capture
 * (Godot today; Unity/Unreal answer structured `engine_run_unsupported`).
 *
 * @param provider - The engine to run.
 * @param options - Optional `res://` scene and headless flag.
 * @returns The initial run status.
 */
export async function runDirectorEngineProject(
  provider: DirectorDccEngineId,
  options: { scene?: string; headless?: boolean } = {},
): Promise<DirectorDccEngineRunStatus> {
  const engine = directorDccEngineIdSchema.parse(provider);
  const response = await callDirectorDcc({
    op: "run_engine_project",
    provider: engine,
    ...(options.scene?.trim() ? { scene: options.scene.trim() } : {}),
    ...(options.headless !== undefined ? { headless: options.headless } : {}),
  });
  const body = await responseJson(response);
  const parsed = runResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Engine project run failed to start");
}

/**
 * Reads the current or most recent engine project run, including the bounded
 * stdout/stderr tail.
 *
 * @param provider - The engine whose run to read.
 * @param options - Optional abort signal for cancellation.
 * @returns The validated run status.
 */
export async function fetchDirectorEngineRunStatus(
  provider: DirectorDccEngineId,
  options: { signal?: AbortSignal } = {},
): Promise<DirectorDccEngineRunStatus> {
  const engine = directorDccEngineIdSchema.parse(provider);
  const response = await callDirectorDcc({ op: "engine_run_status", provider: engine }, options.signal);
  const body = await responseJson(response);
  const parsed = runResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Engine run status read failed");
}

/**
 * Stops the active engine project run (SIGTERM, escalating to SIGKILL).
 *
 * @param provider - The engine whose run to stop.
 * @returns The final run status.
 */
export async function stopDirectorEngineProject(provider: DirectorDccEngineId): Promise<DirectorDccEngineRunStatus> {
  const engine = directorDccEngineIdSchema.parse(provider);
  const response = await callDirectorDcc({ op: "stop_engine_project", provider: engine });
  const body = await responseJson(response);
  const parsed = runResponseSchema.safeParse(body);
  if (parsed.success && response.ok) return parsed.data.result;
  return throwGatewayError(response, body, "Engine project stop failed");
}
