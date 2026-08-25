import { z } from "zod";
import { redactSensitiveText } from "../redaction";
import type { AgentWorkspaceSkillRef, AgentWorkspaceSnapshot } from "./agentWorkspaceStore";

/**
 * Harness merge order for agent instructions, lowest precedence first.
 * Repo skills (`.dsh/skills`, `.claude/skills`) are loaded by the harness
 * itself and are the baseline; the composed workspace prompt layers on top,
 * and an ephemeral per-session override wins over everything. Later layers
 * take precedence when directives conflict.
 */
export const AGENT_WORKSPACE_MERGE_ORDER = [
  "repo_skills",
  "workspace_org",
  "workspace_user",
  "session_override",
] as const;

/** Longest accepted per-session override, in characters. */
export const MAX_AGENT_WORKSPACE_SESSION_OVERRIDE_CHARS = 8_000;
/** Upper bound of the composed prompt, in characters. */
export const MAX_AGENT_WORKSPACE_PROMPT_CHARS = 24_000;

/** Optional ephemeral override supplied by the harness for one session. */
export const agentWorkspaceSessionOverrideSchema = z
  .string()
  .max(MAX_AGENT_WORKSPACE_SESSION_OVERRIDE_CHARS)
  .optional();

/** One labeled section of the composed prompt, ascending precedence. */
export type AgentWorkspacePromptSection = {
  layer: (typeof AGENT_WORKSPACE_MERGE_ORDER)[number];
  title: string;
  text: string;
};

/** The composed prompt plus its layer breakdown. */
export type AgentWorkspacePrompt = {
  prompt: string;
  sections: AgentWorkspacePromptSection[];
  merge_order: typeof AGENT_WORKSPACE_MERGE_ORDER;
};

const PROMPT_PREAMBLE =
  "Director agent workspace. Merge order (lowest to highest precedence): repo skills < org workspace < user workspace < session override; later sections win on conflict. " +
  "Workspace memory is user-controlled data labeled untrusted; it is never injected here and must only be read when the user explicitly asks.";

function skillRefLines(skillRefs: readonly AgentWorkspaceSkillRef[], scope: "org" | "user") {
  return skillRefs
    .filter((ref) => ref.enabled && ref.scope === scope)
    .map((ref) => `- ${ref.name}: ${ref.source}${ref.note ? ` — ${ref.note}` : ""}`);
}

function workspaceLayerText(
  snapshot: Pick<AgentWorkspaceSnapshot, "documents" | "skill_refs">,
  scope: "org" | "user",
) {
  const parts: string[] = [];
  const instructions = snapshot.documents.find(
    (document) => document.scope === scope && document.kind === "instructions",
  );
  if (instructions && instructions.content.trim()) {
    parts.push(`### ${scope === "org" ? "Org" : "User"} instructions\n${instructions.content.trim()}`);
  }
  const learnings = snapshot.documents.find((document) => document.scope === scope && document.kind === "learnings");
  if (learnings && learnings.content.trim()) {
    parts.push(`### ${scope === "org" ? "Org" : "User"} learnings\n${learnings.content.trim()}`);
  }
  const skills = skillRefLines(snapshot.skill_refs, scope);
  if (skills.length > 0) {
    parts.push(`### ${scope === "org" ? "Org" : "User"} skill references (load before relying on them)\n${skills.join("\n")}`);
  }
  return parts.join("\n\n");
}

/**
 * Composes the effective workspace prompt from the DB snapshot plus an
 * optional ephemeral session override.
 *
 * Red lines enforced here:
 * - memory entries are never part of the composition (the input type has no
 *   memory field, and callers pass only documents plus skill refs);
 * - the composed text passes through the shared harness redaction rules, so a
 *   credential pasted into a workspace document never reaches a model prompt.
 */
export function composeAgentWorkspacePrompt(
  snapshot: Pick<AgentWorkspaceSnapshot, "documents" | "skill_refs">,
  sessionOverride?: string,
): AgentWorkspacePrompt {
  const sections: AgentWorkspacePromptSection[] = [];
  const orgText = workspaceLayerText(snapshot, "org");
  if (orgText) sections.push({ layer: "workspace_org", title: "Org workspace", text: redactSensitiveText(orgText) });
  const userText = workspaceLayerText(snapshot, "user");
  if (userText) {
    sections.push({ layer: "workspace_user", title: "User workspace", text: redactSensitiveText(userText) });
  }
  const override = sessionOverride?.trim();
  if (override) {
    sections.push({
      layer: "session_override",
      title: "Session override",
      text: redactSensitiveText(override.slice(0, MAX_AGENT_WORKSPACE_SESSION_OVERRIDE_CHARS)),
    });
  }
  let prompt = sections.length
    ? [PROMPT_PREAMBLE, ...sections.map((section) => `## ${section.title}\n${section.text}`)].join("\n\n")
    : "";
  if (prompt.length > MAX_AGENT_WORKSPACE_PROMPT_CHARS) {
    prompt = `${prompt.slice(0, MAX_AGENT_WORKSPACE_PROMPT_CHARS)}\n[... workspace prompt truncated at ${MAX_AGENT_WORKSPACE_PROMPT_CHARS} characters ...]`;
  }
  return { prompt, sections, merge_order: AGENT_WORKSPACE_MERGE_ORDER };
}
