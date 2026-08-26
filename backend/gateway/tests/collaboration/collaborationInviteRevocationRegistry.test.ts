// @vitest-environment node

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    const invite = mintCollaborationInviteToken({
      secret: SECRET,
      room: "scene-alpha",
      role: "editor",
      ttlSeconds: 60,
      now,
    });
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

  it("prunes room cutoffs older than the maximum invite TTL, in memory and on reload", async () => {
    const clock = { value: 1_000_000 };
    const now = () => clock.value;
    const registry = new CollaborationInviteRevocationRegistry({ now });
    await registry.revokeRoomScope("stale-room");
    expect(registry.counts().roomCutoffs).toBe(1);
    // Move past the longest possible invite lifetime: every invite the stale
    // cutoff could deny has expired on its own by now.
    clock.value += 30 * 24 * 60 * 60 * 1_000 + 1_000;
    expect(registry.counts().roomCutoffs).toBe(0);

    // The stale cutoff also disappears on a persisted reload.
    const persistPath = tempPersistPath();
    const persisted = new CollaborationInviteRevocationRegistry({ persistPath, now });
    await persisted.revokeRoomScope("reload-stale");
    clock.value += 30 * 24 * 60 * 60 * 1_000 + 1_000;
    const reloaded = new CollaborationInviteRevocationRegistry({ persistPath, now });
    await reloaded.load();
    expect(reloaded.counts().roomCutoffs).toBe(0);
  });

  it("reports revocation durability honestly: persisted only when the flush reached the durable file", async () => {
    const invite = () => mintCollaborationInviteToken({ secret: SECRET, room: "scene-alpha", role: "editor" });

    // Process-local registry: revocations die with the process.
    const inMemory = new CollaborationInviteRevocationRegistry();
    expect(inMemory.persistenceEnabled).toBe(false);
    expect(await inMemory.revokeToken(invite().token)).toMatchObject({ revoked: true, persisted: false });
    expect(await inMemory.revokeRoomScope("scene-alpha")).toMatchObject({ revoked: true, persisted: false });

    // Durable registry: the flush landed, so the revocation survives restarts.
    const durable = new CollaborationInviteRevocationRegistry({ persistPath: tempPersistPath() });
    expect(durable.persistenceEnabled).toBe(true);
    expect(await durable.revokeToken(invite().token)).toMatchObject({ revoked: true, persisted: true });
    expect(await durable.revokeRoomScope("scene-alpha")).toMatchObject({ revoked: true, persisted: true });

    // Persistence configured but the write fails (a file blocks the parent
    // directory): the revocation is still active in-process but not durable.
    const directory = mkdtempSync(resolve(tmpdir(), "director-collab-revocations-"));
    directories.push(directory);
    writeFileSync(resolve(directory, "blocked"), "not a directory");
    const failing = new CollaborationInviteRevocationRegistry({
      persistPath: resolve(directory, "blocked", "revocations.json"),
    });
    expect(failing.persistenceEnabled).toBe(true);
    const outcome = await failing.revokeToken(invite().token);
    expect(outcome).toMatchObject({ revoked: true, persisted: false });
    expect(failing.counts().revokedTokens).toBe(1);
  });

  it("refreshes a re-revoked scope's recency so bounded eviction drops the least recently revoked scope", async () => {
    const clock = { value: 1_000_000 };
    const now = () => clock.value;
    const registry = new CollaborationInviteRevocationRegistry({ maxRoomCutoffs: 2, now });
    await registry.revokeRoomScope("scene-a");
    clock.value += 1_000;
    await registry.revokeRoomScope("scene-b");
    clock.value += 1_000;
    // Re-revoking scene-a must refresh its position; the next eviction should
    // drop scene-b, not the just-refreshed scene-a.
    await registry.revokeRoomScope("scene-a");
    clock.value += 1_000;
    await registry.revokeRoomScope("scene-c");
    expect(registry.counts().roomCutoffs).toBe(2);
    expect(registry.isRevoked({ room: "scene-a", exp: clock.value + 60_000, iat: 1 }, "scene-a")).toBe(true);
    expect(registry.isRevoked({ room: "scene-c", exp: clock.value + 60_000, iat: 1 }, "scene-c")).toBe(true);
    expect(registry.isRevoked({ room: "scene-b", exp: clock.value + 60_000, iat: 1 }, "scene-b")).toBe(false);
  });
});
