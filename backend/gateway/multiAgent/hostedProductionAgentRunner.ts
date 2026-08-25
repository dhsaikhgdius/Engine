import type { AgentEvent, AgentProvider } from "@director/agent-engine";
import type { FilmRoleId } from "../../../packages/protocol/src/filmProductionProtocol";
import type { DirectorProject } from "@director/project-schema";
import { createModelDriver, type ModelDriver } from "@director/model-provider/runtime";
import { filmRoleRequiresToolLoop } from "../agents/filmRoleToolPolicy";
import type { AgentProfileRegistry } from "../agents/agentProfileRegistry";
import type { ProductionAgentRunner } from "./productionRunOrchestrator";

type HostedDriverFactory = (input: {
  kind: "anthropic-messages" | "openai-chat-compatible";
  id: string;
  baseUrl: string;
  apiKey: string;
}) => Pick<ModelDriver, "complete">;

type SessionRecord = {
  id: string;
  provider: AgentProvider;
  profileId: string;
  roleId: FilmRoleId;
  abort: AbortController;
};

function assistantText(content: { type: string; text?: string }[]) {
  return content
    .filter((item) => item.type === "text")
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

/**
 * Runs one multi-agent production node through a hosted model profile.
 *
 * Local CLI profiles stay visible when their binaries exist, but gateway
 * production runs execute hosted (`api`) observe-only roles only — DSH owns
 * the Codex / Claude tool loop, and mutating / visual-evidence roles still
 * require workbench tools.
 */
export class HostedProductionAgentRunner implements ProductionAgentRunner {
  private sessionSequence = 0;
  private eventSequence = 0;
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly eventsBySession = new Map<string, AgentEvent[]>();
  private readonly listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  readonly store = {
    listEvents: (sessionId: string) => this.eventsBySession.get(sessionId) ?? [],
  };

  constructor(
    private readonly profiles: AgentProfileRegistry,
    private readonly createDriver: HostedDriverFactory = (input) =>
      createModelDriver(
        input.kind === "anthropic-messages"
          ? { kind: "anthropic-messages", id: input.id, baseUrl: input.baseUrl, apiKey: input.apiKey }
          : { kind: "openai-chat-compatible", id: input.id, baseUrl: input.baseUrl, apiKey: input.apiKey },
      ),
  ) {}

  createSession(input: { provider: AgentProvider; profileId: string; roleId: FilmRoleId; title: string }) {
    const id = `production-session-${++this.sessionSequence}`;
    this.sessions.set(id, {
      id,
      provider: input.provider,
      profileId: input.profileId,
      roleId: input.roleId,
      abort: new AbortController(),
    });
    this.eventsBySession.set(id, []);
    return { id };
  }

  subscribe(sessionId: string, listener: (event: AgentEvent) => void) {
    const listeners = this.listeners.get(sessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.listeners.delete(sessionId);
    };
  }

  async interrupt(sessionId: string) {
    this.sessions.get(sessionId)?.abort.abort(new DOMException("Production run cancelled", "AbortError"));
  }

  async sendMessage(
    sessionId: string,
    prompt: string,
    _project: DirectorProject | undefined,
    _target: unknown,
  ) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown production session ${sessionId}`);
    if (session.provider !== "api") {
      throw new Error(
        `${session.provider} profiles run through DeepSeek Harness; production runs require a hosted API Profile`,
      );
    }
    if (filmRoleRequiresToolLoop(session.roleId)) {
      throw new Error(
        `${session.roleId} requires Director workbench tools; hosted production runs cannot execute this role`,
      );
    }
    const profile = this.profiles.get(session.profileId);
    const hosted = profile?.hostedConfig;
    if (!profile || !hosted) {
      throw new Error(`Production run Profile（${session.profileId}）不可用`);
    }
    const driver = this.createDriver({
      kind: hosted.driver === "anthropic" ? "anthropic-messages" : "openai-chat-compatible",
      id: hosted.id,
      baseUrl: hosted.baseUrl,
      apiKey: hosted.apiKey ?? "",
    });
    try {
      const completion = await driver.complete({
        model: hosted.model,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
        signal: session.abort.signal,
      });
      const text = assistantText(completion.message.content);
      if (!text) throw new Error(`${hosted.model} returned an empty completion`);
      this.append(sessionId, "assistant.message", { text });
      this.emit(sessionId, "turn.completed", { status: "completed" });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit(sessionId, "turn.completed", { status: "failed", error: message });
    }
  }

  private append(sessionId: string, type: AgentEvent["type"], data: Record<string, unknown>): AgentEvent {
    const event = {
      id: `production-event-${++this.eventSequence}`,
      sessionId,
      sequence: this.eventSequence,
      type,
      timestamp: new Date().toISOString(),
      turnId: null,
      itemId: null,
      provider: "api",
      data,
    } satisfies AgentEvent;
    this.eventsBySession.get(sessionId)?.push(event);
    return event;
  }

  private emit(sessionId: string, type: AgentEvent["type"], data: Record<string, unknown>) {
    const event = this.append(sessionId, type, data);
    for (const listener of [...(this.listeners.get(sessionId) ?? [])]) listener(event);
  }
}
