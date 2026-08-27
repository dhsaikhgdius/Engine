/**
 * DB-backed agent workspace prompt as a live DSH system-prompt section.
 *
 * The gateway merges organization/user instruction layers (plus an optional
 * per-session override from `DIRECTOR_SESSION_INSTRUCTIONS`) into one
 * redacted prompt; this module fetches it, registers it as the section right
 * after the static guidance, and refreshes it periodically so instruction
 * edits reach new harness sessions without a repo change or DSH restart.
 * Repo skills are not part of this prompt — DSH loads those itself.
 *
 * @module workspacePrompt
 */
import { z } from "zod";
import { fetchDirectorGatewayJson, type DirectorWorkbenchGatewayConfig } from "./gatewayClient";

/** System-prompt section name for the DB-backed agent workspace. */
export const DIRECTOR_WORKSPACE_PROMPT_SECTION = "director:workspace";
/** Order just after the static Director guidance section (113). */
export const DIRECTOR_WORKSPACE_PROMPT_ORDER = 114;
/** Default refresh cadence so new sessions pick up DB edits without a restart. */
export const DEFAULT_WORKSPACE_PROMPT_REFRESH_MS = 30_000;
/** Longest session override forwarded to the gateway, matching its cap. */
export const MAX_SESSION_OVERRIDE_CHARS = 8_000;

const workspacePromptResponseSchema = z.looseObject({ prompt: z.string() });

type WorkspaceSystemPrompt = {
  section(section: { name: string; order: number; text: string }): () => void;
};

type WorkspacePromptContext = {
  get?: (service: string) => unknown;
  effect?: (factory: () => () => void, label: string) => void;
};

/**
 * Resolves the refresh interval from `DIRECTOR_WORKSPACE_REFRESH_MS`.
 * `0` disables periodic refresh; other values are clamped to [5s, 10min].
 */
export function workspacePromptRefreshMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.DIRECTOR_WORKSPACE_REFRESH_MS?.trim();
  if (!raw) return DEFAULT_WORKSPACE_PROMPT_REFRESH_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_WORKSPACE_PROMPT_REFRESH_MS;
  if (parsed <= 0) return 0;
  return Math.min(Math.max(parsed, 5_000), 600_000);
}

/** Ephemeral per-session instruction override from `DIRECTOR_SESSION_INSTRUCTIONS`. */
export function sessionOverrideFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env.DIRECTOR_SESSION_INSTRUCTIONS?.trim();
  return value ? value.slice(0, MAX_SESSION_OVERRIDE_CHARS) : undefined;
}

/**
 * Fetches the merged workspace prompt (repo skills stay DSH-loaded; the
 * gateway merges DB org/user layers plus the session override, redacted).
 *
 * @returns The merged prompt text; empty string when the workspace is empty.
 */
export async function fetchDirectorWorkspacePrompt(
  config: DirectorWorkbenchGatewayConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  signal?: AbortSignal,
): Promise<string> {
  const override = sessionOverrideFromEnv(env);
  const query = override ? `?session_override=${encodeURIComponent(override)}` : "";
  const result = await fetchDirectorGatewayJson(`/api/agent/workspace/prompt${query}`, config, signal);
  if (result.status !== 200) {
    throw new Error(`Director workspace prompt request failed with HTTP ${result.status}`);
  }
  const parsed = workspacePromptResponseSchema.safeParse(result.body);
  if (!parsed.success) throw new Error("Director workspace prompt response was not valid");
  return parsed.data.prompt;
}

/**
 * Registers the DB-backed workspace prompt as a DSH system-prompt section and
 * keeps it fresh, so DB instruction edits appear in new harness sessions
 * without repo changes or a DSH restart.
 *
 * Gateway unavailability is tolerated: the last successful section stays
 * registered and the next refresh retries. Memory entries are never part of
 * the fetched prompt (enforced gateway-side).
 *
 * @returns The refresh function, for manual refresh and tests.
 */
export function registerDirectorWorkspacePrompt(
  context: WorkspacePromptContext,
  config: DirectorWorkbenchGatewayConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<void> {
  const systemPrompt = context.get?.("systemPrompt") as WorkspaceSystemPrompt | undefined;
  if (!systemPrompt) return async () => {};

  let disposeSection: (() => void) | undefined;
  let lastText: string | undefined;
  const refresh = async () => {
    let prompt: string;
    try {
      prompt = await fetchDirectorWorkspacePrompt(config, env);
    } catch {
      return; // gateway down or workspace route unavailable — keep the last section
    }
    if (prompt === lastText) return;
    lastText = prompt;
    disposeSection?.();
    disposeSection = undefined;
    if (prompt) {
      disposeSection = systemPrompt.section({
        name: DIRECTOR_WORKSPACE_PROMPT_SECTION,
        order: DIRECTOR_WORKSPACE_PROMPT_ORDER,
        text: prompt,
      });
    }
  };

  void refresh();
  const intervalMs = workspacePromptRefreshMs(env);
  const start = () => {
    let timer: ReturnType<typeof setInterval> | undefined;
    if (intervalMs > 0) {
      timer = setInterval(() => void refresh(), intervalMs);
      timer.unref?.();
    }
    return () => {
      if (timer) clearInterval(timer);
      disposeSection?.();
      disposeSection = undefined;
    };
  };
  if (context.effect) context.effect(start, "director-workbench: workspace prompt refresh");
  else start();
  return refresh;
}
