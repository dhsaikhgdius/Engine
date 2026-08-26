// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCollaborationRuntime,
  parseCollaborationEmptyRoomTtlSeconds,
} from "../../collaboration/collaborationRuntime";

const directories: string[] = [];

function tempDataDirectory() {
  const directory = mkdtempSync(resolve(tmpdir(), "director-collab-runtime-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("parseCollaborationEmptyRoomTtlSeconds", () => {
  it("defaults to immediate destruction and clamps to 24 hours", () => {
    expect(parseCollaborationEmptyRoomTtlSeconds(undefined)).toBe(0);
    expect(parseCollaborationEmptyRoomTtlSeconds("")).toBe(0);
    expect(parseCollaborationEmptyRoomTtlSeconds("not-a-number")).toBe(0);
    expect(parseCollaborationEmptyRoomTtlSeconds("-5")).toBe(0);
    expect(parseCollaborationEmptyRoomTtlSeconds("300")).toBe(300);
    expect(parseCollaborationEmptyRoomTtlSeconds("999999999")).toBe(24 * 60 * 60);
  });
});

describe("createCollaborationRuntime", () => {
  it("keeps the backward-compatible defaults: local trust, no persistence, immediate room destruction", () => {
    const runtime = createCollaborationRuntime({
      dataDirectory: tempDataDirectory(),
      gatewaySecret: "process-secret",
      env: {},
    });
    expect(runtime.authorizer.mode).toBe("local-trust");
    expect(runtime.snapshotStore).toBeNull();
    expect(runtime.emptyRoomTtlSeconds).toBe(0);
    expect(runtime.hub.authMode).toBe("local-trust");
    expect(runtime.inviteSecret).toBe("process-secret");
    runtime.hub.destroy();
  });

  it("wires invite auth, persistence, revocations, and the empty-room TTL from the environment", () => {
    const runtime = createCollaborationRuntime({
      dataDirectory: tempDataDirectory(),
      gatewaySecret: "process-secret",
      env: {
        DIRECTOR_COLLAB_ROOM_AUTH: "required",
        DIRECTOR_COLLAB_INVITE_SECRET: "stable-secret",
        DIRECTOR_COLLAB_PERSISTENCE: "1",
        DIRECTOR_COLLAB_EMPTY_ROOM_TTL_SECONDS: "120",
      },
    });
    expect(runtime.authorizer.mode).toBe("invite-required");
    expect(runtime.snapshotStore).not.toBeNull();
    expect(runtime.emptyRoomTtlSeconds).toBe(120);
    expect(runtime.inviteSecret).toBe("stable-secret");
    expect(runtime.revocations.counts()).toEqual({ revokedTokens: 0, roomCutoffs: 0 });
    runtime.hub.destroy();
  });
});
