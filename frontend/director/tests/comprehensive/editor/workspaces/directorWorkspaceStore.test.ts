import { act } from "@testing-library/react";
import {
  DIRECTOR_WORKSPACE_RECOVERY_KEY_PREFIX,
  findDirectorEditClip,
  findDirectorTransitionPredecessor,
  getDirectorCreativeWorkspaceScope,
  getDirectorEditDuration,
  parseDirectorCreativeWorkspacePersistedState,
  resolveDirectorTrackOverwrite,
  summarizeDirectorTrackOverwrite,
  serializeDirectorCreativeWorkspacePersistedState,
  setDirectorCreativeWorkspaceScope,
  subscribeDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
  type DirectorEditClip,
  type DirectorEditTrack,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

function overwriteClip(
  overrides: Partial<DirectorEditClip> & Pick<DirectorEditClip, "id" | "startSec" | "durationSec">,
): DirectorEditClip {
  return {
    mediaId: "media:overwrite",
    name: overrides.id,
    inSec: 0,
    sourceDurationSec: 120,
    playbackRate: 1,
    opacity: 1,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    scale: 1,
    positionX: 0,
    positionY: 0,
    rotationDeg: 0,
    fit: "contain",
    ...overrides,
  };
}

function recoveryKeysHolding(serialized: string) {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(DIRECTOR_WORKSPACE_RECOVERY_KEY_PREFIX) && window.localStorage.getItem(key) === serialized) {
      keys.push(key);
    }
  }
  return keys;
}

beforeEach(() => {
  act(() => {
    setDirectorCreativeWorkspaceScope("");
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });
});

it("exposes the normalized active creative workspace scope", () => {
  expect(getDirectorCreativeWorkspaceScope()).toBe("local");
  act(() => setDirectorCreativeWorkspaceScope("  scene / alpha  "));
  expect(getDirectorCreativeWorkspaceScope()).toBe("scene_alpha");
  act(() => setDirectorCreativeWorkspaceScope(""));
  expect(getDirectorCreativeWorkspaceScope()).toBe("local");
});

