import { describe, expect, it } from "vitest";
import {
  DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
  DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
  directorGodotLiveLinkByeSchema,
  directorGodotLiveLinkEntitySchema,
  directorGodotLiveLinkFrameSchema,
  directorGodotLiveLinkHelloSchema,
  directorGodotLiveLinkPreviewSchema,
  directorGodotLiveLinkSessionSchema,
} from "../src/directorGodotLiveLinkContract";

const SESSION_ID = "0f9f1c8e-8f4c-4c1e-b2ff-95a5f34f9e51";

const TRANSFORM = {
  location: [1, 2, 3] as [number, number, number],
  rotationQuaternion: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

describe("director-godot-live-link-v1", () => {
  it("accepts a hello and a session grant", () => {
    const helloMessage = directorGodotLiveLinkHelloSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      provider: "godot",
      connectorVersion: "0.3.0",
      hostVersion: "Godot 4.3.0",
      scenePath: "res://director/scenes/director_fixture.tscn",
    });
    expect(helloMessage.provider).toBe("godot");

    const session = directorGodotLiveLinkSessionSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      provider: "godot",
      sessionId: SESSION_ID,
      idleTimeoutMs: 10_000,
      maxEntitiesPerFrame: 512,
    });
    expect(session.sessionId).toBe(SESSION_ID);
  });

  it("requires positive sequence numbers and at least one entity per frame", () => {
    const valid = directorGodotLiveLinkFrameSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
      sessionId: SESSION_ID,
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
          sequence,
          entities: [{ directorId: "obj-1", entityType: "object", transform: TRANSFORM }],
        }).success,
      ).toBe(false);
    }
    expect(
      directorGodotLiveLinkFrameSchema.safeParse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        sequence: 1,
        entities: [],
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

  it("pins the preview snapshot to never-authoritative", () => {
    const preview = directorGodotLiveLinkPreviewSchema.parse({
      contract: DIRECTOR_GODOT_LIVE_LINK_PREVIEW_CONTRACT,
      provider: "godot",
      authoritative: false,
      sessions: [
        {
          sessionId: SESSION_ID,
          connectorVersion: "0.3.0",
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
  });

  it("accepts a bye with an optional reason", () => {
    expect(
      directorGodotLiveLinkByeSchema.parse({
        contract: DIRECTOR_GODOT_LIVE_LINK_CONTRACT,
        sessionId: SESSION_ID,
        reason: "toggled off",
      }).reason,
    ).toBe("toggled off");
  });
});
