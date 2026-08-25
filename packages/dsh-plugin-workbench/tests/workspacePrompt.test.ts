// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_PROMPT_REFRESH_MS,
  DIRECTOR_WORKSPACE_PROMPT_ORDER,
  DIRECTOR_WORKSPACE_PROMPT_SECTION,
  fetchDirectorWorkspacePrompt,
  registerDirectorWorkspacePrompt,
  sessionOverrideFromEnv,
  workspacePromptRefreshMs,
} from "../src/workspacePrompt";

const GATEWAY_TOKEN = "t".repeat(32);

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fakeContext() {
  const sections: { name: string; order: number; text: string }[] = [];
  const disposals: string[] = [];
  const effects: Array<() => void> = [];
  const context = {
    get: (service: string) =>
      service === "systemPrompt"
        ? {
            section(section: { name: string; order: number; text: string }) {
              sections.push(section);
              return () => disposals.push(section.text);
            },
          }
        : undefined,
    effect: (factory: () => () => void) => {
      effects.push(factory());
    },
  };
  return { context, sections, disposals, effects };
}

describe("workspacePromptRefreshMs", () => {
  it("defaults, clamps, and supports disabling", () => {
    expect(workspacePromptRefreshMs({})).toBe(DEFAULT_WORKSPACE_PROMPT_REFRESH_MS);
    expect(workspacePromptRefreshMs({ DIRECTOR_WORKSPACE_REFRESH_MS: "1" })).toBe(5_000);
    expect(workspacePromptRefreshMs({ DIRECTOR_WORKSPACE_REFRESH_MS: "9999999" })).toBe(600_000);
    expect(workspacePromptRefreshMs({ DIRECTOR_WORKSPACE_REFRESH_MS: "0" })).toBe(0);
    expect(workspacePromptRefreshMs({ DIRECTOR_WORKSPACE_REFRESH_MS: "not-a-number" })).toBe(
      DEFAULT_WORKSPACE_PROMPT_REFRESH_MS,
    );
  });
});

describe("sessionOverrideFromEnv", () => {
  it("trims, bounds, and omits blank overrides", () => {
    expect(sessionOverrideFromEnv({})).toBeUndefined();
    expect(sessionOverrideFromEnv({ DIRECTOR_SESSION_INSTRUCTIONS: "  " })).toBeUndefined();
    expect(sessionOverrideFromEnv({ DIRECTOR_SESSION_INSTRUCTIONS: " 只拍夜景 " })).toBe("只拍夜景");
    expect(sessionOverrideFromEnv({ DIRECTOR_SESSION_INSTRUCTIONS: "x".repeat(9_000) })?.length).toBe(8_000);
  });
});

describe("fetchDirectorWorkspacePrompt", () => {
  it("fetches the merged prompt and forwards the session override", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const target = String(input);
      expect(target).toContain("/api/agent/workspace/prompt");
      expect(target).toContain(encodeURIComponent("只拍夜景"));
      return jsonResponse({ prompt: "## Org workspace\n团队指令", sections: [], merge_order: [] });
    });
    const prompt = await fetchDirectorWorkspacePrompt(
      { gatewayUrl: "http://gateway.test", gatewayToken: GATEWAY_TOKEN, fetchImpl: fetchImpl as typeof fetch },
      { DIRECTOR_SESSION_INSTRUCTIONS: "只拍夜景" },
    );
    expect(prompt).toContain("团队指令");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws on non-200 so callers keep the previous section", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "boom" }, 500));
    await expect(
      fetchDirectorWorkspacePrompt(
        { gatewayUrl: "http://gateway-error.test", gatewayToken: GATEWAY_TOKEN, fetchImpl: fetchImpl as typeof fetch },
        {},
      ),
    ).rejects.toThrow(/HTTP 500/);
  });
});

describe("registerDirectorWorkspacePrompt", () => {
  it("registers the fetched prompt as an ordered system-prompt section", async () => {
    const { context, sections } = fakeContext();
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt: "工作区提示词" }));
    const refresh = registerDirectorWorkspacePrompt(
      context,
      { gatewayUrl: "http://gateway-register.test", gatewayToken: GATEWAY_TOKEN, fetchImpl: fetchImpl as typeof fetch },
      { DIRECTOR_WORKSPACE_REFRESH_MS: "0" },
    );
    await refresh();
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({
      name: DIRECTOR_WORKSPACE_PROMPT_SECTION,
      order: DIRECTOR_WORKSPACE_PROMPT_ORDER,
      text: "工作区提示词",
    });
  });

  it("replaces the section when the DB content changes", async () => {
    const { context, sections, disposals } = fakeContext();
    let prompt = "第一版";
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt }));
    const refresh = registerDirectorWorkspacePrompt(
      context,
      { gatewayUrl: "http://gateway-refresh.test", gatewayToken: GATEWAY_TOKEN, fetchImpl: fetchImpl as typeof fetch },
      { DIRECTOR_WORKSPACE_REFRESH_MS: "0" },
    );
    await refresh();
    prompt = "第二版";
    await refresh();
    expect(sections.map((section) => section.text)).toEqual(["第一版", "第二版"]);
    expect(disposals).toEqual(["第一版"]);

    // Unchanged content re-registers nothing.
    await refresh();
    expect(sections).toHaveLength(2);
  });

  it("registers nothing for an empty workspace and tolerates gateway failures", async () => {
    const { context, sections } = fakeContext();
    const fetchImpl = vi.fn(async () => jsonResponse({ prompt: "" }));
    const refresh = registerDirectorWorkspacePrompt(
      context,
      { gatewayUrl: "http://gateway-empty.test", gatewayToken: GATEWAY_TOKEN, fetchImpl: fetchImpl as typeof fetch },
      { DIRECTOR_WORKSPACE_REFRESH_MS: "0" },
    );
    await refresh();
    expect(sections).toHaveLength(0);

    fetchImpl.mockImplementation(async () => jsonResponse({ error: "down" }, 503));
    await expect(refresh()).resolves.toBeUndefined();
    expect(sections).toHaveLength(0);
  });

  it("is a no-op without a systemPrompt service", async () => {
    const refresh = registerDirectorWorkspacePrompt({}, { gatewayUrl: "http://gateway-none.test" });
    await expect(refresh()).resolves.toBeUndefined();
  });
});
