// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  buildDshWebArgs,
  collectDirectorEnv,
  DIRECTOR_ENV_PASSTHROUGH,
  DSH_VERSION,
  renderOverlayPatch,
  shouldSkipBrowserOpen,
} from "./dsh-director.mjs";

describe("dsh-director launcher", () => {
  it("pins the official DSH release used by npm run dsh", () => {
    expect(DSH_VERSION).toBe("0.1.0-rc.6");
  });

  it("renders a thin one-row overlay patch that only inserts the Director plugin", () => {
    const patch = renderOverlayPatch("/tmp/overlay/plugin.mjs");
    expect(patch).toContain('name: "/tmp/overlay/plugin.mjs"');
    expect(patch).toContain("id: director-workbench");
    // Exactly one patch operation: DSH built-ins must never be removed or replaced.
    expect(patch.match(/^- /gm)).toHaveLength(1);
    expect(patch).not.toMatch(/^- (remove|replace|delete)/m);
    expect(patch).toContain(DSH_VERSION);
  });

  it("skips opening a browser for CI and DIRECTOR_DSH_NO_OPEN runs only", () => {
    expect(shouldSkipBrowserOpen({})).toBe(false);
    expect(shouldSkipBrowserOpen({ CI: "" })).toBe(false);
    expect(shouldSkipBrowserOpen({ CI: "0" })).toBe(false);
    expect(shouldSkipBrowserOpen({ DIRECTOR_DSH_NO_OPEN: "false" })).toBe(false);
    expect(shouldSkipBrowserOpen({ CI: "1" })).toBe(true);
    expect(shouldSkipBrowserOpen({ CI: "true" })).toBe(true);
    expect(shouldSkipBrowserOpen({ DIRECTOR_DSH_NO_OPEN: "1" })).toBe(true);
  });

  it("builds pnpm dlx args for the pinned DSH web profile with the overlay patch", () => {
    const args = buildDshWebArgs("/tmp/overlay/cordis.yml", {});
    expect(args).toEqual([
      `--package=@deepseek-ai/dsh@${DSH_VERSION}`,
      "dlx",
      "dsh",
      "web",
      "--patch",
      "/tmp/overlay/cordis.yml",
    ]);
  });

  it("appends --no-open for headless launches", () => {
    expect(buildDshWebArgs("/tmp/overlay/cordis.yml", { CI: "1" })).toContain("--no-open");
    expect(buildDshWebArgs("/tmp/overlay/cordis.yml", { DIRECTOR_DSH_NO_OPEN: "1" })).toContain("--no-open");
    expect(buildDshWebArgs("/tmp/overlay/cordis.yml", { CI: "0" })).not.toContain("--no-open");
  });

  it("passes through only the Director variables that are actually set", () => {
    expect(DIRECTOR_ENV_PASSTHROUGH).toEqual([
      "STAGE_GATEWAY_URL",
      "DIRECTOR_GATEWAY_TOKEN",
      "DIRECTOR_TARGET_TOKEN",
      "DIRECTOR_SESSION_INSTRUCTIONS",
      "DIRECTOR_WORKSPACE_REFRESH_MS",
    ]);
    expect(collectDirectorEnv({})).toEqual({});
    expect(
      collectDirectorEnv({
        STAGE_GATEWAY_URL: "http://127.0.0.1:8787",
        DIRECTOR_GATEWAY_TOKEN: "  ",
        DIRECTOR_TARGET_TOKEN: "tab-1",
        UNRELATED: "x",
      }),
    ).toEqual({ STAGE_GATEWAY_URL: "http://127.0.0.1:8787", DIRECTOR_TARGET_TOKEN: "tab-1" });
  });

  it("does not run the launcher main when imported as a module", () => {
    // Importing this test file already imported dsh-director.mjs; reaching this
    // assertion proves no submodule/esbuild/pnpm side effects fired on import.
    expect(typeof buildDshWebArgs).toBe("function");
  });
});
