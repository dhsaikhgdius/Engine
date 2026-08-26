import { describe, expect, it } from "vitest";
import {
  DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
  DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
  directorGodotLiveLinkByeSchema,
  directorGodotLiveLinkEntitySchema,
  directorGodotLiveLinkFrameAckSchema,
  directorGodotLiveLinkFrameSchema,
  directorGodotLiveLinkHelloSchema,
  directorGodotLiveLinkPreviewSchema,
  directorGodotLiveLinkSessionSchema,
} from "../src/directorGodotLiveLinkContract";

const SESSION_ID = "0f9f1c8e-8f4c-4c1e-b2ff-95a5f34f9e51";
const SESSION_TOKEN = "fixture-session-token-0123456789abcdef";

const TRANSFORM = {
  location: [1, 2, 3] as [number, number, number],
  rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

describe("director-godot-live-link-v1", () => {
  it("accepts a hello and a session grant carrying the per-session token", () => {
    const helloMessage = directorGodotLiveLinkHelloSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      provider: "godot",
      connectorVersion: "0.4.0",
      hostVersion: "Godot 4.3.0",
      scenePath: "res://director/scenes/director_fixture.tscn",
    });
    expect(helloMessage.provider).toBe("godot");

    const session = directorGodotLiveLinkSessionSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      provider: "godot",
      sessionId: SESSION_ID,
      sessionToken: SESSION_TOKEN,
      idleTimeoutMs: 10_000,
      maxEntitiesPerFrame: 512,
    });
    expect(session.sessionId).toBe(SESSION_ID);

    // A grant without the token (or with a guessably short one) is invalid.
    expect(
      directorGodotLiveLinkSessionSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        provider: "godot",
        sessionId: SESSION_ID,
        idleTimeoutMs: 10_000,
        maxEntitiesPerFrame: 512,
      }).success,
    ).toBe(false);
    expect(
      directorGodotLiveLinkSessionSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        provider: "godot",
        sessionId: SESSION_ID,
        sessionToken: "short",
        idleTimeoutMs: 10_000,
        maxEntitiesPerFrame: 512,
      }).success,
    ).toBe(false);
  });

  it("requires the session token plus positive sequence numbers and at least one entity per frame", () => {
    const valid = directorGodotLiveLinkFrameSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId: SESSION_ID,
      sessionToken: SESSION_TOKEN,
      sequence: 12,
      atMs: 1_200,
      entities: [{ directorId: "cam-main", entityType: "camera", transform: TRANSFORM, fovDeg: 40 }],
    });
    expect(valid.sequence).toBe(12);

    for (const sequence of [0, -1, 1.5]) {
      expect(
        directorGodotLiveLinkFrameSchema.safeParse({
          contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
          sessionId: SESSION_ID,
          sessionToken: SESSION_TOKEN,
          sequence,
          entities: [{ directorId: "obj-1", entityType: "object", transform: TRANSFORM }],
        }).success,
      ).toBe(false);
    }
    expect(
      directorGodotLiveLinkFrameSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        sessionToken: SESSION_TOKEN,
        sequence: 1,
        entities: [],
      }).success,
    ).toBe(false);
    expect(
      directorGodotLiveLinkFrameSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        sequence: 1,
        entities: [{ directorId: "obj-1", entityType: "object", transform: TRANSFORM }],
      }).success,
    ).toBe(false);
  });

  it("acknowledges frames with an honest dropped-entity count", () => {
    const ack = directorGodotLiveLinkFrameAckSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId: SESSION_ID,
      sequence: 3,
      accepted: true,
      droppedEntityCount: 7,
    });
    expect(ack.droppedEntityCount).toBe(7);
    // The count is required (silence about drops is not allowed) and bounded
    // by the per-frame entity cap.
    expect(
      directorGodotLiveLinkFrameAckSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        sequence: 3,
        accepted: true,
      }).success,
    ).toBe(false);
    expect(
      directorGodotLiveLinkFrameAckSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        sequence: 3,
        accepted: true,
        droppedEntityCount: 513,
      }).success,
    ).toBe(false);
  });

  it("keeps fovDeg a camera-only channel", () => {
    expect(
      directorGodotLiveLinkEntitySchema.safeParse({
        directorId: "obj-1",
        entityType: "object",
        transform: TRANSFORM,
        fovDeg: 50,
      }).success,
    ).toBe(false);
  });

  it("pins the preview snapshot to never-authoritative and never carries session tokens", () => {
    const preview = directorGodotLiveLinkPreviewSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
      provider: "godot",
      authoritative: false,
      sessions: [
        {
          sessionId: SESSION_ID,
          connectorVersion: "0.4.0",
          hostVersion: "Godot 4.3.0",
          scenePath: null,
          startedAtMs: 1_000,
          lastSeenAtMs: 2_000,
          lastSequence: 7,
          frameCount: 3,
          entities: [{ directorId: "obj-1", entityType: "object", transform: TRANSFORM, atSequence: 7 }],
        },
      ],
    });
    expect(preview.sessions[0]!.lastSequence).toBe(7);
    expect(
      directorGodotLiveLinkPreviewSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
        provider: "godot",
        authoritative: true,
        sessions: [],
      }).success,
    ).toBe(false);
    // The strict session shape rejects any attempt to expose the token.
    expect(
      directorGodotLiveLinkPreviewSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
        provider: "godot",
        authoritative: false,
        sessions: [
          {
            sessionId: SESSION_ID,
            sessionToken: SESSION_TOKEN,
            connectorVersion: "0.4.0",
            hostVersion: "Godot 4.3.0",
            scenePath: null,
            startedAtMs: 1_000,
            lastSeenAtMs: 2_000,
            lastSequence: 7,
            frameCount: 3,
            entities: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a bye with the session token and an optional reason", () => {
    expect(
      directorGodotLiveLinkByeSchema.parse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        sessionToken: SESSION_TOKEN,
        reason: "toggled off",
      }).reason,
    ).toBe("toggled off");
    expect(
      directorGodotLiveLinkByeSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        reason: "missing token",
      }).success,
    ).toBe(false);
  });
});
