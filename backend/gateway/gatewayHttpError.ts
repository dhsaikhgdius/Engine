import { randomUUID } from "node:crypto";
import { BoundedTextBuffer } from "./boundedTextBuffer";
import { redactSensitiveText } from "./redaction";

const INTERNAL_DIAGNOSTIC_MAX_BYTES = 8 * 1024;

export type InternalGatewayLogger = (message: string) => void;

/**
 * Stable public message for unexpected HTTP failures. Never echoes raw
 * `error.message` (paths, provider payloads, subprocess stderr).
 */
export const GATEWAY_INTERNAL_FAILURE_PUBLIC_MESSAGE = "网关内部错误，请查看网关内部日志";

/**
 * Records a bounded, redacted diagnostic and returns a correlation id plus a
 * stable public error payload for HTTP 500 responses.
 */
export function reportGatewayInternalFailure(
  error: unknown,
  logger: InternalGatewayLogger = console.error,
): { incidentId: string; publicMessage: string; code: "internal_error" } {
  const incidentId = randomUUID();
  const raw =
    error instanceof Error
      ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
      : String(error);
  const diagnostic = new BoundedTextBuffer(
    INTERNAL_DIAGNOSTIC_MAX_BYTES,
    "[... gateway diagnostic truncated; showing tail ...]\n",
  );
  diagnostic.append(redactSensitiveText(raw));
  logger(`[director-gateway-internal-error id=${incidentId}]\n${diagnostic.toString()}`);
  return {
    incidentId,
    publicMessage: `${GATEWAY_INTERNAL_FAILURE_PUBLIC_MESSAGE}（故障编号 ${incidentId}）`,
    code: "internal_error",
  };
}
