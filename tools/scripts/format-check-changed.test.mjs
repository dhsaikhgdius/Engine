// @vitest-environment node
import { describe, expect, it } from "vitest";
import { pathIsInFormatCheckGlob, resolveFormatCheckBase } from "./format-check-changed.mjs";

describe("pathIsInFormatCheckGlob", () => {
  it("matches the same trees as npm run format:check", () => {
    expect(pathIsInFormatCheckGlob("backend/gateway/agents/httpToolPolicy.ts")).toBe(true);
    expect(pathIsInFormatCheckGlob("frontend/director/src/comprehensive/editor/store/directorStore.ts")).toBe(true);
    expect(pathIsInFormatCheckGlob("packages/protocol/src/productionArtifactProtocol.ts")).toBe(true);
    expect(pathIsInFormatCheckGlob("package.json")).toBe(true);
    expect(pathIsInFormatCheckGlob("tools/vitest.config.ts")).toBe(true);
    expect(pathIsInFormatCheckGlob("tools/e2e/smoke.spec.ts")).toBe(true);
  });

  it("excludes docs, nested tools scripts, and workflow YAML", () => {
    expect(pathIsInFormatCheckGlob("docs/site/src/content/docs/reference/feature-status.md")).toBe(false);
    expect(pathIsInFormatCheckGlob("tools/scripts/format-check-changed.mjs")).toBe(false);
    expect(pathIsInFormatCheckGlob(".github/workflows/ci.yml")).toBe(false);
    expect(pathIsInFormatCheckGlob("packages/project-schema/src/directorProjectSchema.ts")).toBe(false);
  });
});

describe("resolveFormatCheckBase", () => {
  it("prefers FORMAT_CHECK_BASE, then GITHUB_BASE_REF, then origin/main", () => {
    expect(resolveFormatCheckBase({ FORMAT_CHECK_BASE: "origin/release" })).toBe("origin/release");
    expect(resolveFormatCheckBase({ GITHUB_BASE_REF: "main" })).toBe("origin/main");
    expect(resolveFormatCheckBase({})).toBe("origin/main");
  });
});
