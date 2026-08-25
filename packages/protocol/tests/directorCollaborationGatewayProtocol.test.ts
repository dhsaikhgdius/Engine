import { describe, expect, it } from "vitest";
import {
  decodeDirectorCollaborationGatewayPayload,
  directorCollaborationGatewayClientMessageSchema,
  directorCollaborationGatewayServerMessageSchema,
  encodeDirectorCollaborationGatewayPayload,
} from "../src/directorCollaborationGatewayProtocol";

describe("Director collaboration gateway protocol", () => {
  it("round-trips binary Yjs payloads without widening the JSON contract", () => {
    const payload = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    const encoded = encodeDirectorCollaborationGatewayPayload(payload)!;

    expect(decodeDirectorCollaborationGatewayPayload(encoded)).toEqual(payload);
    expect(
      directorCollaborationGatewayClientMessageSchema.safeParse({
        type: "collab.document-update",
        room: "production/shot-01",
        payload: encoded,
      }).success,
    ).toBe(true);
    expect(
      directorCollaborationGatewayServerMessageSchema.safeParse({
        type: "collab.document-update",
        room: "production/shot-01",
        payload: encoded,
        unexpected: true,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed payloads, unknown messages, and unsafe room names", () => {
    expect(decodeDirectorCollaborationGatewayPayload("not base64")).toBeNull();
    expect(
      directorCollaborationGatewayClientMessageSchema.safeParse({
        type: "collab.join",
        room: "../unsafe room?",
        awareness_client_id: 7,
      }).success,
    ).toBe(false);
    expect(
      directorCollaborationGatewayClientMessageSchema.safeParse({
        type: "collab.delete-room",
        room: "room-a",
      }).success,
    ).toBe(false);
  });
});
