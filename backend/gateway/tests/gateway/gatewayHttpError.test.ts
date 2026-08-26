import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_INTERNAL_FAILURE_PUBLIC_MESSAGE,
  reportGatewayInternalFailure,
} from "../../gatewayHttpError";

describe("reportGatewayInternalFailure", () => {
  it("returns a stable public message with a correlation id and never echoes raw paths", () => {
    const logs: string[] = [];
    const reported = reportGatewayInternalFailure(
      new Error("ENOENT: no such file or directory, open '/home/secret/stage-scene.json' api_key=sk-live-secret"),
      (message) => logs.push(message),
    );

    expect(reported.code).toBe("internal_error");
    expect(reported.incidentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(reported.publicMessage).toContain(GATEWAY_INTERNAL_FAILURE_PUBLIC_MESSAGE);
    expect(reported.publicMessage).toContain(reported.incidentId);
    expect(reported.publicMessage).not.toContain("/home/secret");
    expect(reported.publicMessage).not.toContain("sk-live-secret");

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(`id=${reported.incidentId}`);
    expect(logs[0]).toContain("[REDACTED]");
    expect(logs[0]).not.toContain("sk-live-secret");
  });

  it("accepts non-Error throwables", () => {
    const logger = vi.fn();
    const reported = reportGatewayInternalFailure("boom-token=super-secret", logger);
    expect(reported.publicMessage).toContain(GATEWAY_INTERNAL_FAILURE_PUBLIC_MESSAGE);
    expect(logger).toHaveBeenCalledOnce();
  });
});
