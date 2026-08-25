import { afterEach, describe, expect, it } from "vitest";
import { createDefaultDirectorProject } from "../../../../src/comprehensive/editor/store/directorStore";
import type { DirectorSharedState } from "../../../../src/comprehensive/editor/collaboration/directorCollaboration";
import {
  decodeDirectorCollaborationUpdate,
  DirectorCollaborationSession,
  encodeDirectorCollaborationUpdate,
  mergeDirectorLocalMedia,
  projectForDirectorCollaboration,
  type DirectorCollaborationTransport,
  type DirectorCollaborationWireMessage,
} from "../../../../src/comprehensive/editor/collaboration/directorCollaboration";

const ALICE = { id: "alice", name: "Alice", color: "#ef476f" };
const BOB = { id: "bob", name: "Bob", color: "#118ab2" };

function createSharedState(): DirectorSharedState {
  return {
    stage: createDefaultDirectorProject(),
    creative: {
      boardNodes: [
        {
          id: "board-one",
          kind: "note",
          title: "Opening",
          body: "Establish the room",
          mediaId: null,
          x: 120,
          y: 80,
          width: 280,
          height: 156,
          accent: "#29d6ff",
        },
      ],
      boardEdges: [],
      editTracks: [
        {
          id: "video-one",
          name: "Video 1",
          kind: "video",
          muted: false,
          locked: false,
          visible: true,
          clips: [],
        },
      ],
      editSettings: {
        aspectRatio: "16 / 9",
        fps: 24,
        snapEnabled: true,
        exportQuality: "preview",
      },
    },
  };
}

class MemoryTransport implements DirectorCollaborationTransport {
  peer: MemoryTransport | null = null;
  closed = false;
  private readonly listeners = new Set<(message: DirectorCollaborationWireMessage) => void>();

  send(message: DirectorCollaborationWireMessage) {
    if (this.closed || !this.peer || this.peer.closed) return;
    const copy = { ...message, payload: message.payload.slice() } as DirectorCollaborationWireMessage;
    this.peer.listeners.forEach((listener) => listener(copy));
  }

