// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  CollaborationInviteRateLimiter,
  collaborationInviteRateLimitKeyFromAuthorization,
  parseCollaborationInviteRateLimitPerMinute,
} from "../../collaboration/collaborationInviteRateLimit";

describe("parseCollaborationInviteRateLimitPerMinute", () => {
  it("defaults to disabled and clamps extreme values", () => {
    expect(parseCollaborationInviteRateLimitPerMinute(undefined)).toBe(0);
    expect(parseCollaborationInviteRateLimitPerMinute("")).toBe(0);
    expect(parseCollaborationInviteRateLimitPerMinute("0")).toBe(0);
    expect(parseCollaborationInviteRateLimitPerMinute("-3")).toBe(0);
    expect(parseCollaborationInviteRateLimitPerMinute("not-a-number")).toBe(0);
    expect(parseCollaborationInviteRateLimitPerMinute("30")).toBe(30);
    expect(parseCollaborationInviteRateLimitPerMinute("999999")).toBe(10_000);
  });
});

describe("collaborationInviteRateLimitKeyFromAuthorization", () => {
  it("fingerprints bearer tokens without echoing the secret", () => {
    expect(collaborationInviteRateLimitKeyFromAuthorization(undefined)).toBe("anonymous");
    expect(collaborationInviteRateLimitKeyFromAuthorization("")).toBe("anonymous");
    const first = collaborationInviteRateLimitKeyFromAuthorization("Bearer secret-a");
    const again = collaborationInviteRateLimitKeyFromAuthorization("Bearer secret-a");
    const other = collaborationInviteRateLimitKeyFromAuthorization("Bearer secret-b");
    expect(first).toBe(again);
    expect(first).toMatch(/^auth:[0-9a-f]+$/);
    expect(first).not.toEqual(other);
    expect(first).not.toContain("secret");
  });
});

describe("CollaborationInviteRateLimiter", () => {
  it("stays disabled when the configured limit is zero", () => {
    const limiter = new CollaborationInviteRateLimiter(0);
    expect(limiter.enabled).toBe(false);
    expect(limiter.check("auth:a")).toEqual({ allowed: true });
  });

  it("rejects after the sliding-window budget is exhausted and reports Retry-After", () => {
    let now = 1_000_000;
    const limiter = new CollaborationInviteRateLimiter(2, () => now);
    expect(limiter.check("auth:a")).toEqual({ allowed: true });
    expect(limiter.check("auth:a")).toEqual({ allowed: true });
    expect(limiter.check("auth:a")).toEqual({
      allowed: false,
      retryAfterSeconds: 60,
      limitPerMinute: 2,
    });
    // A different caller keeps its own budget.
    expect(limiter.check("auth:b")).toEqual({ allowed: true });
    // After the oldest stamp exits the window the budget reopens.
    now += 60_001;
    expect(limiter.check("auth:a")).toEqual({ allowed: true });
  });
});
