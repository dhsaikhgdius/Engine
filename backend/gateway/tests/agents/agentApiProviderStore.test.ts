import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AgentApiProviderStore,
  expandAgentApiProvidersToHostedProfiles,
  hostedProfileIdForModel,
  mergeHostedAgentProfiles,
} from "../../agents/agentApiProviderStore";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "director-agent-api-"));
  tempDirs.push(directory);
  const instance = new AgentApiProviderStore(directory);
  await instance.load();
  return { directory, instance };
}

describe("AgentApiProviderStore", () => {
  it("persists providers, redacts secrets in public snapshots, and keeps blank keys", async () => {
    const { directory, instance } = await store();
    const saved = await instance.replace([
      {
        id: "openai",
        label: "OpenAI",
        driver: "openai",
        baseUrl: "https://api.openai.com/v1/",
        apiKey: "sk-never-public",
        models: ["gpt-4.1", "gpt-4o"],
      },
    ]);

    expect(saved).toEqual([
      expect.objectContaining({
        id: "openai",
        baseUrl: "https://api.openai.com/v1",
        credentialConfigured: true,
        models: [
          { profileId: "openai.gpt-4.1", model: "gpt-4.1" },
          { profileId: "openai.gpt-4o", model: "gpt-4o" },
        ],
      }),
    ]);
    expect(JSON.stringify(saved)).not.toContain("sk-never-public");

    const raw = await readFile(instance.path, "utf8");
    expect(raw).toContain("sk-never-public");
    expect((await stat(instance.path)).mode & 0o777).toBe(0o600);

    const reloaded = new AgentApiProviderStore(directory);
    await reloaded.load();
    const kept = await reloaded.replace([
      {
        id: "openai",
        label: "OpenAI",
        driver: "openai",
        baseUrl: "https://api.openai.com/v1",
        models: ["gpt-4.1"],
      },
    ]);
    expect(kept[0]?.credentialConfigured).toBe(true);
    expect(reloaded.getApiKey("openai")).toBe("sk-never-public");
  });

  it("rejects reserved and duplicate provider ids", async () => {
    const { instance } = await store();
    await expect(
      instance.replace([
        {
          id: "api-default",
          label: "Nope",
          driver: "openai-compatible",
          baseUrl: "http://127.0.0.1:8080/v1",
          models: ["local"],
        },
      ]),
    ).rejects.toThrow(/reserved/);
  });

  it("starts empty when the file is missing", async () => {
    const { instance } = await store();
    expect(instance.list()).toEqual([]);
  });

  it("throws when the on-disk document is corrupt", async () => {
    const { instance } = await store();
    await writeFile(instance.path, "{not-json", "utf8");
    await expect(instance.load()).rejects.toThrow(/not valid JSON/);
  });
});

describe("hosted profile expansion", () => {
  it("sanitizes model ids that contain slashes and overlays user profiles", () => {
    const used = new Set<string>();
    expect(hostedProfileIdForModel("openrouter", "deepseek-ai/DeepSeek-V3", used)).toBe(
      "openrouter.deepseek-ai-DeepSeek-V3",
    );

    const expanded = expandAgentApiProvidersToHostedProfiles([
      {
        id: "openai",
        label: "OpenAI",
        driver: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "sk-user",
        models: ["gpt-4.1"],
      },
    ]);
    expect(expanded).toEqual([
      expect.objectContaining({
        id: "openai.gpt-4.1",
        model: "gpt-4.1",
        apiKey: "sk-user",
        runtime: "native-openai",
      }),
    ]);

    const merged = mergeHostedAgentProfiles(
      [{ ...expanded[0]!, id: "openai.gpt-4.1", apiKey: "sk-env", model: "gpt-env" }],
      expanded,
    );
    expect(merged[0]?.apiKey).toBe("sk-user");
    expect(merged[0]?.model).toBe("gpt-4.1");
  });

  it("projects exact capabilities for known models saved in Agent settings", () => {
    const [profile] = expandAgentApiProvidersToHostedProfiles([
      {
        id: "deepseek",
        label: "DeepSeek",
        driver: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "test-key",
        models: ["deepseek-reasoner"],
      },
    ]);

    expect(profile?.capabilities).toMatchObject({
      tools: false,
      vision: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    });
  });
});