  subscribe(listener: (message: DirectorCollaborationWireMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }
}

function createTransportPair() {
  const first = new MemoryTransport();
  const second = new MemoryTransport();
  first.peer = second;
  second.peer = first;
  return [first, second] as const;
}

const liveSessions = new Set<DirectorCollaborationSession>();

function createSession(
  identity = ALICE,
  options: Partial<ConstructorParameters<typeof DirectorCollaborationSession>[0]> = {},
) {
  const session = new DirectorCollaborationSession({
    scopeId: "scene-one",
    identity,
    ...options,
  });
  liveSessions.add(session);
  return session;
}

afterEach(() => {
  liveSessions.forEach((session) => session.destroy());
  liveSessions.clear();
});

describe("DirectorCollaborationSession", () => {
  it("converges granular concurrent Stage edits instead of replacing the whole project", () => {
    const alice = createSession(ALICE);
    const bob = createSession(BOB);
    alice.setSharedState(createSharedState());
    expect(bob.applyDocumentUpdate(alice.encodeDocumentUpdate())).toBe(true);

    const aliceState = alice.getSharedState()!;
    aliceState.stage.objects[0]!.name = "Alice's actor";
    alice.setSharedState(aliceState);

    const bobState = bob.getSharedState()!;
    bobState.stage.cameras[0]!.name = "Bob's camera";
    bob.setSharedState(bobState);

    const aliceUpdate = alice.encodeDocumentUpdate(bob.encodeStateVector());
    const bobUpdate = bob.encodeDocumentUpdate(alice.encodeStateVector());
    expect(alice.applyDocumentUpdate(bobUpdate)).toBe(true);
    expect(bob.applyDocumentUpdate(aliceUpdate)).toBe(true);

    expect(alice.getSharedState()?.stage.objects[0]?.name).toBe("Alice's actor");
    expect(alice.getSharedState()?.stage.cameras[0]?.name).toBe("Bob's camera");
    expect(bob.getSharedState()).toEqual(alice.getSharedState());
  });

  it("deterministically converges concurrent writes to the same shared field", () => {
    const alice = createSession(ALICE);
    const bob = createSession(BOB);
    alice.setSharedState(createSharedState());
    expect(bob.applyDocumentUpdate(alice.encodeDocumentUpdate())).toBe(true);

    const aliceState = alice.getSharedState()!;
    aliceState.stage.objects[0]!.name = "Alice title";
    alice.setSharedState(aliceState);

    const bobState = bob.getSharedState()!;
    bobState.stage.objects[0]!.name = "Bob title";
    bob.setSharedState(bobState);

    const aliceDelta = alice.encodeDocumentUpdate(bob.encodeStateVector());
    const bobDelta = bob.encodeDocumentUpdate(alice.encodeStateVector());
    expect(alice.applyDocumentUpdate(bobDelta)).toBe(true);
    expect(bob.applyDocumentUpdate(aliceDelta)).toBe(true);

    const convergedName = alice.getSharedState()?.stage.objects[0]?.name;
    expect(["Alice title", "Bob title"]).toContain(convergedName);
    expect(bob.getSharedState()?.stage.objects[0]?.name).toBe(convergedName);
  });

  it("synchronizes documents and bidirectional presence through the transport handshake", () => {
    const alice = createSession(ALICE);
    const bob = createSession(BOB);
    const [aliceTransport, bobTransport] = createTransportPair();
    alice.setSharedState(createSharedState());
    alice.setLocalPresence({
      workspace: "stage",
      selectedObjectIds: ["char_default_a"],
      activeCameraId: "cam_1",
      frame: 12,
      cursor: { space: "stage", x: 40, y: 24 },
    });

    alice.attachTransport(aliceTransport);
    bob.attachTransport(bobTransport);

    expect(bob.getSharedState()).toEqual(alice.getSharedState());
    expect(
      bob
        .getPresences()
        .map((presence) => presence.user.id)
        .sort(),
    ).toEqual(["alice", "bob"]);
    expect(
      alice
        .getPresences()
        .map((presence) => presence.user.id)
        .sort(),
    ).toEqual(["alice", "bob"]);
    expect(bob.getPresences().find((presence) => presence.user.id === "alice")).toMatchObject({
      frame: 12,
      selectedObjectIds: ["char_default_a"],
      cursor: { space: "stage", x: 40, y: 24 },
    });

    alice.setLocalPresence({ cursor: null, workspace: "video", playheadSec: 3.25 });
    expect(bob.getPresences().find((presence) => presence.user.id === "alice")).toMatchObject({
      workspace: "video",
      playheadSec: 3.25,
    });
    expect(bob.getPresences().find((presence) => presence.user.id === "alice")?.cursor).toBeUndefined();

    alice.destroy();
    liveSessions.delete(alice);
    expect(bob.getPresences().map((presence) => presence.user.id)).toEqual(["bob"]);
  });

  it("syncs anchored review annotations and resolution metadata", () => {
    let currentTime = "2026-07-31T08:00:00.000Z";
    let id = 0;
    const alice = createSession(ALICE, {
      now: () => new Date(currentTime),
      createId: (prefix) => `${prefix}-${++id}`,
    });
    const bob = createSession(BOB, { now: () => new Date(currentTime) });
    const [aliceTransport, bobTransport] = createTransportPair();
    alice.attachTransport(aliceTransport);
    bob.attachTransport(bobTransport);

    const objectComment = alice.addReviewComment({
      anchor: { type: "object", sceneId: "scene-one", objectId: "char_default_a" },
      body: "Move the eyeline left.",
    });
    alice.addReviewComment({
      anchor: { type: "time", sceneId: "scene-one", frame: 48, trackId: "video-one" },
      body: "Cut two frames earlier.",
    });

    expect(
      bob.getReviewComments({
        anchor: { type: "object", sceneId: "scene-one", objectId: "char_default_a" },
      }),
    ).toEqual([objectComment]);
    expect(bob.getReviewComments({ sceneId: "scene-one", status: "open" })).toHaveLength(2);

    currentTime = "2026-07-31T08:03:00.000Z";
    expect(bob.setReviewCommentStatus(objectComment.id, "resolved")).toBe(true);
    expect(alice.getReviewComments().find((comment) => comment.id === objectComment.id)).toMatchObject({
      status: "resolved",
      resolvedAt: currentTime,
      resolvedBy: BOB,
    });

    expect(alice.setReviewCommentStatus(objectComment.id, "open")).toBe(true);
    expect(bob.getReviewComments().find((comment) => comment.id === objectComment.id)).toMatchObject({
      status: "open",
    });
    expect(bob.getReviewComments().find((comment) => comment.id === objectComment.id)?.resolvedAt).toBeUndefined();
  });

  it("converges concurrent annotation edits and preserves concurrent additions", () => {
    let aliceId = 0;
    let bobId = 0;
    const alice = createSession(ALICE, { createId: (prefix) => `${prefix}-alice-${++aliceId}` });
    const bob = createSession(BOB, { createId: (prefix) => `${prefix}-bob-${++bobId}` });
    const original = alice.addReviewComment({
      anchor: { type: "scene", sceneId: "scene-one" },
      body: "Original note",
    });
    expect(bob.applyDocumentUpdate(alice.encodeDocumentUpdate())).toBe(true);

    expect(alice.updateReviewComment(original.id, "Alice edit")).toBe(true);
    expect(bob.updateReviewComment(original.id, "Bob edit")).toBe(true);
    const aliceEdit = alice.encodeDocumentUpdate(bob.encodeStateVector());
    const bobEdit = bob.encodeDocumentUpdate(alice.encodeStateVector());
    expect(alice.applyDocumentUpdate(bobEdit)).toBe(true);
    expect(bob.applyDocumentUpdate(aliceEdit)).toBe(true);

    const convergedBody = alice.getReviewComments().find((comment) => comment.id === original.id)?.body;
    expect(["Alice edit", "Bob edit"]).toContain(convergedBody);
    expect(bob.getReviewComments().find((comment) => comment.id === original.id)?.body).toBe(convergedBody);

    const aliceAddition = alice.addReviewComment({
      anchor: { type: "object", sceneId: "scene-one", objectId: "char_default_a" },
      body: "Alice addition",
    });
    const bobAddition = bob.addReviewComment({
      anchor: { type: "time", sceneId: "scene-one", frame: 72 },
      body: "Bob addition",
    });
    const aliceAdditionUpdate = alice.encodeDocumentUpdate(bob.encodeStateVector());
    const bobAdditionUpdate = bob.encodeDocumentUpdate(alice.encodeStateVector());
    expect(alice.applyDocumentUpdate(bobAdditionUpdate)).toBe(true);
    expect(bob.applyDocumentUpdate(aliceAdditionUpdate)).toBe(true);

    const aliceCommentIds = alice
      .getReviewComments()
      .map((comment) => comment.id)
      .sort();
    expect(aliceCommentIds).toEqual([aliceAddition.id, bobAddition.id, original.id].sort());
    expect(
      bob
        .getReviewComments()
        .map((comment) => comment.id)
        .sort(),
    ).toEqual(aliceCommentIds);
  });

  it("creates, compares, restores, and deletes immutable version snapshots", () => {
    let id = 0;
    const session = createSession(ALICE, {
      now: () => new Date("2026-07-31T09:00:00.000Z"),
      createId: (prefix) => `${prefix}-${++id}`,
    });
    const original = createSharedState();
    session.setSharedState(original);
    const first = session.createVersionSnapshot({ name: "Blocking" });

    const revised = session.getSharedState()!;
    revised.stage.objects[0]!.name = "Lead";
    revised.creative.boardNodes.push({
      id: "board-two",
      kind: "note",
      title: "Close-up",
      body: "",
      mediaId: null,
      x: 460,
      y: 80,
      width: 280,
      height: 156,
      accent: "#ef476f",
    });
    session.setSharedState(revised);

    const comparison = session.compareVersionToCurrent(first.id)!;
    expect(comparison.truncated).toBe(false);
    expect(comparison.summary).toMatchObject({
      added: 1,
      changed: 1,
      stageObjectsBefore: 2,
      stageObjectsAfter: 2,
      canvasNodesBefore: 1,
      canvasNodesAfter: 2,
    });
    expect(comparison.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "creative.boardNodes[board-two]", kind: "added" }),
        expect.objectContaining({ path: "stage.objects[char_default_a].name", kind: "changed" }),
      ]),
    );

