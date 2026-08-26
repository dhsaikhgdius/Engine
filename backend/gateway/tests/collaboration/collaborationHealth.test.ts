// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildCollaborationHealthStanza } from "../../collaboration/collaborationHealth";

describe("buildCollaborationHealthStanza", () => {
  it("reports policy flags, transport limits, and active vs retained room counts without room ids", () => {
    const stanza = buildCollaborationHealthStanza({
      mode: "invite-required",
      persistence: true,
      emptyRoomTtlSeconds: 120,
      inviteRateLimitPerMinute: 30,
      liveRooms: [{ retained: false }, { retained: false }, { retained: true }],
    });
    expect(stanza).toEqual({
      mode: "invite-required",
      persistence: true,
      empty_room_ttl_seconds: 120,
      invite_rate_limit_per_minute: 30,
      active_rooms: 2,
      retained_rooms: 1,
      transport: {
        loopback_binding: true,
        tls_termination: false,
        multi_node: false,
        member_identity: "invite-capability",
      },
    });
    // Redaction: counts and policy only — no room ids or filesystem paths.
    expect(JSON.stringify(stanza)).not.toContain("scene/");
    expect(JSON.stringify(stanza)).not.toContain("collaboration-rooms");
    expect(Object.keys(stanza).sort()).toEqual([
      "active_rooms",
      "empty_room_ttl_seconds",
      "invite_rate_limit_per_minute",
      "mode",
      "persistence",
      "retained_rooms",
      "transport",
    ]);
  });

  it("defaults to zero room counts and local-trust identity when the hub is empty", () => {
    expect(
      buildCollaborationHealthStanza({
        mode: "local-trust",
        persistence: false,
        emptyRoomTtlSeconds: 0,
        inviteRateLimitPerMinute: 0,
        liveRooms: [],
      }),
    ).toEqual({
      mode: "local-trust",
      persistence: false,
      empty_room_ttl_seconds: 0,
      invite_rate_limit_per_minute: 0,
      active_rooms: 0,
      retained_rooms: 0,
      transport: {
        loopback_binding: true,
        tls_termination: false,
        multi_node: false,
        member_identity: "local-trust",
      },
    });
  });
});
