// @vitest-environment node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CollaborationInviteRevocationRegistry } from "../../collaboration/collaborationInviteRevocationRegistry";
import { mintCollaborationInviteToken } from "../../collaborationRoomAuth";

const SECRET = "revocation-registry-test-secret";
const directories: string[] = [];

function tempPersistPath() {
  const directory = mkdtempSync(resolve(tmpdir(), "director-collab-revocations-"));
  directories.push(directory);
  return resolve(directory, "collaboration-invite-revocations.json");
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("CollaborationInviteRevocationRegistry", () => {
  it("persists revocations atomically and reloads them across registry instances", async () => {
    const persistPath = tempPersistPath();
    const registry = new CollaborationInviteRevocationRegistry({ persistPath });
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });
    await registry.revokeToken(invite.token);
    await registry.revokeRoomScope("project-a/*");

    // A fresh registry instance simulates a gateway restart.
    const reloaded = new CollaborationInviteRevocationRegistry({ persistPath });
    await reloaded.load();
    expect(reloaded.isRevoked({ room: "scene-alpha", exp: Date.now() + 60_000, jti: invite.jti }, "scene-alpha")).toBe(
      true,
    );
    expect(reloaded.isRevoked({ room: "project-a/*", exp: Date.now() + 60_000, iat: 1 }, "project-a/scene-1")).toBe(
      true,
    );
    expect(reloaded.counts()).toEqual({ revokedTokens: 1, roomCutoffs: 1 });
  });

  it("prunes revoked-token entries once the underlying invite expires", async () => {
    const clock = { value: 1_000_000 };
    const now = () => clock.value;
    const registry = new CollaborationInviteRevocationRegistry({ now });
    const invite = mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor", ttlSeconds: 60, now });
    await registry.revokeToken(invite.token);
    expect(registry.counts().revokedTokens).toBe(1);
    clock.value += 61_000;
    expect(registry.counts().revokedTokens).toBe(0);
  });

  it("bounds the registry maps instead of growing without limit", async () => {
    const registry = new CollaborationInviteRevocationRegistry({ maxRevokedTokens: 2, maxRoomCutoffs: 2 });
    for (let index = 0; index < 4; index += 1) {
      const invite = mintCollaborationInviteToken({ secret: SECRET, room: `scene-${index}`, role: "editor" });
      await registry.revokeToken(invite.token);
      await registry.revokeRoomScope(`scene-${index}`);
    }
    expect(registry.counts()).toEqual({ revokedTokens: 2, roomCutoffs: 2 });
  });

  it("starts empty when the persisted file is missing or unreadable", async () => {
    const registry = new CollaborationInviteRevocationRegistry({ persistPath: tempPersistPath() });
    await registry.load();
    expect(registry.counts()).toEqual({ revokedTokens: 0, roomCutoffs: 0 });
  });
});