    const second = session.createVersionSnapshot({ name: "Close-up pass" });
    expect(session.compareVersionSnapshots(first.id, second.id)?.comparedToVersionId).toBe(second.id);

    const restoredStates: DirectorSharedState[] = [];
    session.subscribeSharedState((state) => restoredStates.push(state));
    expect(session.restoreVersionSnapshot(first.id)).toBe(true);
    expect(session.getSharedState()?.stage.objects[0]?.name).toBe(original.stage.objects[0]?.name);
    expect(restoredStates.at(-1)?.creative.boardNodes).toHaveLength(1);
    expect(session.deleteVersionSnapshot(second.id)).toBe(true);
    expect(session.listVersionSnapshots().map((version) => version.id)).toEqual([first.id]);
  });

  it("encodes a scoped persistence envelope and restores document data without persisting awareness", () => {
    const alice = createSession(ALICE, {
      now: () => new Date("2026-07-31T10:00:00.000Z"),
      createId: (prefix) => `${prefix}-persisted`,
    });
    alice.setSharedState(createSharedState());
    alice.addReviewComment({ anchor: { type: "scene", sceneId: "scene-one" }, body: "Scene note" });
    alice.createVersionSnapshot({ name: "Persist me" });
    alice.setLocalPresence({ frame: 24 });

    const serialized = alice.encodePersistenceUpdate();
    const decoded = decodeDirectorCollaborationUpdate(serialized);
    expect(decoded).toMatchObject({
      version: 1,
      scopeId: "scene-one",
      savedAt: "2026-07-31T10:00:00.000Z",
    });

    const restored = createSession(BOB);
    expect(restored.applyPersistenceUpdate(serialized)).toBe(true);
    expect(restored.getSharedState()).toEqual(alice.getSharedState());
    expect(restored.getReviewComments()).toEqual(alice.getReviewComments());
    expect(restored.listVersionSnapshots()).toEqual(alice.listVersionSnapshots());
    expect(restored.getPresences().map((presence) => presence.user.id)).toEqual(["bob"]);

    const wrongScope = createSession(BOB, { scopeId: "scene-two" });
    expect(wrongScope.applyPersistenceUpdate(serialized)).toBe(false);
    expect(wrongScope.hasSharedState()).toBe(false);
    expect(decodeDirectorCollaborationUpdate('{"version":1,"update":"not-base64"}')).toBeNull();
    expect(() => encodeDirectorCollaborationUpdate({ scopeId: "scene-one", update: new Uint8Array([255]) })).toThrow(
      /invalid Director collaboration update/,
    );
  });

  it("keeps local media pixels outside the CRDT and reattaches only matching local media", () => {
    const localProject = createDefaultDirectorProject();
    localProject.assets.push({
      id: "local-prop",
      kind: "prop",
      sourceType: "model",
      fileName: "local.glb",
      url: "blob:local-prop-pixels",
      assetSource: "local",
    });
    localProject.cameras[0]!.lastCaptureUrl = "data:image/png;base64,secret-frame";
    localProject.cameras[0]!.captures = [
      { id: "capture-one", index: 1, name: "Take 1", dataUrl: "data:image/png;base64,secret-capture" },
    ];

    const projected = projectForDirectorCollaboration(localProject);
    expect(projected.assets.find((asset) => asset.id === "local-prop")?.url).toBe("director-local-media://local-prop");
    expect(projected.cameras[0]?.lastCaptureUrl).toBeNull();
    expect(projected.cameras[0]?.captures).toBeUndefined();

    const session = createSession(ALICE);
    session.setSharedState({ ...createSharedState(), stage: localProject });
    expect(session.getSharedState()?.stage).toEqual(projected);

    const merged = mergeDirectorLocalMedia(projected, localProject);
    expect(merged.assets.find((asset) => asset.id === "local-prop")?.url).toBe("blob:local-prop-pixels");
    expect(merged.cameras[0]?.lastCaptureUrl).toBe("data:image/png;base64,secret-frame");
    expect(merged.cameras[0]?.captures?.[0]?.dataUrl).toBe("data:image/png;base64,secret-capture");
  });
});
