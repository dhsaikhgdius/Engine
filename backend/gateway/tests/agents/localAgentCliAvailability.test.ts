import { describe, expect, it } from "vitest";
import { commandAvailable, probeLocalAgentCliAvailability } from "../../agents/localAgentCliAvailability";

function spawnFor(success: ReadonlySet<string>) {
  return (command: string) => ({ status: success.has(command) ? 0 : 1 });
}

describe("probeLocalAgentCliAvailability", () => {
  it("treats hosted api as always available", () => {
    expect(probeLocalAgentCliAvailability({}, spawnFor(new Set())).api).toBe(true);
  });

  it("marks Codex/Claude available only when --version succeeds", () => {
    const spawn = spawnFor(new Set(["codex", "present-cli"]));
    expect(commandAvailable("codex", spawn)).toBe(true);
    expect(commandAvailable("claude", spawn)).toBe(false);
    expect(
      probeLocalAgentCliAvailability(
        { CODEX_CLI_COMMAND: "present-cli", CLAUDE_CLI_COMMAND: "missing-cli" },
        spawn,
      ),
    ).toEqual({
      api: true,
      codex: true,
      claude: false,
    });
  });
});
