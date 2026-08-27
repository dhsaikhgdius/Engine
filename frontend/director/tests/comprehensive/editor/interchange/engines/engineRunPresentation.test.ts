/**
 * Presentation tests for typed `engine_run_*` error-code honesty: every
 * contract code carries a zh-CN label, and thrown client errors keep their
 * machine code beside the free-text message.
 */

import { describe, expect, it } from "vitest";
import { DirectorDccEngineRunClientError } from "../../../../../src/comprehensive/editor/api/dccEngineRunClient";
import {
  ENGINE_RUN_ERROR_CODE_LABELS,
  engineRunErrorCodeLabel,
  engineRunErrorView,
} from "../../../../../src/comprehensive/editor/interchange/engines/engineRunPresentation";
import { directorDccEngineRunErrorCodeSchema } from "../../../../../src/dcc/directorDccEngineRunContract";

describe("engineRunErrorCodeLabel", () => {
  it("labels every typed engine_run_* code in the contract enum", () => {
    for (const code of directorDccEngineRunErrorCodeSchema.options) {
      expect(ENGINE_RUN_ERROR_CODE_LABELS[code].trim().length).toBeGreaterThan(0);
      expect(engineRunErrorCodeLabel(code)).toBe(ENGINE_RUN_ERROR_CODE_LABELS[code]);
    }
  });

  it("keeps the typed record exactly the contract enum while labeling transport codes", () => {
    expect(Object.keys(ENGINE_RUN_ERROR_CODE_LABELS).sort()).toEqual(
      [...directorDccEngineRunErrorCodeSchema.options].sort(),
    );
    expect(engineRunErrorCodeLabel("engine_run_unavailable")).toBe("运行管理器未配置");
    expect(engineRunErrorCodeLabel("invalid_response")).toBe("网关响应不符合契约");
  });

  it("returns null for unknown codes instead of inventing a label", () => {
    expect(engineRunErrorCodeLabel("engine_run_brand_new")).toBeNull();
    expect(engineRunErrorCodeLabel("")).toBeNull();
  });
});

describe("engineRunErrorView", () => {
  it("keeps the typed code, its label, and recovery beside the free-text message", () => {
    const view = engineRunErrorView(
      new DirectorDccEngineRunClientError(
        "unity project runs are not supported yet.",
        501,
        "engine_run_unsupported",
        ["Run the project inside the engine editor after launch_engine_editor."],
      ),
      "引擎项目运行启动失败",
    );
    expect(view).toEqual({
      code: "engine_run_unsupported",
      codeLabel: "该引擎不支持项目运行",
      message: "unity project runs are not supported yet.",
      recovery: ["Run the project inside the engine editor after launch_engine_editor."],
    });
  });

  it("keeps an out-of-vocabulary code visible with a null label", () => {
    const view = engineRunErrorView(
      new DirectorDccEngineRunClientError("odd rejection", 500, "engine_run_brand_new"),
      "引擎项目运行启动失败",
    );
    expect(view.code).toBe("engine_run_brand_new");
    expect(view.codeLabel).toBeNull();
    expect(view.message).toBe("odd rejection");
  });

  it("never invents a code for plain errors or non-error throws", () => {
    expect(engineRunErrorView(new Error("boom"), "引擎编辑器启动失败")).toEqual({
      code: null,
      codeLabel: null,
      message: "boom",
      recovery: [],
    });
    expect(engineRunErrorView("not-an-error", "引擎编辑器启动失败")).toEqual({
      code: null,
      codeLabel: null,
      message: "引擎编辑器启动失败",
      recovery: [],
    });
  });
});
