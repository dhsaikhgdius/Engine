import { describe, expect, it } from "vitest";
import { friendlyErrorMessage, friendlyHttpStatusMessage, GATEWAY_UNREACHABLE_MESSAGE } from "../../../../src/comprehensive/editor/api/friendlyError";

describe("friendlyErrorMessage", () => {
  it("maps browser fetch/network failures to the gateway hint", () => {
    expect(friendlyErrorMessage(new TypeError("Failed to fetch"))).toBe(GATEWAY_UNREACHABLE_MESSAGE);
    expect(friendlyErrorMessage(new TypeError("fetch failed"))).toBe(GATEWAY_UNREACHABLE_MESSAGE);
    expect(friendlyErrorMessage(new TypeError("NetworkError when attempting to fetch resource."))).toBe(
      GATEWAY_UNREACHABLE_MESSAGE,
    );
    expect(friendlyErrorMessage(new Error("connect ECONNREFUSED 127.0.0.1:4477"))).toBe(GATEWAY_UNREACHABLE_MESSAGE);
    expect(friendlyErrorMessage(new TypeError("Load failed"))).toBe(GATEWAY_UNREACHABLE_MESSAGE);
  });

  it("maps HTTP status codes embedded in machine messages", () => {
    expect(friendlyErrorMessage(new Error("Request failed (500)"))).toBe("网关内部错误（HTTP 500），请查看网关日志");
    expect(friendlyErrorMessage(new Error("Request failed (404)"))).toBe(
      "请求的接口不存在（HTTP 404），请确认网关版本是否匹配",
    );
    expect(friendlyErrorMessage(new Error("HTTP 403"))).toBe("网关拒绝了请求（HTTP 403），请检查访问令牌或权限");
    expect(friendlyErrorMessage(new Error("Request failed (429)"))).toBe("请求过于频繁（HTTP 429），请稍后重试");
    expect(friendlyErrorMessage(new Error("Request failed (400)"))).toBe("请求被网关拒绝（HTTP 400），请检查提交内容");
  });

  it("maps timeouts and aborts", () => {
    expect(friendlyErrorMessage(new Error("The request timed out"))).toBe("请求超时，请稍后重试");
    expect(friendlyErrorMessage(new Error("ETIMEDOUT"))).toBe("请求超时，请稍后重试");
    expect(friendlyErrorMessage(new DOMException("Aborted", "AbortError"))).toBe("请求已取消");
    expect(friendlyErrorMessage(new DOMException("Timed out", "TimeoutError"))).toBe("请求超时，请稍后重试");
  });

  it("keeps intentional Chinese copy untouched", () => {
    expect(friendlyErrorMessage(new Error("媒体超过转录大小限制 (25 MB)"))).toBe("媒体超过转录大小限制 (25 MB)");
    expect(friendlyErrorMessage("参考素材必须是图片")).toBe("参考素材必须是图片");
  });

  it("prefixes unrecognized machine messages instead of hiding them", () => {
    expect(friendlyErrorMessage(new Error("Unexpected token < in JSON"))).toBe(
      "请求失败：Unexpected token < in JSON",
    );
    expect(friendlyErrorMessage("boom")).toBe("请求失败：boom");
  });

  it("falls back for empty or non-error values", () => {
    expect(friendlyErrorMessage(new Error(""))).toBe("发生未知错误");
    expect(friendlyErrorMessage(undefined)).toBe("发生未知错误");
    expect(friendlyErrorMessage(null)).toBe("发生未知错误");
  });
});

describe("friendlyHttpStatusMessage", () => {
  it("describes each status family", () => {
    expect(friendlyHttpStatusMessage(401)).toContain("HTTP 401");
    expect(friendlyHttpStatusMessage(504)).toBe("网关请求超时（HTTP 504），请稍后重试");
    expect(friendlyHttpStatusMessage(503)).toBe("网关内部错误（HTTP 503），请查看网关日志");
    expect(friendlyHttpStatusMessage(418)).toBe("请求被网关拒绝（HTTP 418），请检查提交内容");
  });
});
