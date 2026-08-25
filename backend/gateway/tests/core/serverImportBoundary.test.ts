// @vitest-environment node

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkServerImportBoundaries,
  inspectServerSourceImports,
  TEMPORARY_SERVER_IMPORT_EXCEPTIONS,
} from "../../../../tools/scripts/checkServerImportBoundaries";

const WORKSPACE_ROOT = resolve(import.meta.dirname, "../../../..");

describe("server import boundary", () => {
  it("keeps the complete server tree out of browser runtime modules", async () => {
    const result = await checkServerImportBoundaries(WORKSPACE_ROOT);
    expect(result.auditedFileCount).toBeGreaterThan(50);
    expect(result.violations).toEqual([]);
  });

  it("rejects UI packages, browser stores, unapproved src runtime modules, and non-protocol workspace packages", () => {
    const source = [
      'import React from "react";',
      'import { create } from "zustand";',
      'import { useDirectorStore } from "../../frontend/director/src/comprehensive/editor/store/directorStore";',
      'import { BrowserPanel } from "../../frontend/director/src/comprehensive/editor/panels/BrowserPanel";',
      'import { unreviewed } from "../../frontend/director/src/agent/unreviewedRuntime";',
      'import { pluginRuntime } from "../../packages/agent-plugin/runtime";',
    ].join("\n");
    const violations = inspectServerSourceImports(
      source,
      resolve(WORKSPACE_ROOT, "backend/gateway/example.ts"),
      WORKSPACE_ROOT,
    );

    expect(violations.map((violation) => violation.specifier)).toEqual([
      "react",
      "zustand",
      "../../frontend/director/src/comprehensive/editor/store/directorStore",
      "../../frontend/director/src/comprehensive/editor/panels/BrowserPanel",
      "../../frontend/director/src/agent/unreviewedRuntime",
      "../../packages/agent-plugin/runtime",
    ]);
  });

  it("allows transport contracts and reviewed pure schema modules", () => {
    const source = [
      'import { videoModelOperationSchema } from "../../packages/protocol/src/videoGenerationProtocol";',
      'import type { AgentSession } from "@director/agent-engine";',
      'import { safeParseDirectorProject } from "@director/project-schema";',
      'import type { StageScene } from "@director/stage-protocol";',
      'export { directorDccOperationSchema } from "@director/dcc-protocol";',
      'export { directorBlendSceneManifestSchema } from "@director/dcc-protocol";',
    ].join("\n");

    expect(
      inspectServerSourceImports(source, resolve(WORKSPACE_ROOT, "backend/gateway/example.ts"), WORKSPACE_ROOT),
    ).toEqual([]);
  });

  it("rejects leftover frontend Agent imports now that the control plane uses workspace packages", () => {
    expect(TEMPORARY_SERVER_IMPORT_EXCEPTIONS).toEqual([]);
    const source = 'import { executeStageTool } from "../../frontend/director/src/agent/commandEngine";';
    expect(
      inspectServerSourceImports(source, resolve(WORKSPACE_ROOT, "backend/gateway/agent-gateway.ts"), WORKSPACE_ROOT),
    ).toEqual([
      expect.objectContaining({
        importer: "backend/gateway/agent-gateway.ts",
        target: "frontend/director/src/agent/commandEngine",
      }),
    ]);
  });
});
