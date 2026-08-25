// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  reportPlannerFailure,
  reportPlannerInvalidOutput,
  reportPlannerOutputLimit,
  safePlannerFailureSummary,
} from "../../plannerFailure";

describe("planner failure reporting", () => {
  it("never reflects an unknown raw stderr line into the public HTTP summary", () => {
    const raw = "fatal: /Users/alice/private/project failed; token=super-secret browser_token=master-capability";

    const summary = safePlannerFailureSummary(raw, "claude");

    expect(summary).toBe("Claude 规划进程失败，请查看网关内部日志");
    expect(summary).not.toContain("/Users/alice");
    expect(summary).not.toContain("super-secret");
  });

  it("logs a bounded, redacted diagnostic with a correlation id", () => {
    const logger = vi.fn();
    const raw = `${"x".repeat(20_000)}\nAuthorization: Bearer upstream-secret\npreview_token=url-secret`;

    const report = reportPlannerFailure(raw, "codex", logger);
    const internal = String(logger.mock.calls[0]?.[0]);

    expect(report.publicMessage).toContain(report.incidentId);
    expect(report.publicMessage).not.toContain("upstream-secret");
    expect(internal).toContain(report.incidentId);
    expect(internal).toContain("truncated");
    expect(internal).not.toContain("upstream-secret");
    expect(internal).not.toContain("url-secret");
    expect(Buffer.byteLength(internal, "utf8")).toBeLessThan(9_000);
  });

  it("redacts quoted JSON secrets plus query and header credentials", () => {
    const logger = vi.fn();
    const raw = [
      '{"api_key":"json-api-secret","access_token":"json-access-secret","nested":{"client_secret":"json-client-secret"}}',
      String.raw`model_output={\"access_token\":\"escaped-access-secret\",\"token\":\"escaped-token-secret\"}`,
      "https://planner.invalid/run?token=query-secret&preview_token=preview-secret",
      "X-API-Key: header-secret",
      "Authorization: Bearer bearer-secret",
    ].join("\n");

    reportPlannerFailure(raw, "claude", logger);
    const internal = String(logger.mock.calls[0]?.[0]);

    expect(internal).toContain('"api_key":"[REDACTED]"');
    expect(internal).toContain("token=[REDACTED]");
    for (const secret of [
      "json-api-secret",
      "json-access-secret",
      "json-client-secret",
      "escaped-access-secret",
      "escaped-token-secret",
      "query-secret",
      "preview-secret",
      "header-secret",
      "bearer-secret",
    ]) {
      expect(internal).not.toContain(secret);
    }
  });

  it("redacts prefixed environment keys, passwords, cookies, and Basic credentials", () => {
    const logger = vi.fn();
    const raw = [
      "OPENAI_API_KEY=sk-env-secret",
      "ANTHROPIC_API_KEY=anthropic-env-secret",
      "DIRECTOR_GATEWAY_TOKEN=gateway-env-secret",
      "password=operator-password",
      "Cookie: session=browser-cookie",
      "Authorization=Basic basic-credential",
    ].join("\n");

    reportPlannerFailure(raw, "codex", logger);
    const internal = String(logger.mock.calls[0]?.[0]);

    for (const secret of [
      "sk-env-secret",
      "anthropic-env-secret",
      "gateway-env-secret",
      "operator-password",
      "browser-cookie",
      "basic-credential",
    ]) {
      expect(internal).not.toContain(secret);
    }
    expect(internal).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(internal).toContain("Cookie=[REDACTED]");
    expect(internal).toContain("Authorization=[REDACTED]");
  });

  it("uses fixed incident-bearing messages for decoder and output-limit failures", () => {
    const logger = vi.fn();
    const invalid = reportPlannerInvalidOutput('model_output={"token":"private-model-token", bad}', "claude", logger);
    const outputLimit = reportPlannerOutputLimit("access_token=private-limit-token", "codex", logger);

    expect(invalid.publicMessage).toBe(`Claude 返回的结构化计划无效，请重试（故障编号 ${invalid.incidentId}）`);
    expect(outputLimit.publicMessage).toBe(
      `Codex 规划输出超过安全上限，请缩短请求后重试（故障编号 ${outputLimit.incidentId}）`,
    );
    expect(invalid.publicMessage).not.toContain("private-model-token");
    expect(outputLimit.publicMessage).not.toContain("private-limit-token");
    expect(logger.mock.calls.flat().join("\n")).not.toMatch(/private-(?:model|limit)-token/);
  });

  it("preserves only allowlisted actionable categories", () => {
    expect(safePlannerFailureSummary("Error: not logged in", "codex")).toBe("Codex CLI 尚未登录");
    expect(safePlannerFailureSummary("connection refused by upstream", "claude")).toMatch(/无法连接模型服务/);
    expect(safePlannerFailureSummary("spawn ENOENT", "claude")).toMatch(/未安装/);
  });
});
