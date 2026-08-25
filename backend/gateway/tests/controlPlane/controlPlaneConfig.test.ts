import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadDirectorControlPlaneConfig,
  parseAgentRoleProfileMap,
  publicControlPlaneCapabilities,
  resolveDefaultArdyRepo,
  resolveDefaultLtx2Source,
} from "../../controlPlane/controlPlaneConfig";

describe("Director control-plane configuration", () => {
  it("allows an isolated state directory for tests and managed deployments", () => {
    expect(
      loadDirectorControlPlaneConfig("/tmp/director", { DIRECTOR_DATA_DIRECTORY: "runtime/state" }).dataDirectory,
    ).toBe("/tmp/director/runtime/state");
    expect(loadDirectorControlPlaneConfig("/tmp/director", {}).dataDirectory).toBe("/tmp/director/data");
  });

  it("selects LTX-2.3 when official source and weights are present without leaking secrets", () => {
    const checkout = mkdtempSync(join(tmpdir(), "director-ltx2-checkout-"));
    const weights = mkdtempSync(join(tmpdir(), "director-ltx2-weights-"));
    try {
      mkdirSync(join(checkout, "packages", "ltx-pipelines", "src", "ltx_pipelines"), { recursive: true });
      const distilled = join(weights, "distilled.safetensors");
      const upsampler = join(weights, "upsampler.safetensors");
      writeFileSync(distilled, "fake");
      writeFileSync(upsampler, "fake");
      mkdirSync(join(weights, "gemma"));
      const config = loadDirectorControlPlaneConfig("/tmp/director", {
        DIRECTOR_ACCEPT_LTX2_LICENSE: "1",
        DIRECTOR_LTX2_SOURCE_DIR: checkout,
        LTX23_DISTILLED_CHECKPOINT_PATH: distilled,
        LTX23_SPATIAL_UPSAMPLER_PATH: upsampler,
        LTX23_GEMMA_ROOT: join(weights, "gemma"),
        DIRECTOR_AGENT_API_BASE_URL: "https://api.example.test/v1/",
        DIRECTOR_AGENT_API_KEY: "agent-secret",
        DIRECTOR_AGENT_API_MODEL: "director-model",
      });
      expect(config.video.defaultProvider).toBe("ltx-2.3");
      expect(config.video.ltx23.sourceRoot).toBe(checkout);
      expect(config.agents.api.baseUrl).toBe("https://api.example.test/v1");

      const publicValue = JSON.stringify(publicControlPlaneCapabilities(config));
      expect(publicValue).not.toContain("agent-secret");
      expect(publicValue).not.toContain(distilled);
      expect(publicValue).toContain("director-model");
    } finally {
      rmSync(checkout, { recursive: true, force: true });
      rmSync(weights, { recursive: true, force: true });
    }
  });

  it("refuses accidental network exposure", () => {
    expect(() => loadDirectorControlPlaneConfig("/tmp/director", { STAGE_GATEWAY_HOST: "0.0.0.0" })).toThrow(
      /non-loopback/,
    );
  });

  it("configures adaptive long-media transcription without exposing the local FFmpeg path", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_TRANSCRIPTION_BASE_URL: "http://127.0.0.1:9000/v1",
      DIRECTOR_TRANSCRIPTION_CHUNK_THRESHOLD_SECONDS: "1200",
      DIRECTOR_TRANSCRIPTION_CHUNK_SECONDS: "480",
      DIRECTOR_TRANSCRIPTION_CHUNK_CONCURRENCY: "3",
      DIRECTOR_FFMPEG_PATH: "/opt/media/ffmpeg",
    });

    expect(config.transcription).toMatchObject({
      chunkThresholdSec: 1_200,
      chunkDurationSec: 480,
      chunkConcurrency: 3,
      ffmpegPath: "/opt/media/ffmpeg",
    });
    const publicValue = publicControlPlaneCapabilities(config).transcription;
    expect(publicValue).toMatchObject({
      supportsLongMedia: true,
      longMediaStrategy: "adaptive-chunking",
      chunkThresholdSec: 1_200,
      chunkDurationSec: 480,
      chunkConcurrency: 3,
    });
    expect(JSON.stringify(publicValue)).not.toContain("/opt/media/ffmpeg");
  });

  it("loads strict role-to-profile overrides while preserving an empty fallback map", () => {
    expect(loadDirectorControlPlaneConfig("/tmp/director", {}).agents.roleProfiles).toEqual({});

    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_AGENT_ROLE_PROFILES_JSON: JSON.stringify({
        showrunner: "openai-director",
        cinematographer: "openai-director",
        "visual-critic": "claude-critic",
        "stage-director": "  stage-author  ",
      }),
    });

    expect(config.agents.roleProfiles).toEqual({
      showrunner: "openai-director",
      cinematographer: "openai-director",
      "visual-critic": "claude-critic",
      "stage-director": "stage-author",
    });
  });

  it("leaves profile existence and availability validation to the runtime registry", () => {
    expect(
      parseAgentRoleProfileMap(
        JSON.stringify({
          "stage-director": "not-configured-yet",
          cinematographer: "not-configured-yet",
        }),
      ),
    ).toEqual({
      "stage-director": "not-configured-yet",
      cinematographer: "not-configured-yet",
    });
  });

  it("rejects malformed role routing, unknown roles, empty profile ids, and non-object input", () => {
    expect(() => parseAgentRoleProfileMap("{")).toThrow(/not valid JSON/);
    expect(() => parseAgentRoleProfileMap(JSON.stringify({ director: "openai-director" }))).toThrow(
      /Unrecognized key.*director/s,
    );
    expect(() => parseAgentRoleProfileMap(JSON.stringify({ showrunner: "   " }))).toThrow(/Too small/);
    expect(() => parseAgentRoleProfileMap(JSON.stringify({ showrunner: null }))).toThrow(/expected string/i);
    expect(() => parseAgentRoleProfileMap(JSON.stringify([]))).toThrow(/expected object/i);
  });

  it("loads strict multi-provider profiles and resolves credentials only on the server", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      OPENAI_API_KEY: "openai-secret",
      DIRECTOR_CLAUDE_SECRET: "anthropic-secret",
      DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
        {
          id: "openai-director",
          label: "OpenAI Director",
          driver: "openai",
          model: "gpt-director",
          maxToolRounds: 20,
          capabilities: { maxContextTokens: 200_000 },
        },
        {
          id: "claude-critic",
          label: "Claude Critic",
          driver: "anthropic",
          baseUrl: "https://anthropic.example/v1/",
          model: "claude-critic",
          apiKeyEnv: "DIRECTOR_CLAUDE_SECRET",
          capabilities: { jsonSchema: true, maxOutputTokens: 16_384 },
        },
        {
          id: "local-planner",
          label: "Local Planner",
          driver: "openai-compatible",
          baseUrl: "http://127.0.0.1:9000/v1/",
          model: "local-model",
        },
      ]),
    });

    expect(config.agents.profiles).toEqual([
      expect.objectContaining({
        id: "openai-director",
        runtime: "native-openai",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "openai-secret",
        apiKeyEnv: "OPENAI_API_KEY",
        maxToolRounds: 20,
        capabilities: expect.objectContaining({ vision: true, jsonSchema: true, maxContextTokens: 200_000 }),
      }),
      expect.objectContaining({
        id: "claude-critic",
        runtime: "native-anthropic",
        baseUrl: "https://anthropic.example/v1",
        apiKey: "anthropic-secret",
        apiKeyEnv: "DIRECTOR_CLAUDE_SECRET",
        capabilities: expect.objectContaining({ vision: true, jsonSchema: true, maxOutputTokens: 16_384 }),
      }),
      expect.objectContaining({
        id: "local-planner",
        runtime: "native-openai-compatible",
        baseUrl: "http://127.0.0.1:9000/v1",
        apiKey: undefined,
      }),
    ]);

    const publicValue = JSON.stringify(publicControlPlaneCapabilities(config));
    expect(publicValue).not.toContain("openai-secret");
    expect(publicValue).not.toContain("anthropic-secret");
    expect(publicValue).not.toContain("DIRECTOR_CLAUDE_SECRET");
    expect(publicValue).not.toContain("api.openai.com/v1");
    expect(publicValue).toContain("api.openai.com");
  });

  it("projects known model capabilities and applies explicit overrides last", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      OPENAI_API_KEY: "openai-secret",
      DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
        {
          id: "openai-known",
          label: "OpenAI Known",
          driver: "openai",
          model: "gpt-4o",
          capabilities: { vision: false, maxOutputTokens: 12_000 },
        },
        {
          id: "private-model",
          label: "Private Model",
          driver: "openai-compatible",
          baseUrl: "http://127.0.0.1:9000/v1",
          model: "private-model",
        },
      ]),
    });

    expect(config.agents.profiles[0]?.capabilities).toEqual({
      streaming: true,
      tools: true,
      parallelToolCalls: true,
      vision: false,
      jsonSchema: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 12_000,
    });
    expect(config.agents.profiles[1]?.capabilities).toEqual({
      streaming: true,
      tools: true,
      parallelToolCalls: false,
      vision: false,
      jsonSchema: false,
      maxContextTokens: null,
      maxOutputTokens: null,
    });
  });

  it("rejects malformed, duplicate, reserved, and structurally loose profiles", () => {
    expect(() => loadDirectorControlPlaneConfig("/tmp/director", { DIRECTOR_AGENT_PROFILES_JSON: "{" })).toThrow(
      /not valid JSON/,
    );
    expect(() =>
      loadDirectorControlPlaneConfig("/tmp/director", {
        DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
          { id: "same", label: "One", driver: "openai", model: "one" },
          { id: "same", label: "Two", driver: "anthropic", model: "two" },
        ]),
      }),
    ).toThrow(/duplicate profile id same/);
    expect(() =>
      loadDirectorControlPlaneConfig("/tmp/director", {
        DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
          { id: "codex-local", label: "Collision", driver: "openai", model: "one" },
        ]),
      }),
    ).toThrow(/reserved/);
    expect(() =>
      loadDirectorControlPlaneConfig("/tmp/director", {
        DIRECTOR_AGENT_PROFILES_JSON: JSON.stringify([
          { id: "loose", label: "Loose", driver: "openai", model: "one", rawApiKey: "forbidden" },
        ]),
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("prefers DIRECTOR_ARDY_REPO and never uses the local submodule as an SSH path", () => {
    const config = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_ARDY_REPO: "/remote/ardy",
      DIRECTOR_ARDY_SSH_HOST: "gpu@ardy-box",
    });
    expect(config.motion.ardy.repo).toBe("/remote/ardy");
    expect(config.motion.ardy.sshHost).toBe("gpu@ardy-box");

    const sshOnly = loadDirectorControlPlaneConfig("/tmp/director", {
      DIRECTOR_ARDY_SSH_HOST: "gpu@ardy-box",
    });
    expect(sshOnly.motion.ardy.repo).toBeUndefined();
    expect(resolveDefaultArdyRepo({ sshHost: "gpu@ardy-box", checkout: "/opt/ardy" })).toBeUndefined();
  });

  it("discovers a local ARDY submodule when generate.py is present", () => {
    const checkout = mkdtempSync(join(tmpdir(), "director-ardy-checkout-"));
    try {
      mkdirSync(join(checkout, "scripts"));
      writeFileSync(join(checkout, "scripts", "generate.py"), "print('fixture')\n");
      expect(resolveDefaultArdyRepo({ checkout })).toBe(checkout);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });

  it("discovers a local LTX-2 submodule when the official pipelines package is present", () => {
    const checkout = mkdtempSync(join(tmpdir(), "director-ltx2-source-"));
    try {
      mkdirSync(join(checkout, "packages", "ltx-pipelines", "src", "ltx_pipelines"), { recursive: true });
      expect(resolveDefaultLtx2Source({ checkout })).toBe(checkout);
    } finally {
      rmSync(checkout, { recursive: true, force: true });
    }
  });
});