it("publishes a normalized scope only after its workspace state is restored", () => {
  const scope = `scope-listener-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(
    `director.creative-workspaces.v2.${scope}`,
    JSON.stringify({
      version: 2,
      state: {
        mode: "video",
        boardNodes: [],
        boardEdges: [],
        editTracks: [],
        playheadSec: 3,
      },
    }),
  );
  const observed: Array<{ scopeId: string; mode: string; playheadSec: number }> = [];
  const unsubscribe = subscribeDirectorCreativeWorkspaceScope((scopeId) => {
    const state = useDirectorCreativeWorkspaceStore.getState();
    observed.push({ scopeId, mode: state.mode, playheadSec: state.playheadSec });
  });

  try {
    act(() => setDirectorCreativeWorkspaceScope(` ${scope} `));
    act(() => setDirectorCreativeWorkspaceScope(scope));
  } finally {
    unsubscribe();
    act(() => setDirectorCreativeWorkspaceScope(""));
    window.localStorage.removeItem(`director.creative-workspaces.v2.${scope}`);
  }

  expect(observed).toEqual([{ scopeId: scope, mode: "video", playheadSec: 3 }]);
});

it("creates movable canvas nodes and prevents duplicate connections", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let firstId = "";
  let secondId = "";

  act(() => {
    firstId = store.addBoardNode({ kind: "shot", title: "Shot A", mediaId: "shot:a", x: 40, y: 70 })!.id;
    secondId = store.addBoardNode({ kind: "image", title: "Reference B", mediaId: "image:b", x: 500, y: 180 })!.id;
    store.addBoardEdge(firstId, secondId);
    store.addBoardEdge(firstId, secondId);
    store.updateBoardNode(firstId, { x: 120, width: 360 });
  });

  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(state.boardEdges).toHaveLength(1);
  expect(state.boardNodes.find((node) => node.id === firstId)).toMatchObject({ x: 120, width: 360 });

  act(() => state.removeBoardNode(secondId));
  expect(useDirectorCreativeWorkspaceStore.getState().boardEdges).toHaveLength(0);
});

it("keeps Canvas dependencies acyclic and lays each dependency level out atomically", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  const ids: string[] = [];
  act(() => {
    ids.push(store.addBoardNode({ kind: "note", title: "Prompt", x: 500, y: 500 })!.id);
    ids.push(store.addBoardNode({ kind: "image", title: "Image", x: 10, y: 30 })!.id);
    ids.push(store.addBoardNode({ kind: "audio", title: "Voice", x: 20, y: 40 })!.id);
    ids.push(store.addBoardNode({ kind: "video", title: "Edit", x: 30, y: 50 })!.id);
    expect(store.addBoardEdge(ids[0]!, ids[1]!)).toBe(true);
    expect(store.addBoardEdge(ids[0]!, ids[2]!)).toBe(true);
    expect(store.addBoardEdge(ids[1]!, ids[3]!)).toBe(true);
    expect(store.addBoardEdge(ids[2]!, ids[3]!)).toBe(true);
    expect(store.addBoardEdge(ids[3]!, ids[0]!)).toBe(false);
  });

  const beforeLayout = useDirectorCreativeWorkspaceStore.getState();
  expect(beforeLayout.boardEdges).toHaveLength(4);
  act(() => expect(beforeLayout.layoutBoardDag({ originX: 80, originY: 90 })).toBe(true));
  const laidOut = useDirectorCreativeWorkspaceStore.getState();
  const byId = new Map(laidOut.boardNodes.map((node) => [node.id, node]));
  expect(byId.get(ids[0]!)?.x).toBe(80);
  expect(byId.get(ids[1]!)?.x).toBe(byId.get(ids[2]!)?.x);
  expect(byId.get(ids[3]!)!.x).toBeGreaterThan(byId.get(ids[1]!)!.x);

  act(() => laidOut.undo());
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.find((node) => node.id === ids[0])?.x).toBe(500);
});

it("refuses Canvas nodes at capacity without evicting earlier user content", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let firstId = "";
  let rejected = false;
  act(() => {
    firstId = store.addBoardNode({ kind: "note", title: "Seed", x: 0, y: 0 })!.id;
    for (let index = store.boardNodes.length; index <= 240; index += 1) {
      const added = store.addBoardNode({ kind: "note", title: `Capacity ${index}`, x: index, y: index });
      if (!added) rejected = true;
    }
  });
  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(rejected).toBe(true);
  expect(state.boardNodes).toHaveLength(240);
  expect(state.boardNodes.some((node) => node.id === firstId)).toBe(true);
});

it("adds, trims, and moves clips across edit tracks", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "recording:a",
      name: "Take A",
      startSec: 2,
      durationSec: 5,
      sourceDurationSec: 8,
    })!.id;
    store.updateClip(clipId, { inSec: 1.5, durationSec: 4, opacity: 0.75 });
    store.moveClipToTrack(clipId, "video-2", 6.25);
  });

  const state = useDirectorCreativeWorkspaceStore.getState();
  const selected = findDirectorEditClip(state.editTracks, clipId);
  expect(selected?.track.id).toBe("video-2");
  expect(selected?.clip).toMatchObject({ startSec: 6.25, durationSec: 4, inSec: 1.5, opacity: 0.75 });
  expect(getDirectorEditDuration(state.editTracks)).toBe(11);
});

it("keeps playback speed, source bounds, and split points on one time mapping", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "recording:fast",
      name: "Fast take",
      startSec: 0,
      durationSec: 4,
      sourceDurationSec: 8,
      playbackRate: 2,
    })!.id;
    store.splitClip(clipId, 2);
  });

  const track = useDirectorCreativeWorkspaceStore.getState().editTracks.find((item) => item.id === "video-1")!;
  expect(track.clips).toHaveLength(2);
  expect(track.clips[0]).toMatchObject({ durationSec: 2, inSec: 0, playbackRate: 2 });
  expect(track.clips[1]).toMatchObject({ startSec: 2, durationSec: 2, inSec: 4, playbackRate: 2 });
});

it("normalizes clip fades and visual transforms in the 1920 by 1080 design space", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "recording:styled",
      name: "Styled",
      startSec: 0,
      durationSec: 5,
      fadeInSec: 4,
      fadeOutSec: 4,
      scale: 100,
      positionX: 9000,
      positionY: -9000,
      rotationDeg: 5000,
      fit: "cover",
    })!.id;
  });

  const added = findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clipId)!.clip;
  expect(added).toMatchObject({
    fadeInSec: 2.5,
    fadeOutSec: 2.5,
    scale: 20,
    positionX: 7680,
    positionY: -7680,
    rotationDeg: 3600,
    fit: "cover",
  });

  act(() => {
    useDirectorCreativeWorkspaceStore.getState().updateClip(clipId, {
      durationSec: 3,
      fadeInSec: 10,
      fadeOutSec: 5,
      scale: 0,
      rotationDeg: -5000,
    });
  });
  const updated = findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clipId)!.clip;
  expect(updated.fadeInSec).toBeCloseTo(2);
  expect(updated.fadeOutSec).toBeCloseTo(1);
  expect(updated.scale).toBe(0.05);
  expect(updated.rotationDeg).toBe(-3600);
});

it("splits a clip at the playhead while preserving source timing", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "recording:split",
      name: "Long take",
      startSec: 1,
      durationSec: 6,
      sourceDurationSec: 8,
    })!.id;
  });

  let secondId = "";
  act(() => {
    secondId = store.splitClip(clipId, 3.5)!.id;
  });

  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, clipId)?.clip.durationSec).toBe(2.5);
  expect(findDirectorEditClip(state.editTracks, secondId)?.clip).toMatchObject({
    startSec: 3.5,
    durationSec: 3.5,
    inSec: 2.5,
  });
});

it("sets a predecessor-clamped cross-dissolve transition as a single undo step", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    store.addClip({ trackId: "video-1", mediaId: "shot:prev", name: "Prev", startSec: 0, durationSec: 1 });
    clipId = store.addClip({ trackId: "video-1", mediaId: "shot:next", name: "Next", startSec: 1, durationSec: 4 })!.id;
  });
  act(() => useDirectorCreativeWorkspaceStore.getState().setClipTransition(clipId, 3));
  let state = useDirectorCreativeWorkspaceStore.getState();
  // Requested 3s clamps to the shorter neighbor: min(4, 1) = 1.
  expect(findDirectorEditClip(state.editTracks, clipId)?.clip.transitionInSec).toBe(1);

  // Re-applying the same value must not add a history entry, so one undo
  // reverts the transition itself rather than a no-op snapshot.
  act(() => useDirectorCreativeWorkspaceStore.getState().setClipTransition(clipId, 1));
  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, clipId)?.clip).toMatchObject({ startSec: 1, transitionInSec: 0 });
});

it("ignores transitions on locked tracks or clips without an adjacent predecessor", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let lonelyId = "";
  let gappedId = "";
  let lockedId = "";
  act(() => {
    lonelyId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:lonely",
      name: "Lonely",
      startSec: 5,
      durationSec: 2,
    })!.id;
    store.addClip({ trackId: "video-2", mediaId: "shot:prev", name: "Prev", startSec: 0, durationSec: 2 });
    gappedId = store.addClip({
      trackId: "video-2",
      mediaId: "shot:gapped",
      name: "Gapped",
      startSec: 2.002,
      durationSec: 2,
    })!.id;
  });
  act(() => {
    const live = useDirectorCreativeWorkspaceStore.getState();
    live.setClipTransition(lonelyId, 1);
    // A 2ms gap exceeds the 1e-3 adjacency tolerance.
    live.setClipTransition(gappedId, 1);
  });
  let state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, lonelyId)?.clip.transitionInSec).toBe(0);
  expect(findDirectorEditClip(state.editTracks, gappedId)?.clip.transitionInSec).toBe(0);
  // Both requests were no-ops, so the next undo reverts the last addClip.
  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  expect(findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, gappedId)).toBeNull();

  act(() => {
    const live = useDirectorCreativeWorkspaceStore.getState();
    live.addClip({ trackId: "video-1", mediaId: "shot:before", name: "Before", startSec: 3, durationSec: 2 });
    lockedId = live.addClip({
      trackId: "video-1",
      mediaId: "shot:locked",
      name: "Locked",
      startSec: 5,
      durationSec: 2,
    })!.id;
    live.toggleTrackLock("video-1");
  });
  act(() => useDirectorCreativeWorkspaceStore.getState().setClipTransition(lockedId, 1));
  state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, lockedId)?.clip.transitionInSec).toBe(0);
});

it("accepts a transition when the predecessor edge sits within the snap tolerance", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    store.addClip({ trackId: "video-1", mediaId: "shot:prev", name: "Prev", startSec: 0, durationSec: 2 });
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:snapped",
      name: "Snapped",
      startSec: 2.0005,
      durationSec: 3,
    })!.id;
  });
  act(() => useDirectorCreativeWorkspaceStore.getState().setClipTransition(clipId, 1.5));
  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, clipId)?.clip.transitionInSec).toBe(1.5);
});

it("clamps transitionInSec through updateClip like other numeric clip fields", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:patched",
      name: "Patched",
      startSec: 0,
      durationSec: 4,
      transitionInSec: 99,
    })!.id;
  });
  expect(
    findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clipId)?.clip.transitionInSec,
  ).toBe(4);
  act(() => useDirectorCreativeWorkspaceStore.getState().updateClip(clipId, { transitionInSec: -3 }));
  expect(
    findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clipId)?.clip.transitionInSec,
  ).toBe(0);
  act(() => useDirectorCreativeWorkspaceStore.getState().updateClip(clipId, { transitionInSec: 2.5 }));
  expect(
    findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clipId)?.clip.transitionInSec,
  ).toBe(2.5);
});

it("keeps the transition on the left half of a split and resets the right half", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    store.addClip({ trackId: "video-1", mediaId: "shot:prev", name: "Prev", startSec: 0, durationSec: 2 });
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:split",
      name: "Split",
      startSec: 2,
      durationSec: 4,
      sourceDurationSec: 8,
    })!.id;
  });
  act(() => useDirectorCreativeWorkspaceStore.getState().setClipTransition(clipId, 1.5));
  let rightId = "";
  act(() => {
    rightId = useDirectorCreativeWorkspaceStore.getState().splitClip(clipId, 4)!.id;
  });
  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, clipId)?.clip).toMatchObject({ durationSec: 2, transitionInSec: 1.5 });
  expect(findDirectorEditClip(state.editTracks, rightId)?.clip).toMatchObject({ startSec: 4, transitionInSec: 0 });
});

it("finds the transition predecessor by edge adjacency within tolerance", () => {
  const track: DirectorEditTrack = {
    id: "video-x",
    name: "Video X",
    kind: "video",
    muted: false,
    locked: false,
    visible: true,
    clips: [
      overwriteClip({ id: "first", startSec: 0, durationSec: 2 }),
      overwriteClip({ id: "second", startSec: 2.0008, durationSec: 2 }),
      overwriteClip({ id: "island", startSec: 6, durationSec: 1 }),
    ],
  };
  expect(findDirectorTransitionPredecessor(track, "second")?.id).toBe("first");
  expect(findDirectorTransitionPredecessor(track, "island")).toBeNull();
  expect(findDirectorTransitionPredecessor(track, "first")).toBeNull();
  expect(findDirectorTransitionPredecessor(track, "missing")).toBeNull();
});

it("overwrite resolution truncates a tail overlap and shrinks its fade-out", () => {
  const clips = [
    overwriteClip({ id: "under", startSec: 0, durationSec: 4, fadeOutSec: 3 }),
    overwriteClip({ id: "landed", startSec: 2, durationSec: 4 }),
  ];
  const resolved = resolveDirectorTrackOverwrite(clips, "landed")!;
  expect(resolved.map((clip) => clip.id)).toEqual(["under", "landed"]);
  expect(resolved[0]!.durationSec).toBeCloseTo(2, 10);
  expect(resolved[0]!.fadeOutSec).toBeCloseTo(2, 10);
  expect(resolved[1]).toBe(clips[1]);
  expect(summarizeDirectorTrackOverwrite(clips, resolved, "landed")).toEqual({
    removedClipIds: [],
    trimmedClipIds: ["under"],
    createdClipIds: [],
  });
});

it("summarizeDirectorTrackOverwrite reports removed and split-created neighbours", () => {
  const covered = [
    overwriteClip({ id: "gone", startSec: 1, durationSec: 2 }),
    overwriteClip({ id: "landed", startSec: 0, durationSec: 4 }),
  ];
  const coveredResolved = resolveDirectorTrackOverwrite(covered, "landed")!;
  expect(summarizeDirectorTrackOverwrite(covered, coveredResolved, "landed")).toEqual({
    removedClipIds: ["gone"],
    trimmedClipIds: [],
    createdClipIds: [],
  });

  const spanning = [
    overwriteClip({ id: "span", startSec: 0, durationSec: 8, sourceDurationSec: 20 }),
    overwriteClip({ id: "landed", startSec: 3, durationSec: 2 }),
  ];
  const spanningResolved = resolveDirectorTrackOverwrite(spanning, "landed")!;
  const summary = summarizeDirectorTrackOverwrite(spanning, spanningResolved, "landed");
  expect(summary.removedClipIds).toEqual([]);
  expect(summary.trimmedClipIds).toEqual(["span"]);
  expect(summary.createdClipIds).toHaveLength(1);
  expect(summarizeDirectorTrackOverwrite(spanning, null, "landed")).toEqual({
    removedClipIds: [],
    trimmedClipIds: [],
    createdClipIds: [],
  });
});

it("overwrite resolution trims head overlaps and advances inSec by playback rate", () => {
  const clips = [
    overwriteClip({ id: "landed", startSec: 2, durationSec: 4 }),
    overwriteClip({ id: "normal-rate", startSec: 4, durationSec: 4, inSec: 1, fadeInSec: 1, sourceDurationSec: 10 }),
    overwriteClip({
      id: "double-rate",
      startSec: 5,
      durationSec: 4,
      inSec: 0.5,
      playbackRate: 2,
      fadeInSec: 0.8,
      sourceDurationSec: 20,
    }),
  ];
  const resolved = resolveDirectorTrackOverwrite(clips, "landed")!;
  expect(resolved.find((clip) => clip.id === "normal-rate")).toMatchObject({
    startSec: 6,
    durationSec: 2,
    inSec: 3,
    fadeInSec: 0,
  });
  expect(resolved.find((clip) => clip.id === "double-rate")).toMatchObject({
    startSec: 6,
    durationSec: 3,
    inSec: 2.5,
    fadeInSec: 0,
    playbackRate: 2,
  });
});

it("overwrite resolution removes covered clips and sub-minimum fragments", () => {
  const clips = [
    overwriteClip({ id: "covered", startSec: 3, durationSec: 2 }),
    overwriteClip({ id: "fragment", startSec: 1.95, durationSec: 2 }),
    overwriteClip({ id: "landed", startSec: 2, durationSec: 4 }),
  ];
  const resolved = resolveDirectorTrackOverwrite(clips, "landed")!;
  expect(resolved.map((clip) => clip.id)).toEqual(["landed"]);
});

it("overwrite resolution splits a spanning clip into source-contiguous halves", () => {
  const clips = [
    overwriteClip({
      id: "span",
      startSec: 0,
      durationSec: 10,
      inSec: 2,
      sourceDurationSec: 20,
      fadeInSec: 0.5,
      fadeOutSec: 0.7,
    }),
    overwriteClip({ id: "landed", startSec: 3, durationSec: 3 }),
  ];
  const resolved = resolveDirectorTrackOverwrite(clips, "landed")!;
  expect(resolved).toHaveLength(3);
  const [left, right, landed] = resolved;
  expect(landed?.id).toBe("landed");
  expect(left).toMatchObject({ id: "span", startSec: 0, durationSec: 3, inSec: 2, fadeInSec: 0.5, fadeOutSec: 0 });
  expect(right?.id).not.toBe("span");
  expect(right?.id).not.toBe("landed");
  expect(right).toMatchObject({
    startSec: 6,
    durationSec: 4,
    inSec: 8,
    fadeInSec: 0,
    fadeOutSec: 0.7,
    mediaId: "media:overwrite",
  });
});

it("overwrite resolution returns null for edge contact or a missing landed clip", () => {
  const clips = [
    overwriteClip({ id: "before", startSec: 0, durationSec: 2 }),
    overwriteClip({ id: "landed", startSec: 2, durationSec: 4 }),
    overwriteClip({ id: "after", startSec: 5.9999999, durationSec: 2 }),
  ];
  expect(resolveDirectorTrackOverwrite(clips, "landed")).toBeNull();
  expect(resolveDirectorTrackOverwrite(clips, "missing")).toBeNull();
});

it("commitClipPlacement overwrites same-track overlaps as one undoable step", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let underId = "";
  let landedId = "";
  act(() => {
    underId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:under",
      name: "Under",
      startSec: 0,
      durationSec: 4,
      sourceDurationSec: 8,
    })!.id;
    landedId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:landed",
      name: "Landed",
      startSec: 2,
      durationSec: 4,
      sourceDurationSec: 8,
    })!.id;
  });
  act(() => useDirectorCreativeWorkspaceStore.getState().commitClipPlacement(landedId));

  let state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, underId)?.clip.durationSec).toBeCloseTo(2, 10);
  expect(findDirectorEditClip(state.editTracks, landedId)?.clip).toMatchObject({ startSec: 2, durationSec: 4 });

  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, underId)?.clip.durationSec).toBe(4);
  expect(findDirectorEditClip(state.editTracks, landedId)?.clip.startSec).toBe(2);
});

it("commitClipPlacement clears removed selections and records no history when nothing overlaps", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let coveredId = "";
  let landedId = "";
  act(() => {
    coveredId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:covered",
      name: "Covered",
      startSec: 1,
      durationSec: 2,
    })!.id;
    landedId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:landed",
      name: "Landed",
      startSec: 0,
      durationSec: 4,
    })!.id;
    store.selectClip(coveredId);
  });
  act(() => useDirectorCreativeWorkspaceStore.getState().commitClipPlacement(landedId));
  let state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, coveredId)).toBeNull();
  expect(state.selectedClipId).toBeNull();

  // The second commit finds no overlap, so the next undo must revert the
  // overwrite itself rather than an extra no-op history entry.
  act(() => useDirectorCreativeWorkspaceStore.getState().commitClipPlacement(landedId));
  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, coveredId)?.clip).toMatchObject({ startSec: 1, durationSec: 2 });
});

it("merges commitClipPlacement into an enclosing history batch as one undo step", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let underId = "";
  let landedId = "";
  act(() => {
    underId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:under",
      name: "Under",
      startSec: 0,
      durationSec: 4,
      sourceDurationSec: 8,
    })!.id;
    landedId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:landed",
      name: "Landed",
      startSec: 6,
      durationSec: 4,
      sourceDurationSec: 8,
    })!.id;
  });
  act(() => {
    const live = useDirectorCreativeWorkspaceStore.getState();
    live.beginHistoryBatch();
    live.updateClip(landedId, { startSec: 2 });
    live.commitClipPlacement(landedId);
    live.endHistoryBatch();
  });
  let state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, landedId)?.clip.startSec).toBe(2);
  expect(findDirectorEditClip(state.editTracks, underId)?.clip.durationSec).toBeCloseTo(2, 10);

  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, landedId)?.clip.startSec).toBe(6);
  expect(findDirectorEditClip(state.editTracks, underId)?.clip.durationSec).toBe(4);
});

it("commitClipPlacement and rippleRemoveClip ignore locked tracks", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let underId = "";
  let landedId = "";
  act(() => {
    underId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:under",
      name: "Under",
      startSec: 0,
      durationSec: 4,
    })!.id;
    landedId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:landed",
      name: "Landed",
      startSec: 2,
      durationSec: 4,
    })!.id;
    store.toggleTrackLock("video-1");
  });
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().commitClipPlacement(landedId);
    useDirectorCreativeWorkspaceStore.getState().rippleRemoveClip(underId);
  });
  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, underId)?.clip.durationSec).toBe(4);
  expect(findDirectorEditClip(state.editTracks, landedId)?.clip).toMatchObject({ startSec: 2, durationSec: 4 });
});

it("rippleRemoveClip closes the gap on its own track only", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let earlierId = "";
  let removedId = "";
  let laterId = "";
  let otherTrackId = "";
  act(() => {
    earlierId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:earlier",
      name: "Earlier",
      startSec: 0,
      durationSec: 2,
    })!.id;
    removedId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:removed",
      name: "Removed",
      startSec: 3,
      durationSec: 2,
    })!.id;
    laterId = store.addClip({
      trackId: "video-1",
      mediaId: "shot:later",
      name: "Later",
      startSec: 6,
      durationSec: 1,
    })!.id;
    otherTrackId = store.addClip({
      trackId: "video-2",
      mediaId: "shot:other",
      name: "Other",
      startSec: 10,
      durationSec: 2,
    })!.id;
    store.selectClip(removedId);
  });
  act(() => useDirectorCreativeWorkspaceStore.getState().rippleRemoveClip(removedId));

  let state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, removedId)).toBeNull();
  expect(findDirectorEditClip(state.editTracks, earlierId)?.clip.startSec).toBe(0);
  expect(findDirectorEditClip(state.editTracks, laterId)?.clip.startSec).toBe(4);
  expect(findDirectorEditClip(state.editTracks, otherTrackId)?.clip.startSec).toBe(10);
  expect(state.selectedClipId).toBeNull();

  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  state = useDirectorCreativeWorkspaceStore.getState();
  expect(findDirectorEditClip(state.editTracks, removedId)?.clip.startSec).toBe(3);
  expect(findDirectorEditClip(state.editTracks, laterId)?.clip.startSec).toBe(6);
});

it("does not let incomplete or malformed persistence replace required defaults", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    expect(parseDirectorCreativeWorkspacePersistedState('{"version":1,"state":{}}')).toEqual({});
    expect(
      parseDirectorCreativeWorkspacePersistedState('{"version":1,"state":{"boardNodes":"broken","editTracks":null}}'),
    ).toEqual({});
    expect(parseDirectorCreativeWorkspacePersistedState("not-json")).toEqual({});
  } finally {
    warn.mockRestore();
  }
});

it("recovers a legacy-shaped track from a v2 document instead of rejecting everything", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const restored = parseDirectorCreativeWorkspacePersistedState(
      '{"version":2,"state":{"editTracks":[{"id":"video-1","name":"Video","kind":"video","muted":false,"locked":false,"clips":[]}],"playheadSec":2.5}}',
    );
    expect(restored.editTracks).toEqual([
      expect.objectContaining({ id: "video-1", name: "Video", visible: true, clips: [] }),
    ]);
    expect(restored.playheadSec).toBe(2.5);
  } finally {
    warn.mockRestore();
  }
});

it("drops only the corrupt clip during recovery and keeps all other slices intact", () => {
  let nodeId = "";
  let goodClipId = "";
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    nodeId = store.addBoardNode({ kind: "shot", title: "Survivor", x: 10, y: 20 })!.id;
    goodClipId = store.addClip({
      trackId: "video-1",
      mediaId: "recording:good",
      name: "Good",
      startSec: 0,
      durationSec: 2,
    })!.id;
    store.addClip({
      trackId: "video-1",
      mediaId: "recording:bad",
      name: "Bad",
      startSec: 3,
      durationSec: 2,
    });
    store.setPlayhead(1.5);
  });
  const document = JSON.parse(
    serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState()),
  ) as { state: { editTracks: Array<{ id: string; clips: Array<{ name: string; durationSec: unknown }> }> } };
  const track = document.state.editTracks.find((item) => item.id === "video-1")!;
  track.clips.find((clip) => clip.name === "Bad")!.durationSec = "broken";

  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const restored = parseDirectorCreativeWorkspacePersistedState(JSON.stringify(document));
    expect(restored.boardNodes).toEqual([expect.objectContaining({ id: nodeId, title: "Survivor" })]);
    expect(restored.playheadSec).toBe(1.5);
    const clips = restored.editTracks?.find((item) => item.id === "video-1")?.clips ?? [];
    expect(clips.map((clip) => clip.id)).toEqual([goodClipId]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("editTracks.video-1.clips"));
  } finally {
    warn.mockRestore();
  }
});

it("backs up a corrupt persisted document to one timestamped recovery key", () => {
  const marker = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const corrupt = `{"version":4,"state":{"boardNodes":"broken-${marker}"}}`;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    parseDirectorCreativeWorkspacePersistedState(corrupt);
    const keys = recoveryKeysHolding(corrupt);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^director\.creative-workspaces\.recovery\.\d{4}-\d{2}-\d{2}T/);
    parseDirectorCreativeWorkspacePersistedState(corrupt);
    expect(recoveryKeysHolding(corrupt)).toHaveLength(1);
  } finally {
    warn.mockRestore();
  }
});

it("accepts feature-length clips whose source exceeds one hour", () => {
  const restored = parseDirectorCreativeWorkspacePersistedState(
    JSON.stringify({
      version: 4,
      state: {
        editTracks: [
          {
            id: "video-1",
            name: "Long form",
            kind: "video",
            muted: false,
            locked: false,
            visible: true,
            clips: [
              {
                id: "clip-feature",
                mediaId: "media:film",
                name: "Feature",
                startSec: 0,
                durationSec: 5_400,
                inSec: 0,
                sourceDurationSec: 5_400,
                opacity: 1,
                volume: 1,
                playbackRate: 1,
                fadeInSec: 0,
                fadeOutSec: 0,
                scale: 1,
                positionX: 0,
                positionY: 0,
                rotationDeg: 0,
                fit: "contain",
              },
            ],
          },
        ],
      },
    }),
  );
  // The pre-transition document omits transitionInSec; normalization
  // resolves it to 0 instead of rejecting the clip.
  expect(restored.editTracks?.[0]?.clips[0]).toMatchObject({
    durationSec: 5_400,
    sourceDurationSec: 5_400,
    transitionInSec: 0,
  });
});

it("round-trips a clip transition through v4 persistence", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    store.addClip({ trackId: "video-1", mediaId: "shot:prev", name: "Prev", startSec: 0, durationSec: 3 });
    clipId = store.addClip({ trackId: "video-1", mediaId: "shot:next", name: "Next", startSec: 3, durationSec: 3 })!.id;
    useDirectorCreativeWorkspaceStore.getState().setClipTransition(clipId, 1.25);
  });
  const restored = parseDirectorCreativeWorkspacePersistedState(
    serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState()),
  );
  const clips = restored.editTracks?.find((track) => track.id === "video-1")?.clips ?? [];
  expect(clips.find((clip) => clip.id === clipId)?.transitionInSec).toBe(1.25);
});

it("clamps out-of-range clip timing on load instead of dropping the clip", () => {
  const baseClip = {
    mediaId: "media:clamped",
    startSec: 0,
    opacity: 1,
    volume: 1,
    fadeInSec: 0,
    fadeOutSec: 0,
    scale: 1,
    positionX: 0,
    positionY: 0,
    rotationDeg: 0,
    fit: "contain",
  };
  const restored = parseDirectorCreativeWorkspacePersistedState(
    JSON.stringify({
      version: 4,
      state: {
        editTracks: [
          {
            id: "video-1",
            name: "Clamped",
            kind: "video",
            muted: false,
            locked: false,
            visible: true,
            clips: [
              {
                ...baseClip,
                id: "clip-float-error",
                name: "Float error",
                durationSec: 3.0000000000000004,
                inSec: 2,
                sourceDurationSec: 8,
                playbackRate: 2,
              },
              {
                ...baseClip,
                id: "clip-overshoot",
                name: "Overshoot",
                durationSec: 5,
                inSec: 9.9,
                sourceDurationSec: 10,
                playbackRate: 4,
              },
            ],
          },
        ],
      },
    }),
  );
  const clips = restored.editTracks?.[0]?.clips ?? [];
  expect(clips).toHaveLength(2);
  const floatError = clips.find((clip) => clip.id === "clip-float-error")!;
  expect(floatError.durationSec).toBeCloseTo(3, 10);
  const overshoot = clips.find((clip) => clip.id === "clip-overshoot")!;
  expect(overshoot.inSec + overshoot.durationSec * overshoot.playbackRate).toBeLessThanOrEqual(
    overshoot.sourceDurationSec,
  );
  expect(overshoot.durationSec).toBeGreaterThanOrEqual(0.1);
});

it("migrates v1 tracks and clips to complete v2 runtime defaults", () => {
  const migrated = parseDirectorCreativeWorkspacePersistedState(
    JSON.stringify({
      version: 1,
      state: {
        editTracks: [
          {
            id: "audio-legacy",
            name: "Legacy audio",
            kind: "audio",
            muted: false,
            locked: false,
            clips: [
              {
                id: "legacy-clip",
                mediaId: "audio:legacy",
                name: "Legacy clip",
                startSec: 2,
                durationSec: 4,
                inSec: 0,
                sourceDurationSec: 4,
                opacity: 1,
                volume: 0.8,
              },
            ],
          },
        ],
        playheadSec: 3.25,
      },
    }),
  );

  expect(migrated.playheadSec).toBe(3.25);
  expect(migrated.editTracks?.some((track) => track.kind === "video")).toBe(true);
  expect(migrated.editTracks?.find((track) => track.id === "audio-legacy")).toMatchObject({ visible: true });
  expect(migrated.editTracks?.[0]?.clips[0]).toMatchObject({
    fadeInSec: 0,
    fadeOutSec: 0,
    transitionInSec: 0,
    scale: 1,
    positionX: 0,
    positionY: 0,
    rotationDeg: 0,
    fit: "contain",
  });
});

it("writes v4 persistence with playhead and edit settings and accepts audio canvas nodes", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let audioNodeId = "";
  act(() => {
    audioNodeId = store.addBoardNode({ kind: "audio", title: "Voice over", mediaId: "audio:voice", x: 10, y: 20 })!.id;
    store.setPlayhead(7.5);
    store.updateEditSettings({ aspectRatio: "9 / 16", fps: 30, snapEnabled: false, exportQuality: "full" });
  });

  const serialized = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
  expect(JSON.parse(serialized)).toMatchObject({
    version: 4,
    state: {
      playheadSec: 7.5,
      editSettings: { aspectRatio: "9 / 16", fps: 30, snapEnabled: false, exportQuality: "full" },
      workspacePrefs: { autoSendToTimeline: false },
    },
  });
  const parsed = parseDirectorCreativeWorkspacePersistedState(serialized);
  expect(parsed.editSettings).toEqual({
    aspectRatio: "9 / 16",
    fps: 30,
    timebase: {
      rate: { numerator: 30, denominator: 1 },
      dropFrame: false,
      startTimecode: "00:00:00:00",
    },
    snapEnabled: false,
    exportQuality: "full",
  });
  expect(parsed.boardNodes?.find((node) => node.id === audioNodeId)?.kind).toBe("audio");
});

it("persists Canvas production configuration, output lineage, and graph-run receipts", () => {
  const timestamp = "2026-08-07T00:00:00.000Z";
  const fingerprint = `sha256:${"a".repeat(64)}`;
  let nodeId = "";
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    nodeId = store.addBoardNode({ kind: "image", title: "Pipeline image", body: "cinematic frame", x: 10, y: 20 })!.id;
    store.updateBoardNode(nodeId, {
      productionConfig: {
        workflowId: "comfy-workflow-canvas-image",
        nodeIds: ["gpu-a"],
        negativePrompt: "blur",
        seed: 7,
        durationSeconds: 5,
        fps: 24,
        audioMode: "sound-effect",
        sampleRate: 48_000,
        voice: "",
        language: "",
        parameters: { steps: 24 },
      },
    });
    store.appendBoardNodeProductionOutput(nodeId, {
      runId: "canvas-run-persisted",
      requestFingerprint: fingerprint,
      status: "succeeded",
      jobId: "job-persisted",
      artifactId: "artifact-persisted",
      mediaId: "creative-media:image:persisted",
      workflowId: "comfy-workflow-canvas-image",
      nodeId: "gpu-a",
      createdAt: timestamp,
      error: null,
    });
    store.upsertBoardPipelineRun({
      version: 1,
      id: "canvas-run-persisted",
      graphFingerprint: fingerprint,
      status: "succeeded",
      startedAt: timestamp,
      updatedAt: timestamp,
      finishedAt: timestamp,
      nodeRuns: [
        {
          nodeId,
          status: "succeeded",
          requestFingerprint: fingerprint,
          jobId: "job-persisted",
          artifactId: "artifact-persisted",
          mediaId: "creative-media:image:persisted",
          startedAt: timestamp,
          finishedAt: timestamp,
          error: null,
        },
      ],
      error: null,
    });
  });

  const restored = parseDirectorCreativeWorkspacePersistedState(
    serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState()),
  );
  expect(restored.boardNodes?.find((node) => node.id === nodeId)).toMatchObject({
    productionConfig: { workflowId: "comfy-workflow-canvas-image", nodeIds: ["gpu-a"], parameters: { steps: 24 } },
    productionHistory: [expect.objectContaining({ jobId: "job-persisted", mediaId: "creative-media:image:persisted" })],
  });
  expect(restored.boardPipelineRuns).toEqual([
    expect.objectContaining({ id: "canvas-run-persisted", status: "succeeded" }),
  ]);
});

it("keeps clip source ranges valid and rejects edits on locked tracks", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let clipId = "";
  act(() => {
    clipId = store.addClip({
      trackId: "video-1",
      mediaId: "recording:bounded",
      name: "Bounded",
      startSec: 1,
      durationSec: 3,
      sourceDurationSec: 10,
    })!.id;
    store.updateClip(clipId, { inSec: 5, durationSec: 10 });
  });
  expect(findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clipId)?.clip).toMatchObject({
    inSec: 5,
    durationSec: 5,
  });

  act(() => useDirectorCreativeWorkspaceStore.getState().toggleTrackLock("video-1"));
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().updateClip(clipId, { startSec: 8 });
    useDirectorCreativeWorkspaceStore.getState().moveClipToTrack(clipId, "video-2", 9);
    useDirectorCreativeWorkspaceStore.getState().removeClip(clipId);
  });
  const locked = findDirectorEditClip(useDirectorCreativeWorkspaceStore.getState().editTracks, clipId);
  expect(locked?.track.id).toBe("video-1");
  expect(locked?.clip.startSec).toBe(1);
});

it("undoes and redoes a batched gesture as one history step", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let nodeId = "";
  act(() => {
    nodeId = store.addBoardNode({ kind: "note", title: "Gesture", x: 10, y: 20 })!.id;
  });
  const afterAdd = useDirectorCreativeWorkspaceStore.getState();
  expect(afterAdd.canUndo).toBe(true);

  act(() => {
    afterAdd.beginHistoryBatch();
    afterAdd.updateBoardNode(nodeId, { x: 30 });
    afterAdd.updateBoardNode(nodeId, { x: 60 });
    afterAdd.updateBoardNode(nodeId, { x: 90 });
    afterAdd.endHistoryBatch();
  });
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.find((node) => node.id === nodeId)?.x).toBe(90);

  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.find((node) => node.id === nodeId)?.x).toBe(10);
  expect(useDirectorCreativeWorkspaceStore.getState().canRedo).toBe(true);

  act(() => useDirectorCreativeWorkspaceStore.getState().redo());
  expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.find((node) => node.id === nodeId)?.x).toBe(90);
});

it("restores exact Canvas and Video selections when an Agent batch rolls back", () => {
  let initialBoardId = "";
  let initialClipId = "";
  let temporaryBoardId = "";
  let temporaryClipId = "";

  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    initialBoardId = store.addBoardNode({ kind: "note", title: "Baseline", x: 40, y: 40 })!.id;
    initialClipId = store.addClip({
      trackId: "video-1",
      mediaId: "recording:baseline",
      name: "Baseline",
      startSec: 0,
      durationSec: 2,
    })!.id;
    store.selectBoardNode(initialBoardId);
    store.selectClip(initialClipId);
    store.beginHistoryBatch();
    temporaryBoardId = store.addBoardNode({ kind: "note", title: "Temporary", x: 320, y: 200 })!.id;
    temporaryClipId = store.addClip({
      trackId: "video-2",
      mediaId: "recording:temporary",
      name: "Temporary",
      startSec: 3,
      durationSec: 2,
    })!.id;
    store.rollbackHistoryBatch();
  });

  const restored = useDirectorCreativeWorkspaceStore.getState();
  expect(restored.selectedBoardNodeId).toBe(initialBoardId);
  expect(restored.selectedClipId).toBe(initialClipId);
  expect(restored.boardNodes.some((node) => node.id === temporaryBoardId)).toBe(false);
  expect(findDirectorEditClip(restored.editTracks, temporaryClipId)).toBeNull();
});

it("manages track visibility and preserves at least one video track", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let addedTrackId = "";
  act(() => {
    store.toggleTrackVisibility("video-1");
    store.renameTrack("video-1", "Main picture");
    addedTrackId = store.addTrack("audio", "Dialogue")!.id;
    store.removeTrack("video-2");
    store.removeTrack("video-1");
  });

  const state = useDirectorCreativeWorkspaceStore.getState();
  expect(state.editTracks.find((track) => track.id === "video-1")).toMatchObject({
    name: "Main picture",
    visible: false,
  });
  expect(state.editTracks.find((track) => track.id === addedTrackId)).toMatchObject({
    name: "Dialogue",
    kind: "audio",
    visible: true,
  });
  expect(state.editTracks.filter((track) => track.kind === "video")).toHaveLength(1);
});

it("includes edit settings in undo and redo history", () => {
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().updateEditSettings({ aspectRatio: "1 / 1", fps: 30 });
  });
  expect(useDirectorCreativeWorkspaceStore.getState().editSettings).toMatchObject({ aspectRatio: "1 / 1", fps: 30 });

  act(() => useDirectorCreativeWorkspaceStore.getState().undo());
  expect(useDirectorCreativeWorkspaceStore.getState().editSettings).toMatchObject({ aspectRatio: "16 / 9", fps: 24 });

  act(() => useDirectorCreativeWorkspaceStore.getState().redo());
  expect(useDirectorCreativeWorkspaceStore.getState().editSettings).toMatchObject({ aspectRatio: "1 / 1", fps: 30 });
});

it("loads a validated creative document while preserving ids and clearing history", () => {
  const store = useDirectorCreativeWorkspaceStore.getState();
  let firstId = "";
  let secondId = "";
  act(() => {
    firstId = store.addBoardNode({ kind: "shot", title: "One", x: 20, y: 30 })!.id;
    secondId = store.addBoardNode({ kind: "video", title: "Two", x: 320, y: 30 })!.id;
    store.addBoardEdge(firstId, secondId);
  });
  const serialized = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());

  act(() => useDirectorCreativeWorkspaceStore.getState().removeBoardNode(firstId));
  let loaded = false;
  act(() => {
    loaded = useDirectorCreativeWorkspaceStore.getState().loadCreativeWorkspace(serialized);
  });

  const restored = useDirectorCreativeWorkspaceStore.getState();
  expect(loaded).toBe(true);
  expect(restored.boardNodes.some((node) => node.id === firstId)).toBe(true);
  expect(restored.boardEdges).toEqual([expect.objectContaining({ sourceNodeId: firstId, targetNodeId: secondId })]);
  expect(restored.canUndo).toBe(false);
  expect(restored.canRedo).toBe(false);
  expect(restored.loadCreativeWorkspace("broken-json")).toBe(false);
});

it("persists board sections and workspace prefs in v4 documents", () => {
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    store.addBoardSection({ title: "Story beats", x: 40, y: 40 });
    store.updateWorkspacePrefs({ autoSendToTimeline: true });
  });
  const serialized = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
  expect(JSON.parse(serialized).version).toBe(4);
  const restored = parseDirectorCreativeWorkspacePersistedState(serialized);
  expect(restored.boardSections?.some((section) => section.title === "Story beats")).toBe(true);
  expect(restored.workspacePrefs).toMatchObject({ autoSendToTimeline: true });
});

it("persists project-scoped Gallery folders, reviews, trash, and view preferences", () => {
  let selectsFolderId = "";
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    selectsFolderId = store.createGalleryFolder("Selects")!.id;
    store.updateGalleryMedia("capture:hero", {
      rating: 5,
      tags: ["hero", "night"],
      color: "green",
      customName: "Hero Select",
      folderId: selectsFolderId,
    });
    store.trashGalleryMedia(["capture:outtake"], "2026-08-07T00:00:00.000Z");
    store.updateGalleryPrefs({ viewMode: "masonry", activeFolderId: selectsFolderId, thumbnailSize: 240 });
  });

  const serialized = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
  const restored = parseDirectorCreativeWorkspacePersistedState(serialized);
  expect(restored.galleryFolders).toEqual([expect.objectContaining({ id: selectsFolderId, name: "Selects" })]);
  expect(restored.galleryMedia).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        mediaId: "capture:hero",
        rating: 5,
        tags: ["hero", "night"],
        color: "green",
        folderId: selectsFolderId,
        addedAt: expect.any(String),
      }),
      expect.objectContaining({
        mediaId: "capture:outtake",
        addedAt: "2026-08-07T00:00:00.000Z",
        trashedAt: "2026-08-07T00:00:00.000Z",
      }),
    ]),
  );
  expect(restored.galleryPrefs).toMatchObject({
    viewMode: "masonry",
    activeFolderId: selectsFolderId,
    thumbnailSize: 240,
  });
});

it("assigns legacy nodes to sections on load and applies script plans", () => {
  act(() => {
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });
  let sectionId = "";
  let nodeId = "";
  act(() => {
    const live = useDirectorCreativeWorkspaceStore.getState();
    sectionId = live.addBoardSection({ x: 80, y: 72, title: "角色设计", kind: "character" })!.id;
    nodeId = live.addBoardNode({
      kind: "note",
      title: "Legacy node",
      body: "Before migration",
      x: 120,
      y: 120,
    })!.id;
    const section = useDirectorCreativeWorkspaceStore.getState().boardSections[0]!;
    live.updateBoardNode(nodeId, {
      sectionId: null,
      x: section.x + 40,
      y: section.y + 40,
    });
  });
  const serialized = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
  const restored = parseDirectorCreativeWorkspacePersistedState(serialized);
  expect(restored.boardNodes?.[0]?.sectionId).toBe(sectionId);

  act(() => {
    const live = useDirectorCreativeWorkspaceStore.getState();
    live.applyScriptCanvasPlan({
      sections: live.boardSections.map((section) => ({ ...section, title: `${section.title} plan` })),
      nodes: [
        {
          beatId: "beat-1",
          kind: "note",
          title: "Imported beat",
          body: "From script",
          mediaId: null,
          sectionId,
          x: 120,
          y: 120,
          width: 280,
          height: 156,
          accent: "#29d6ff",
          productionJobId: null,
          productionJobStatus: null,
        },
      ],
      storyboardShotCount: 1,
      warnings: [],
      omitted: [],
    });
  });
  const next = useDirectorCreativeWorkspaceStore.getState();
  expect(next.boardSections[0]?.title.endsWith("plan")).toBe(true);
  expect(next.boardNodes.some((node) => node.title === "Imported beat")).toBe(true);
});

it("isolates and restores canvas and video state across project scopes", async () => {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scopeA = `scene-a-${suffix}`;
  const scopeB = `scene-b-${suffix}`;
  const keyA = `director.creative-workspaces.v2.${scopeA}`;
  const keyB = `director.creative-workspaces.v2.${scopeB}`;
  window.localStorage.removeItem(keyA);
  window.localStorage.removeItem(keyB);

  try {
    act(() => {
      useDirectorCreativeWorkspaceStore.getState().addBoardNode({ kind: "note", title: "Local only", x: 20, y: 30 });
      setDirectorCreativeWorkspaceScope(scopeA);
    });
    let clipAId = "";
    act(() => {
      const store = useDirectorCreativeWorkspaceStore.getState();
      store.addBoardNode({ kind: "shot", title: "Scene A board", x: 100, y: 120 });
      clipAId = store.addClip({
        trackId: "video-1",
        mediaId: "shot:scene-a",
        name: "Scene A clip",
        startSec: 3,
        durationSec: 5,
      })!.id;
      store.setPlayhead(4.5);
      store.updateEditSettings({ aspectRatio: "9 / 16", fps: 30 });
    });

    act(() => setDirectorCreativeWorkspaceScope(scopeB));
    let state = useDirectorCreativeWorkspaceStore.getState();
    expect(state.boardNodes.some((node) => node.title === "Scene A board")).toBe(false);
    expect(findDirectorEditClip(state.editTracks, clipAId)).toBeNull();
    expect(state.selectedBoardNodeId).toBeNull();
    expect(state.selectedClipId).toBeNull();
    expect(state.canUndo).toBe(false);

    act(() => {
      const store = useDirectorCreativeWorkspaceStore.getState();
      store.addBoardNode({ kind: "video", title: "Scene B board", x: 420, y: 120 });
      store.addClip({
        trackId: "video-1",
        mediaId: "shot:scene-b",
        name: "Scene B clip",
        startSec: 1,
        durationSec: 2,
      });
      store.setPlayhead(1.25);
    });

    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(parseDirectorCreativeWorkspacePersistedState(window.localStorage.getItem(keyA)).boardNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Scene A board" })]),
    );
    expect(parseDirectorCreativeWorkspacePersistedState(window.localStorage.getItem(keyB)).boardNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Scene B board" })]),
    );

    act(() => setDirectorCreativeWorkspaceScope(scopeA));
    state = useDirectorCreativeWorkspaceStore.getState();
    expect(state.boardNodes.some((node) => node.title === "Scene A board")).toBe(true);
    expect(state.boardNodes.some((node) => node.title === "Scene B board")).toBe(false);
    expect(findDirectorEditClip(state.editTracks, clipAId)?.clip.name).toBe("Scene A clip");
    expect(state.playheadSec).toBe(4.5);
    expect(state.editSettings).toMatchObject({ aspectRatio: "9 / 16", fps: 30 });
    expect(state.selectedBoardNodeId).toBeNull();
    expect(state.selectedClipId).toBeNull();
    expect(state.canUndo).toBe(false);

    act(() => setDirectorCreativeWorkspaceScope(scopeB));
    state = useDirectorCreativeWorkspaceStore.getState();
    expect(state.boardNodes.some((node) => node.title === "Scene B board")).toBe(true);
    expect(state.boardNodes.some((node) => node.title === "Scene A board")).toBe(false);
    expect(state.playheadSec).toBe(1.25);

    act(() => setDirectorCreativeWorkspaceScope(""));
    expect(useDirectorCreativeWorkspaceStore.getState().boardNodes.some((node) => node.title === "Local only")).toBe(
      true,
    );
  } finally {
    act(() => setDirectorCreativeWorkspaceScope(""));
    window.localStorage.removeItem(keyA);
    window.localStorage.removeItem(keyB);
  }
});

it("defers localStorage writes until the persistence debounce fires after a mutation burst", async () => {
  const scope = `persist-debounce-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const key = `director.creative-workspaces.v2.${scope}`;
  try {
    act(() => setDirectorCreativeWorkspaceScope(scope));
    expect(window.localStorage.getItem(key)).toBeNull();

    act(() => {
      const store = useDirectorCreativeWorkspaceStore.getState();
      store.addBoardNode({ kind: "video", title: "Debounce board", x: 12, y: 24 });
      for (let index = 0; index < 12; index += 1) {
        store.setPlayhead(index * 0.25);
      }
    });
    // High-frequency notifications must not serialize synchronously.
    expect(window.localStorage.getItem(key)).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(parseDirectorCreativeWorkspacePersistedState(window.localStorage.getItem(key)).boardNodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Debounce board" })]),
    );
    expect(parseDirectorCreativeWorkspacePersistedState(window.localStorage.getItem(key)).playheadSec).toBeCloseTo(
      2.75,
    );
  } finally {
    act(() => setDirectorCreativeWorkspaceScope(""));
    window.localStorage.removeItem(key);
  }
});
