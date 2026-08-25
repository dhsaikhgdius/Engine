import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectorMediaItem } from "../../../../src/comprehensive/editor/workspaces/directorMediaLibrary";
import {
  beginDirectorMediaDragSession,
  DIRECTOR_MEDIA_DRAG_TYPE,
  endDirectorMediaDragSession,
  serializeDirectorCreativeWorkspacePersistedState,
  setDirectorCreativeWorkspaceScope,
  useDirectorCreativeWorkspaceStore,
} from "../../../../src/comprehensive/editor/workspaces/directorWorkspaceStore";

const mediaLibraryMock = vi.hoisted(() => ({
  items: [] as DirectorMediaItem[],
  persist: vi.fn(),
}));

const mediaImportMocks = vi.hoisted(() => ({
  ensureWaveform: vi.fn(),
  getAsset: vi.fn(),
  importBlob: vi.fn(),
  importFile: vi.fn(),
  probe: vi.fn(),
  setPlaybackPreference: vi.fn(),
}));

vi.mock("../../../../src/comprehensive/i18n/language", () => ({
  useLanguage: () => ({ t: (value: string) => value }),
}));

vi.mock("../../../../src/comprehensive/editor/workspaces/directorMediaLibrary", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../../src/comprehensive/editor/workspaces/directorMediaLibrary")>();
  return {
    ...original,
    persistDirectorMediaItem: mediaLibraryMock.persist,
    useDirectorMediaLibrary: () => mediaLibraryMock.items,
  };
});

vi.mock("../../../../src/comprehensive/editor/media/creativeMediaProbe", () => ({
  probeCreativeMediaFile: mediaImportMocks.probe,
}));

vi.mock("../../../../src/comprehensive/editor/media/persistentCreativeMediaStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/media/persistentCreativeMediaStore")>();
  return {
    ...actual,
    persistentCreativeMediaLibrary: {
      ensureWaveform: mediaImportMocks.ensureWaveform,
      getAsset: mediaImportMocks.getAsset,
      importBlob: mediaImportMocks.importBlob,
      importFile: mediaImportMocks.importFile,
      setPlaybackPreference: mediaImportMocks.setPlaybackPreference,
    },
  };
});

const exportVideoMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/comprehensive/editor/workspaces/directorTimelineVideoExport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/workspaces/directorTimelineVideoExport")>();
  return {
    ...actual,
    exportDirectorTimelineVideo: exportVideoMock,
  };
});

const workspaceRenderProbe = vi.hoisted(() => vi.fn());

vi.mock("../../../../src/comprehensive/editor/workspaces/CreativeWorkspacePanelResizer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/comprehensive/editor/workspaces/CreativeWorkspacePanelResizer")>();
  function CreativeWorkspacePanelResizer(props: Parameters<typeof actual.CreativeWorkspacePanelResizer>[0]) {
    if (props.panel === "media") workspaceRenderProbe();
    return actual.CreativeWorkspacePanelResizer(props);
  }
  return { ...actual, CreativeWorkspacePanelResizer };
});

// The filmstrip pipeline needs real video decoding; feed the UI a ready strip.
vi.mock("../../../../src/comprehensive/editor/workspaces/clipFilmstrip", () => ({
  useDirectorClipFilmstrip: () => ({
    key: "test-strip",
    tiles: ["data:image/jpeg;base64,test"],
    complete: true,
  }),
}));

import {
  chooseDirectorRulerLabelInterval,
  computeDirectorActiveLayerSignature,
  computeDirectorTimelineWindow,
  magneticSnapDirectorTimelineSeconds,
  quantizeDirectorPlayheadForRender,
  snapDirectorTimelineSeconds,
  VideoEditorWorkspace,
} from "../../../../src/comprehensive/editor/workspaces/VideoEditorWorkspace";

const IMAGE: DirectorMediaItem = {
  id: "import:image",
  kind: "image",
  collection: "imports",
  name: "Reference still",
  subtitle: "1920 × 1080",
  thumbnailUrl: "data:image/png;base64,preview",
  sourceUrl: "data:image/png;base64,proxy",
  originalSourceUrl: "data:image/png;base64,source",
  durationSec: 3,
  cameraId: null,
  frameStart: null,
  frameEnd: null,
};

const VIDEO: DirectorMediaItem = {
  id: "import:video",
  kind: "video",
  collection: "imports",
  name: "Camera take",
  subtitle: "4.0s · video/mp4",
  thumbnailUrl: null,
  sourceUrl: "https://example.test/camera-take.mp4",
  durationSec: 4,
  cameraId: null,
  frameStart: null,
  frameEnd: null,
};

const AUDIO: DirectorMediaItem = {
  id: "import:audio",
  kind: "audio",
  collection: "imports",
  name: "Voice over",
  subtitle: "2.5s · audio/wav",
  thumbnailUrl: null,
  sourceUrl: "https://example.test/voice-over.wav",
  durationSec: 2.5,
  cameraId: null,
  frameStart: null,
  frameEnd: null,
};

const WAVEFORM = {
  version: 1 as const,
  durationSec: 4,
  sampleRate: 48_000,
  channelCount: 1,
  samplesPerPeak: 24_000,
  minPeaks: [-0.5, -0.25, -0.75, -0.4],
  maxPeaks: [0.5, 0.25, 0.75, 0.4],
};

function videoTrack(trackId = "video-1") {
  const track = useDirectorCreativeWorkspaceStore.getState().editTracks.find((item) => item.id === trackId);
  expect(track).toBeDefined();
  return track!;
}

function audioTrack(trackId = "audio-1") {
  const track = useDirectorCreativeWorkspaceStore.getState().editTracks.find((item) => item.id === trackId);
  expect(track).toBeDefined();
  return track!;
}

function mediaUploadInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[accept="image/*,video/*,audio/*"]');
  expect(input).not.toBeNull();
  return input!;
}

function projectUploadInput(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>('input[accept*=".director.zip"][accept*=".json"]');
  expect(input).not.toBeNull();
  return input!;
}

/**
 * jsdom never measures layout, so the timeline windowing falls back to an
 * unbounded window. These helpers give the scroll container a real width and
 * a scriptable scrollLeft so windowing tests can drive the viewport.
 */
function mockTimelineViewport(container: HTMLElement, width = 600) {
  const scroller = container.querySelector<HTMLDivElement>(".creative-timeline-scroll");
  expect(scroller).not.toBeNull();
  let scrollLeftValue = 0;
  Object.defineProperty(scroller!, "clientWidth", { configurable: true, get: () => width });
  Object.defineProperty(scroller!, "scrollLeft", {
    configurable: true,
    get: () => scrollLeftValue,
    set: (value: number) => {
      scrollLeftValue = value;
    },
  });
  Object.defineProperty(scroller!, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: 200,
      width,
      height: 200,
      toJSON: () => ({}),
    }),
  });
  return scroller!;
}

function addTimelineClipAt(name: string, startSec: number, durationSec = 3) {
  act(() => {
    const store = useDirectorCreativeWorkspaceStore.getState();
    store.addClip({
      trackId: "video-1",
      mediaId: IMAGE.id,
      name,
      startSec,
      durationSec,
      sourceDurationSec: 3600,
    });
    // addClip selects the new clip; clear it so windowing tests start from a
    // neutral state (selected clips bypass culling and echo in the inspector).
    useDirectorCreativeWorkspaceStore.getState().selectClip(null);
  });
}

/** Clip names mounted in the timeline itself, ignoring the inspector panel. */
function timelineClipNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll(".creative-timeline-clip strong")).map((node) => node.textContent ?? "");
}

/**
 * Park requestAnimationFrame so entering playback never advances the playhead
 * on its own; tests then drive the store with explicit setPlayhead calls.
 */
function mockAnimationFrames() {
  const queue: FrameRequestCallback[] = [];
  const raf = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    queue.push(callback);
    return queue.length;
  });
  const caf = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  return {
    queue,
    restore: () => {
      raf.mockRestore();
      caf.mockRestore();
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  act(() => {
    setDirectorCreativeWorkspaceScope("video-editor-ui-tests");
    useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces();
  });
  mediaLibraryMock.items = [IMAGE, VIDEO, AUDIO];
  mediaLibraryMock.persist.mockReset().mockImplementation(async (item: DirectorMediaItem) => item.id);
  mediaImportMocks.ensureWaveform.mockReset().mockResolvedValue(null);
  mediaImportMocks.getAsset.mockReset().mockReturnValue(null);
  mediaImportMocks.importBlob.mockReset().mockResolvedValue(undefined);
  mediaImportMocks.importFile.mockReset().mockImplementation(async (file: File) => ({ id: `imported:${file.name}` }));
  mediaImportMocks.probe.mockReset().mockImplementation(async (file: File) => ({
    kind: file.type.startsWith("image/") ? "image" : file.type.startsWith("video/") ? "video" : "audio",
    mimeType: file.type,
    width: file.type.startsWith("image/") ? 1920 : null,
    height: file.type.startsWith("image/") ? 1080 : null,
    durationSec: file.type.startsWith("image/") ? null : 2.5,
  }));
  mediaImportMocks.setPlaybackPreference.mockReset().mockResolvedValue(undefined);
  exportVideoMock.mockReset();
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("VideoEditorWorkspace", () => {
  it("snaps edits against a fractional NTSC frame duration without rounding the rate", () => {
    const fps = 30_000 / 1_001;
    expect(snapDirectorTimelineSeconds(1, fps)).toBeCloseTo(30 / fps, 9);
    expect(snapDirectorTimelineSeconds(1, fps, false)).toBe(1);
  });

  it("magnetically snaps to the nearest edge only inside the threshold", () => {
    expect(magneticSnapDirectorTimelineSeconds(3.94, [0, 4], 0.1)).toBe(4);
    expect(magneticSnapDirectorTimelineSeconds(0.05, [0, 4], 0.1)).toBe(0);
    expect(magneticSnapDirectorTimelineSeconds(3.7, [0, 4], 0.1)).toBeNull();
    expect(magneticSnapDirectorTimelineSeconds(2, [1.95, 2.04], 0.1)).toBe(2.04);
  });

  it("keeps ruler labels readable across the zoom range", () => {
    expect(chooseDirectorRulerLabelInterval(288)).toBe(1);
    expect(chooseDirectorRulerLabelInterval(72)).toBe(2);
    expect(chooseDirectorRulerLabelInterval(36)).toBe(5);
    expect(chooseDirectorRulerLabelInterval(0.4)).toBe(120);
  });

  it("resizes the video timeline from its top edge and keyboard separator", () => {
    const { container } = render(<VideoEditorWorkspace />);
    const main = container.querySelector<HTMLElement>(".creative-video-main");
    const timeline = screen.getByRole("region", { name: "视频时间线" });
    const resizer = screen.getByRole("separator", { name: "调整时间线高度" });
    expect(main).not.toBeNull();

    Object.defineProperty(main, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ height: 900 }),
    });
    Object.defineProperty(timeline, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ height: 320 }),
    });

    fireEvent.pointerDown(resizer, { button: 0, clientY: 500 });
    fireEvent.pointerMove(window, { clientY: 400 });
    fireEvent.pointerUp(window, { clientY: 400 });
    expect(main).toHaveStyle({ "--creative-timeline-height": "420px" });

    fireEvent.keyDown(resizer, { key: "Home" });
    expect(main).toHaveStyle({ "--creative-timeline-height": "238px" });
  });

  it("binds Space to playback without hijacking focused controls", () => {
    const frames = mockAnimationFrames();
    try {
      const { container } = render(<VideoEditorWorkspace />);

      // Hidden file inputs stay unfocusable so Space can never open a picker.
      for (const input of container.querySelectorAll('input[type="file"].sr-only')) {
        expect(input).toHaveAccessibleName();
        expect(input).toHaveAttribute("tabindex", "-1");
      }

      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
      fireEvent.keyDown(window, { code: "Space" });
      expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();

      fireEvent.keyDown(window, { key: " ", code: "Space" });
      expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();

      // A focused button keeps its native Space activation instead of toggling playback.
      const magnet = screen.getByRole("button", { name: "关闭磁吸" });
      magnet.focus();
      fireEvent.keyDown(magnet, { key: " ", code: "Space" });
      expect(screen.queryByRole("button", { name: "暂停" })).not.toBeInTheDocument();
    } finally {
      frames.restore();
    }
  });

  it("jumps the playhead to the end of the edited content", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));

    await user.click(screen.getByRole("button", { name: "跳到结尾" }));

    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBeCloseTo(4, 5);
  });

  it("keeps playing from the top when loop playback is enabled", async () => {
    const frames = mockAnimationFrames();
    try {
      const user = userEvent.setup();
      render(<VideoEditorWorkspace />);
      await user.click(screen.getByRole("button", { name: "添加 Camera take" }));

      const loopToggle = screen.getByRole("button", { name: "循环播放" });
      expect(loopToggle).toHaveAttribute("aria-pressed", "false");
      await user.click(loopToggle);
      expect(loopToggle).toHaveAttribute("aria-pressed", "true");

      await user.click(screen.getByRole("button", { name: "播放" }));
      expect(frames.queue.length).toBeGreaterThan(0);

      // Drive every parked frame far past the timeline end: with loop enabled
      // the playhead restarts at 0 and playback keeps running.
      act(() => {
        const pending = frames.queue.splice(0, frames.queue.length);
        pending.forEach((tick) => tick(performance.now() + 60_000));
      });

      expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
      expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBe(0);
    } finally {
      frames.restore();
    }
  });

  it("seeks by typing a SMPTE timecode into the transport readout", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));

    await user.click(screen.getByTitle(/点击输入时码跳转/));
    const input = screen.getByRole("textbox", { name: "输入时码跳转" });
    fireEvent.change(input, { target: { value: "00:00:02:12" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // 24fps timeline: 00:00:02:12 = 60 frames = 2.5s.
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBeCloseTo(2.5, 5);
    expect(screen.queryByRole("textbox", { name: "输入时码跳转" })).not.toBeInTheDocument();

    // Invalid input reverts without moving the playhead.
    await user.click(screen.getByTitle(/点击输入时码跳转/));
    const retry = screen.getByRole("textbox", { name: "输入时码跳转" });
    fireEvent.change(retry, { target: { value: "not-a-timecode" } });
    fireEvent.keyDown(retry, { key: "Enter" });
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBeCloseTo(2.5, 5);
  });

  it("fits the timeline zoom to the edited content", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    const fit = screen.getByRole("button", { name: "适配全片" });
    expect(fit).toBeDisabled();

    mockTimelineViewport(container, 600);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    expect(fit).toBeEnabled();
    await user.click(fit);

    // (600 - 16)px visible width ÷ (4s content × 72px per second).
    expect(useDirectorCreativeWorkspaceStore.getState().timelineZoom).toBeCloseTo(584 / 288, 5);
  });

  it("shows an insertion marker while dragging compatible media onto a track", () => {
    mediaLibraryMock.items = [VIDEO];
    const { container } = render(<VideoEditorWorkspace />);
    const track = container.querySelector<HTMLElement>('[data-track-id="video-1"]');
    expect(track).not.toBeNull();
    const dataTransfer = {
      dropEffect: "none",
      getData: vi.fn(() => VIDEO.id),
      types: [DIRECTOR_MEDIA_DRAG_TYPE],
    };

    fireEvent.dragOver(track!, { clientX: 144, dataTransfer });
    expect(track).toHaveClass("is-drop-target");
    expect(track?.querySelector(".creative-timeline-drop-indicator")).toBeInTheDocument();

    fireEvent.dragLeave(track!, { relatedTarget: document.body, dataTransfer });
    expect(track).not.toHaveClass("is-drop-target");
  });

  it("accepts drops when the browser hides drag data until drop (Chrome protected mode)", async () => {
    mediaLibraryMock.items = [VIDEO];
    const { container } = render(<VideoEditorWorkspace />);
    const track = container.querySelector<HTMLElement>('[data-track-id="video-1"]');
    expect(track).not.toBeNull();
    // Real browsers return "" from getData() during dragover; only the in-app
    // drag session identifies the media until the drop event fires.
    const dataTransfer = {
      dropEffect: "none",
      getData: vi.fn(() => ""),
      types: [DIRECTOR_MEDIA_DRAG_TYPE],
    };

    beginDirectorMediaDragSession(VIDEO.id);
    try {
      fireEvent.dragOver(track!, { clientX: 144, dataTransfer });
      expect(track).toHaveClass("is-drop-target");

      fireEvent.drop(track!, { clientX: 144, dataTransfer });
      await waitFor(() => expect(videoTrack().clips).toHaveLength(1));
      expect(videoTrack().clips[0]).toMatchObject({ mediaId: VIDEO.id });
    } finally {
      endDirectorMediaDragSession();
    }
  });

  it("imports image, video, and audio files through the real media-browser callback", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    const image = new File(["image"], "reference.png", { type: "image/png" });
    const video = new File(["video"], "take.mp4", { type: "video/mp4" });
    const audio = new File(["audio"], "voice.wav", { type: "audio/wav" });

    await user.upload(mediaUploadInput(container), [image, video, audio]);

    await waitFor(() => expect(mediaImportMocks.importFile).toHaveBeenCalledTimes(3));
    expect(mediaImportMocks.probe).toHaveBeenNthCalledWith(1, image);
    expect(mediaImportMocks.probe).toHaveBeenNthCalledWith(2, video);
    expect(mediaImportMocks.probe).toHaveBeenNthCalledWith(3, audio);
    expect(mediaImportMocks.importFile.mock.calls.map(([file]) => file)).toEqual([image, video, audio]);
    expect(await screen.findByText("已导入 3 项素材")).toBeInTheDocument();
    expect(useDirectorCreativeWorkspaceStore.getState().galleryMedia).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mediaId: "imported:reference.png", addedAt: expect.any(String) }),
        expect.objectContaining({ mediaId: "imported:take.mp4", addedAt: expect.any(String) }),
        expect.objectContaining({ mediaId: "imported:voice.wav", addedAt: expect.any(String) }),
      ]),
    );
  });

  it("adds visual media to a video track and audio media to an audio track", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);

    await user.click(screen.getByRole("button", { name: "添加 Reference still" }));
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    await user.click(screen.getByRole("button", { name: "添加 Voice over" }));

    expect(videoTrack().clips.map((clip) => clip.mediaId)).toEqual([IMAGE.id, VIDEO.id]);
    expect(audioTrack().clips.map((clip) => clip.mediaId)).toEqual([AUDIO.id]);
    // The + button queues into the next free slot instead of overwriting at the playhead.
    expect(videoTrack().clips.map((clip) => clip.startSec)).toEqual([0, 3]);
    expect(audioTrack().clips[0]).toMatchObject({ startSec: 3, durationSec: 2.5, sourceDurationSec: 2.5 });
  });

  it("overwrites covered clips when media is dropped at an explicit position", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Reference still" }));
    expect(videoTrack().clips).toHaveLength(1);

    const track = container.querySelector<HTMLElement>('[data-track-id="video-1"]');
    const dataTransfer = {
      dropEffect: "none",
      getData: vi.fn(() => VIDEO.id),
      types: [DIRECTOR_MEDIA_DRAG_TYPE],
    };
    // clientX 0 → second 0: the 4s video fully covers the 3s image.
    fireEvent.drop(track!, { clientX: 0, dataTransfer });

    await waitFor(() => expect(videoTrack().clips).toHaveLength(1));
    expect(videoTrack().clips[0]).toMatchObject({ mediaId: VIDEO.id, startSec: 0, durationSec: 4 });
  });

  it("renders filmstrip tiles inside wide video clips", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));

    const filmstrip = container.querySelector(".creative-clip-filmstrip");
    expect(filmstrip).not.toBeNull();
    expect(filmstrip!.querySelector('img[src="data:image/jpeg;base64,test"]')).not.toBeNull();
  });

  it("toggles a cross dissolve from the context menu and reflects it in the inspector", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    // Queued adds sit back to back: 0-4 then 4-8, so the second clip has a predecessor.
    expect(videoTrack().clips.map((clip) => clip.startSec)).toEqual([0, 4]);

    const clips = container.querySelectorAll(".creative-timeline-clip");
    fireEvent.contextMenu(clips[0], { clientX: 200, clientY: 200 });
    expect(screen.getByRole("menuitem", { name: /添加交叉溶解/ })).toBeDisabled();
    fireEvent.keyDown(window, { key: "Escape" });

    fireEvent.contextMenu(clips[1], { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByRole("menuitem", { name: /添加交叉溶解/ }));
    expect(videoTrack().clips[1].transitionInSec).toBeCloseTo(0.5, 6);
    expect(container.querySelector(".creative-clip-transition")).not.toBeNull();

    // The inspector exposes the same value for fine tuning.
    act(() => useDirectorCreativeWorkspaceStore.getState().selectClip(videoTrack().clips[1].id));
    fireEvent.change(screen.getByLabelText("交叉溶解时长"), { target: { value: "1.2" } });
    expect(videoTrack().clips[1].transitionInSec).toBeCloseTo(1.2, 6);

    fireEvent.contextMenu(container.querySelectorAll(".creative-timeline-clip")[1], { clientX: 300, clientY: 200 });
    fireEvent.click(screen.getByRole("menuitem", { name: /移除交叉溶解/ }));
    expect(videoTrack().clips[1].transitionInSec ?? 0).toBe(0);
  });

  it("ripple-deletes the selected clip with Shift+Delete and closes the gap", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Reference still" }));
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    expect(videoTrack().clips.map((clip) => clip.startSec)).toEqual([0, 3]);

    const firstClipId = videoTrack().clips[0].id;
    act(() => useDirectorCreativeWorkspaceStore.getState().selectClip(firstClipId));
    fireEvent.keyDown(window, { key: "Delete", shiftKey: true });

    expect(videoTrack().clips).toHaveLength(1);
    expect(videoTrack().clips[0]).toMatchObject({ mediaId: VIDEO.id, startSec: 0 });
    expect(useDirectorCreativeWorkspaceStore.getState().selectedClipId).toBeNull();
  });

  it("persists transient media before adding the durable reference to the timeline", async () => {
    const user = userEvent.setup();
    const capture: DirectorMediaItem = {
      ...IMAGE,
      id: "capture:transient-frame",
      collection: "captures",
      name: "Transient frame",
      sourceUrl: "blob:transient-frame",
    };
    mediaLibraryMock.items = [capture];
    mediaLibraryMock.persist.mockResolvedValue("creative-media:image:durable-frame");
    render(<VideoEditorWorkspace />);

    await user.click(screen.getByRole("button", { name: "添加 Transient frame" }));

    await waitFor(() => expect(videoTrack().clips).toHaveLength(1));
    expect(mediaLibraryMock.persist).toHaveBeenCalledWith(capture);
    expect(videoTrack().clips[0]).toMatchObject({
      mediaId: "creative-media:image:durable-frame",
      name: "Transient frame",
    });
  });

  it("keeps the timeline unchanged and reports an error when media persistence fails", async () => {
    const user = userEvent.setup();
    mediaLibraryMock.items = [VIDEO];
    mediaLibraryMock.persist.mockRejectedValue(new Error("素材读取失败：Camera take"));
    render(<VideoEditorWorkspace />);

    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));

    expect(await screen.findByText("素材读取失败：Camera take")).toBeInTheDocument();
    expect(videoTrack().clips).toHaveLength(0);
  });

  it("renders cached waveforms and persists a manual original/proxy playback choice", async () => {
    const user = userEvent.setup();
    const proxyBackedVideo: DirectorMediaItem = {
      ...VIDEO,
      waveform: WAVEFORM,
      playbackPreference: "auto",
      playbackSource: {
        variant: "original",
        assetId: VIDEO.id,
        url: VIDEO.sourceUrl,
        proxyAssetId: "creative-media:video:camera-take-proxy",
        reason: "original-default",
      },
      proxySourceUrl: "blob:camera-take-proxy",
    };
    mediaLibraryMock.items = [proxyBackedVideo];
    mediaImportMocks.getAsset.mockReturnValue({ id: VIDEO.id, playbackPreference: "auto" });
    render(<VideoEditorWorkspace />);

    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    expect(screen.getByRole("img", { name: "Camera take 音频波形" })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole("combobox", { name: "播放媒体版本" }), "proxy");
    expect(mediaImportMocks.setPlaybackPreference).toHaveBeenCalledWith(VIDEO.id, "proxy");
    expect(await screen.findByText("播放媒体版本已更新")).toBeInTheDocument();
  });

  it("shows image and video at the playhead, keeps picture visible when muted, and hides it only when visibility is off", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);

    await user.click(screen.getByRole("button", { name: "添加 Reference still" }));
    expect(screen.getByAltText("Reference still")).toHaveAttribute("src", "data:image/png;base64,source");

    await user.click(screen.getByRole("button", { name: "静音 视频 1" }));
    expect(screen.getByAltText("Reference still")).toBeInTheDocument();
    expect(videoTrack().muted).toBe(true);

    act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(4));
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    expect(
      container.querySelector<HTMLVideoElement>('video[src="https://example.test/camera-take.mp4"]'),
    ).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "隐藏画面 视频 1" }));
    expect(videoTrack().visible).toBe(false);
    expect(container.querySelector(".creative-preview-media")).toBeNull();
    expect(screen.getByText("将素材添加到时间线")).toBeInTheDocument();
  });

  it("updates fade, scale, position, rotation, and fit from the clip inspector", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Reference still" }));

    fireEvent.change(screen.getByLabelText("淡入 (s)"), { target: { value: "0.6" } });
    fireEvent.change(screen.getByLabelText("淡出 (s)"), { target: { value: "0.4" } });
    fireEvent.change(screen.getByLabelText(/^缩放 ·/), { target: { value: "1.5" } });
    fireEvent.change(screen.getByLabelText("X"), { target: { value: "192" } });
    fireEvent.change(screen.getByLabelText("Y"), { target: { value: "-108" } });
    fireEvent.change(screen.getByLabelText("旋转"), { target: { value: "30" } });
    await user.selectOptions(screen.getByLabelText("适配"), "cover");

    const clip = videoTrack().clips[0];
    expect(clip).toMatchObject({
      fadeInSec: 0.6,
      fadeOutSec: 0.4,
      scale: 1.5,
      positionX: 192,
      positionY: -108,
      rotationDeg: 30,
      fit: "cover",
    });
    const preview = container.querySelector<HTMLImageElement>('img[alt="Reference still"]');
    expect(preview).not.toBeNull();
    expect(preview).toHaveStyle({ objectFit: "cover" });
    expect(preview?.style.transform).toContain("scale(1.5)");
    expect(preview?.style.transform).toContain("rotate(30deg)");
    expect(preview?.style.transform).toContain("10.0000%");
    expect(preview?.style.transform).toContain("-10.0000%");
  });

  it("splits the selected clip at the current playhead", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    const originalId = videoTrack().clips[0].id;

    act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(2));
    const splitButton = screen.getByRole("button", { name: "分割" });
    expect(splitButton).toBeEnabled();
    await user.click(splitButton);

    expect(videoTrack().clips).toHaveLength(2);
    expect(videoTrack().clips[0]).toMatchObject({ id: originalId, startSec: 0, durationSec: 2, inSec: 0 });
    expect(videoTrack().clips[1]).toMatchObject({ startSec: 2, durationSec: 2, inSec: 2 });
    expect(useDirectorCreativeWorkspaceStore.getState().selectedClipId).toBe(videoTrack().clips[1].id);
  });

  it("configures rational FPS, drop-frame, and SMPTE start timecode from the export dialog", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Reference still" }));
    await user.click(screen.getByRole("button", { name: "导出视频" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "FPS" }), "30000/1001");
    const timecodeMode = screen.getByRole("button", { name: "时码模式" });
    await user.click(timecodeMode);
    const start = screen.getByLabelText("起始 SMPTE 时间码");
    await user.clear(start);
    await user.type(start, "01:00:00;00");
    fireEvent.blur(start);

    expect(useDirectorCreativeWorkspaceStore.getState().editSettings).toMatchObject({
      fps: 30_000 / 1_001,
      timebase: {
        rate: { numerator: 30_000, denominator: 1_001 },
        dropFrame: true,
        startTimecode: "01:00:00;00",
      },
    });
    expect(timecodeMode).toHaveAttribute("aria-pressed", "true");
  });

  it("imports a validated project document and restores timeline settings and clips", async () => {
    const user = userEvent.setup();
    act(() => {
      const store = useDirectorCreativeWorkspaceStore.getState();
      store.updateEditSettings({ aspectRatio: "9 / 16", fps: 30, snapEnabled: false, exportQuality: "full" });
      store.addClip({
        trackId: "video-1",
        mediaId: IMAGE.id,
        name: "Restored still",
        startSec: 1.25,
        durationSec: 2,
        sourceDurationSec: 3600,
        fadeInSec: 0.25,
        scale: 1.2,
        positionX: 96,
        fit: "cover",
      });
    });
    const serialized = serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState());
    const projectJson = JSON.stringify({
      documentType: "director-creative-project",
      version: 2,
      creative: JSON.parse(serialized) as unknown,
    });
    act(() => useDirectorCreativeWorkspaceStore.getState().resetCreativeWorkspaces());
    const { container } = render(<VideoEditorWorkspace />);
    const file = new File([projectJson], "director-creative-project.json", { type: "application/json" });
    Object.defineProperty(file, "text", { configurable: true, value: async () => projectJson });

    await user.upload(projectUploadInput(container), file);

    expect(await screen.findByText("工程已恢复；缺失的外部素材会在媒体库中明确标记")).toBeInTheDocument();
    expect(useDirectorCreativeWorkspaceStore.getState().editSettings).toEqual({
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
    expect(videoTrack().clips).toEqual([
      expect.objectContaining({
        mediaId: IMAGE.id,
        name: "Restored still",
        startSec: 1.25,
        durationSec: 2,
        fadeInSec: 0.25,
        scale: 1.2,
        positionX: 96,
        fit: "cover",
      }),
    ]);
    expect(screen.getByRole("button", { name: "画幅比例" })).toHaveTextContent("9:16");
  });

  it("asks for inline confirmation before a project import replaces a non-empty timeline", async () => {
    const user = userEvent.setup();
    const emptyProjectJson = JSON.stringify({
      documentType: "director-creative-project",
      version: 2,
      creative: JSON.parse(
        serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState()),
      ) as unknown,
    });
    act(() => {
      useDirectorCreativeWorkspaceStore.getState().addClip({
        trackId: "video-1",
        mediaId: IMAGE.id,
        name: "Current cut",
        startSec: 0,
        durationSec: 2,
        sourceDurationSec: 3600,
      });
    });
    const { container } = render(<VideoEditorWorkspace />);
    const makeProjectFile = () => {
      const file = new File([emptyProjectJson], "director-creative-project.json", { type: "application/json" });
      Object.defineProperty(file, "text", { configurable: true, value: async () => emptyProjectJson });
      return file;
    };

    await user.upload(projectUploadInput(container), makeProjectFile());

    // The file is not loaded yet: the workspace first explains the replacement.
    const confirmDialog = await screen.findByRole("alertdialog", { name: "确认导入工程" });
    expect(confirmDialog).toHaveTextContent("导入工程将替换当前剪辑与 3D 片场，且无法通过撤销恢复。");
    expect(videoTrack().clips).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "取消导入" }));
    expect(screen.queryByRole("alertdialog", { name: "确认导入工程" })).not.toBeInTheDocument();
    expect(videoTrack().clips).toHaveLength(1);

    await user.upload(projectUploadInput(container), makeProjectFile());
    await user.click(await screen.findByRole("button", { name: "确认导入并替换" }));

    expect(await screen.findByText("工程已恢复；缺失的外部素材会在媒体库中明确标记")).toBeInTheDocument();
    expect(videoTrack().clips).toHaveLength(0);
  });

  it("imports a project without confirmation while the timeline is still empty", async () => {
    const user = userEvent.setup();
    const projectJson = JSON.stringify({
      documentType: "director-creative-project",
      version: 2,
      creative: JSON.parse(
        serializeDirectorCreativeWorkspacePersistedState(useDirectorCreativeWorkspaceStore.getState()),
      ) as unknown,
    });
    const { container } = render(<VideoEditorWorkspace />);
    const file = new File([projectJson], "director-creative-project.json", { type: "application/json" });
    Object.defineProperty(file, "text", { configurable: true, value: async () => projectJson });

    await user.upload(projectUploadInput(container), file);

    expect(screen.queryByRole("alertdialog", { name: "确认导入工程" })).not.toBeInTheDocument();
    expect(await screen.findByText("工程已恢复；缺失的外部素材会在媒体库中明确标记")).toBeInTheDocument();
  });

  it("warns before unload while a video export runs and stops warning after cancel", async () => {
    const user = userEvent.setup();
    exportVideoMock.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    await waitFor(() => expect(videoTrack().clips).toHaveLength(1));

    await user.click(screen.getByRole("button", { name: "导出视频" }));
    await user.click(screen.getByRole("button", { name: "开始导出" }));

    const duringExport = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(duringExport);
    expect(duringExport.defaultPrevented).toBe(true);

    await user.click(screen.getByRole("button", { name: "取消导出" }));
    expect(await screen.findByText("已取消导出")).toBeInTheDocument();

    const afterCancel = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(afterCancel);
    expect(afterCancel.defaultPrevented).toBe(false);
  });

  it("opens a clip context menu and closes it with Escape or an outside press", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    const clipId = videoTrack().clips[0].id;
    const clipEl = container.querySelector<HTMLElement>(".creative-timeline-clip");
    expect(clipEl).not.toBeNull();

    fireEvent.contextMenu(clipEl!, { clientX: 320, clientY: 240 });
    expect(screen.getByRole("menu", { name: "剪辑菜单" })).toBeInTheDocument();
    // The playhead rests at the clip start, so splitting is unavailable while copy/delete stay armed.
    expect(screen.getByRole("menuitem", { name: /在播放头处分割/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /创建副本/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /波纹删除/ })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /^删除/ })).toBeEnabled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "剪辑菜单" })).not.toBeInTheDocument();
    expect(useDirectorCreativeWorkspaceStore.getState().selectedClipId).toBe(clipId);

    fireEvent.contextMenu(clipEl!, { clientX: 320, clientY: 240 });
    expect(screen.getByRole("menu", { name: "剪辑菜单" })).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("menu", { name: "剪辑菜单" })).not.toBeInTheDocument();
  });

  it("splits and deletes clips from the context menu", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(2));

    fireEvent.contextMenu(container.querySelector(".creative-timeline-clip")!, { clientX: 300, clientY: 220 });
    const splitItem = screen.getByRole("menuitem", { name: /在播放头处分割/ });
    expect(splitItem).toBeEnabled();
    fireEvent.click(splitItem);
    expect(videoTrack().clips).toHaveLength(2);
    expect(videoTrack().clips.map((clip) => clip.startSec)).toEqual([0, 2]);
    expect(screen.queryByRole("menu", { name: "剪辑菜单" })).not.toBeInTheDocument();

    fireEvent.contextMenu(container.querySelectorAll(".creative-timeline-clip")[0], { clientX: 300, clientY: 220 });
    fireEvent.click(screen.getByRole("menuitem", { name: /^删除/ }));
    expect(videoTrack().clips).toHaveLength(1);
    expect(videoTrack().clips[0].startSec).toBe(2);
    expect(screen.queryByRole("menu", { name: "剪辑菜单" })).not.toBeInTheDocument();
  });

  it("ripple-deletes from the context menu so later clips close the gap", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(2));
    fireEvent.contextMenu(container.querySelector(".creative-timeline-clip")!, { clientX: 300, clientY: 220 });
    fireEvent.click(screen.getByRole("menuitem", { name: /在播放头处分割/ }));
    expect(videoTrack().clips.map((clip) => clip.startSec)).toEqual([0, 2]);

    fireEvent.contextMenu(container.querySelectorAll(".creative-timeline-clip")[0], { clientX: 300, clientY: 220 });
    fireEvent.click(screen.getByRole("menuitem", { name: /波纹删除/ }));

    expect(videoTrack().clips).toHaveLength(1);
    expect(videoTrack().clips[0]).toMatchObject({ startSec: 0, inSec: 2 });
    expect(screen.queryByRole("menu", { name: "剪辑菜单" })).not.toBeInTheDocument();
  });

  it("disables every context menu action on a locked track", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    act(() => {
      useDirectorCreativeWorkspaceStore.getState().setPlayhead(2);
      useDirectorCreativeWorkspaceStore.getState().toggleTrackLock("video-1");
    });

    fireEvent.contextMenu(container.querySelector(".creative-timeline-clip")!, { clientX: 260, clientY: 200 });

    expect(screen.getByRole("menuitem", { name: /在播放头处分割/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /创建副本/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /波纹删除/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /^删除/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("menuitem", { name: /^删除/ }));
    expect(videoTrack().clips).toHaveLength(1);
  });

  it("duplicates the selected clip with Ctrl/⌘+D as a single undo step", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    const original = videoTrack().clips[0];
    act(() =>
      useDirectorCreativeWorkspaceStore.getState().updateClip(original.id, {
        durationSec: 2,
        inSec: 1,
        opacity: 0.6,
        volume: 0.4,
        fadeInSec: 0.3,
        positionX: 50,
        rotationDeg: 15,
      }),
    );

    fireEvent.keyDown(window, { key: "d", ctrlKey: true });

    expect(videoTrack().clips).toHaveLength(2);
    const copy = videoTrack().clips[1];
    expect(copy.id).not.toBe(original.id);
    expect(copy).toMatchObject({
      mediaId: VIDEO.id,
      name: "Camera take",
      startSec: 2,
      durationSec: 2,
      inSec: 1,
      opacity: 0.6,
      volume: 0.4,
      fadeInSec: 0.3,
      positionX: 50,
      rotationDeg: 15,
    });
    expect(useDirectorCreativeWorkspaceStore.getState().selectedClipId).toBe(copy.id);

    act(() => useDirectorCreativeWorkspaceStore.getState().undo());
    expect(videoTrack().clips).toHaveLength(1);
  });

  it("nudges the selected clip by a frame with , / . and by a second with Shift", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    const frame = 1 / useDirectorCreativeWorkspaceStore.getState().editSettings.fps;

    fireEvent.keyDown(window, { key: "." });
    expect(videoTrack().clips[0].startSec).toBeCloseTo(frame, 6);

    fireEvent.keyDown(window, { key: ".", shiftKey: true });
    expect(videoTrack().clips[0].startSec).toBeCloseTo(1 + frame, 6);

    fireEvent.keyDown(window, { key: "," });
    expect(videoTrack().clips[0].startSec).toBeCloseTo(1, 6);

    // Shift+, arrives as "<" on US layouts.
    fireEvent.keyDown(window, { key: "<", shiftKey: true });
    expect(videoTrack().clips[0].startSec).toBeCloseTo(0, 6);

    fireEvent.keyDown(window, { key: "<", shiftKey: true });
    expect(videoTrack().clips[0].startSec).toBe(0);
  });

  it("shows a live duration badge on the trimmed edge and hides it on release", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    const endHandle = container.querySelector<HTMLElement>(".creative-clip-trim.is-end");
    expect(endHandle).not.toBeNull();

    fireEvent.pointerDown(endHandle!, { button: 0, clientX: 288 });
    expect(container.querySelector(".creative-clip-trim-badge.is-end")?.textContent).toBe("4.00s");

    fireEvent.pointerMove(window, { clientX: 216 });
    expect(videoTrack().clips[0].durationSec).toBeCloseTo(3, 6);
    expect(container.querySelector(".creative-clip-trim-badge.is-end")?.textContent).toBe("3.00s");

    fireEvent.pointerUp(window, { clientX: 216 });
    expect(container.querySelector(".creative-clip-trim-badge")).toBeNull();
  });

  it("scrubs by dragging the playhead handle without clearing the selection", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
    const clipId = videoTrack().clips[0].id;
    const handle = container.querySelector<HTMLElement>(".creative-timeline-playhead span");
    expect(handle).not.toBeNull();

    fireEvent.pointerDown(handle!, { clientX: 144 });
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBeCloseTo(2, 6);

    fireEvent.pointerMove(window, { clientX: 216 });
    expect(useDirectorCreativeWorkspaceStore.getState().playheadSec).toBeCloseTo(3, 6);

    fireEvent.pointerUp(window, { clientX: 216 });
    expect(useDirectorCreativeWorkspaceStore.getState().selectedClipId).toBe(clipId);
  });

  it("resets scale, position, and rotation from the inspector's reset action", async () => {
    const user = userEvent.setup();
    render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Reference still" }));
    const clipId = videoTrack().clips[0].id;
    act(() =>
      useDirectorCreativeWorkspaceStore.getState().updateClip(clipId, {
        scale: 1.6,
        positionX: 120,
        positionY: -60,
        rotationDeg: 12,
      }),
    );

    await user.click(screen.getByRole("button", { name: "重置变换" }));

    expect(videoTrack().clips[0]).toMatchObject({ scale: 1, positionX: 0, positionY: 0, rotationDeg: 0 });
  });

  it("quantizes the render playhead to 250ms buckets only while playing", () => {
    expect(quantizeDirectorPlayheadForRender(1.999, true)).toBe(1.75);
    expect(quantizeDirectorPlayheadForRender(2, true)).toBe(2);
    expect(quantizeDirectorPlayheadForRender(2.249, true)).toBe(2);
    expect(quantizeDirectorPlayheadForRender(1.999, false)).toBe(1.999);
    expect(quantizeDirectorPlayheadForRender(0, true)).toBe(0);
  });

  it("computes an active-layer signature that flips exactly at clip boundaries and track toggles", () => {
    act(() => {
      const store = useDirectorCreativeWorkspaceStore.getState();
      store.addClip({
        trackId: "video-1",
        mediaId: IMAGE.id,
        name: "A",
        startSec: 0,
        durationSec: 2,
        sourceDurationSec: 3600,
      });
      store.addClip({
        trackId: "video-1",
        mediaId: VIDEO.id,
        name: "B",
        startSec: 2,
        durationSec: 2,
        sourceDurationSec: 4,
      });
      store.addClip({
        trackId: "audio-1",
        mediaId: AUDIO.id,
        name: "VO",
        startSec: 1,
        durationSec: 2,
        sourceDurationSec: 2.5,
      });
    });
    const mediaById = new Map<string, DirectorMediaItem>([
      [IMAGE.id, IMAGE],
      [VIDEO.id, VIDEO],
      [AUDIO.id, AUDIO],
    ]);
    const tracks = useDirectorCreativeWorkspaceStore.getState().editTracks;
    const at = (sec: number) => computeDirectorActiveLayerSignature(tracks, mediaById, sec);

    // Stable inside one interval, regardless of the exact playhead.
    expect(at(0.1)).toBe(at(0.99));
    expect(at(1.2)).toBe(at(1.99));
    // Flips at the video clip boundary (2) and when the audio clip ends (3).
    expect(at(1.99)).not.toBe(at(2.01));
    expect(at(2.5)).not.toBe(at(3.5));
    // Audio clip entering at 1 changes the audible part only.
    expect(at(0.5)).not.toBe(at(1.5));

    act(() => useDirectorCreativeWorkspaceStore.getState().toggleTrackVisibility("video-1"));
    const hiddenTracks = useDirectorCreativeWorkspaceStore.getState().editTracks;
    expect(computeDirectorActiveLayerSignature(hiddenTracks, mediaById, 0.5)).not.toBe(at(0.5));

    act(() => {
      useDirectorCreativeWorkspaceStore.getState().toggleTrackVisibility("video-1");
      useDirectorCreativeWorkspaceStore.getState().toggleTrackMute("audio-1");
    });
    const mutedTracks = useDirectorCreativeWorkspaceStore.getState().editTracks;
    expect(computeDirectorActiveLayerSignature(mutedTracks, mediaById, 1.5)).not.toBe(at(1.5));
  });

  it("updates the transport and preview timecode chips as the playhead moves", async () => {
    const user = userEvent.setup();
    const { container } = render(<VideoEditorWorkspace />);
    await user.click(screen.getByRole("button", { name: "添加 Camera take" }));

    act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(2));

    // The clickable timecode carries the human-readable title on its button.
    const transportButton = container.querySelector(
      ".creative-transport-group.is-playback .creative-transport-timecode",
    );
    const transportTime = container.querySelector(".creative-transport-group.is-playback time");
    expect(transportButton?.getAttribute("title")).toContain("00:02.00");
    expect(transportTime?.textContent).toBe("00:00:02:00");
    // The edit timeline keeps a 5s minimum window (getDirectorEditDuration).
    const previewTime = container.querySelector(".creative-preview-meta time");
    expect(previewTime?.getAttribute("title")).toBe("00:02.00 / 00:05.00");
    expect(previewTime?.textContent).toBe("00:00:02:00 / 00:00:05:00");

    act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(3));
    expect(transportButton?.getAttribute("title")).toContain("00:03.00");
    expect(transportTime?.textContent).toBe("00:00:03:00");
    expect(previewTime?.getAttribute("title")).toBe("00:03.00 / 00:05.00");
  });

  it("switches preview layers frame-accurately at clip boundaries while playing", async () => {
    const frames = mockAnimationFrames();
    try {
      const user = userEvent.setup();
      const { container } = render(<VideoEditorWorkspace />);
      act(() => {
        const store = useDirectorCreativeWorkspaceStore.getState();
        store.addClip({
          trackId: "video-1",
          mediaId: IMAGE.id,
          name: "Still",
          startSec: 0,
          durationSec: 4.1,
          sourceDurationSec: 3600,
        });
        store.addClip({
          trackId: "video-1",
          mediaId: VIDEO.id,
          name: "Take",
          startSec: 4.1,
          durationSec: 4,
          sourceDurationSec: 4,
        });
        store.setPlayhead(4.05);
      });
      await user.click(screen.getByRole("button", { name: "播放" }));
      expect(screen.getByAltText("Reference still")).toBeInTheDocument();

      // 4.05 → 4.15 stays inside one 250ms quantization bucket, so only the
      // active-layer signature subscription can force this switch.
      act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(4.15));

      expect(
        container.querySelector<HTMLVideoElement>('video[src="https://example.test/camera-take.mp4"]'),
      ).not.toBeNull();
      expect(screen.queryByAltText("Reference still")).not.toBeInTheDocument();
    } finally {
      frames.restore();
    }
  });

  it("re-renders the workspace ~4Hz while playing but keeps hot components and paused scrubbing exact", async () => {
    const frames = mockAnimationFrames();
    try {
      const user = userEvent.setup();
      const { container } = render(<VideoEditorWorkspace />);
      await user.click(screen.getByRole("button", { name: "添加 Camera take" }));
      await user.click(screen.getByRole("button", { name: "播放" }));

      const steps = 24;
      workspaceRenderProbe.mockClear();
      for (let step = 1; step <= steps; step += 1) {
        act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(1 + step * 0.01));
      }
      // 1.01..1.24 all quantize to the 1.0 bucket: one bucket flip (0 → 1.0),
      // then the giant workspace stays idle while the playhead keeps moving.
      expect(workspaceRenderProbe.mock.calls.length).toBeLessThanOrEqual(2);
      expect(workspaceRenderProbe.mock.calls.length).toBeLessThan(steps / 4);

      // Self-subscribed hot components still tracked every single step.
      const transportTime = container.querySelector(
        ".creative-transport-group.is-playback .creative-transport-timecode",
      );
      expect(transportTime?.getAttribute("title")).toContain("00:01.24");
      const playhead = container.querySelector<HTMLElement>(".creative-timeline-playhead");
      expect(Number.parseFloat(playhead?.style.left ?? "")).toBeCloseTo(1.24 * 72, 3);

      await user.click(screen.getByRole("button", { name: "暂停" }));
      workspaceRenderProbe.mockClear();
      for (let step = 1; step <= 5; step += 1) {
        act(() => useDirectorCreativeWorkspaceStore.getState().setPlayhead(2 + step * 0.01));
      }
      // Paused: the workspace subscribes at full precision again.
      expect(workspaceRenderProbe.mock.calls.length).toBeGreaterThanOrEqual(5);
    } finally {
      frames.restore();
    }
  });

  it("buckets the timeline window and renders everything while the viewport is unmeasured", () => {
    // Unknown width (jsdom default) → unbounded window, nothing is culled.
    expect(computeDirectorTimelineWindow(0, 0)).toEqual({ startPx: 0, endPx: Number.POSITIVE_INFINITY });
    expect(computeDirectorTimelineWindow(5000, Number.NaN)).toEqual({
      startPx: 0,
      endPx: Number.POSITIVE_INFINITY,
    });
    // 512px overscan on both sides, snapped outward to 256px buckets.
    expect(computeDirectorTimelineWindow(1000, 600)).toEqual({ startPx: 256, endPx: 2304 });
    expect(computeDirectorTimelineWindow(0, 600)).toEqual({ startPx: 0, endPx: 1280 });
    // Scrolling inside one bucket yields an identical window → no re-render.
    expect(computeDirectorTimelineWindow(1010, 600)).toEqual(computeDirectorTimelineWindow(1000, 600));
    expect(computeDirectorTimelineWindow(1400, 600)).not.toEqual(computeDirectorTimelineWindow(1000, 600));
  });

  it("windows clips and ruler ticks to the measured viewport", () => {
    const { container } = render(<VideoEditorWorkspace />);
    const scroller = mockTimelineViewport(container, 600);
    addTimelineClipAt("Clip near 0s", 0);
    addTimelineClipAt("Clip near 5s", 5);
    addTimelineClipAt("Clip at 200s", 200);
    addTimelineClipAt("Clip at 400s", 400);

    // The width was mocked after mount, so nudge the window sync via scroll.
    fireEvent.scroll(scroller);

    expect(timelineClipNames(container)).toEqual(["Clip near 0s", "Clip near 5s"]);
    expect(container.querySelectorAll(".creative-timeline-clip")).toHaveLength(2);

    // duration is 403s → 404 ruler ticks unwindowed; the 600px viewport
    // (+512px overscan, 72px/s) keeps only ~19 ticks mounted.
    const ticks = container.querySelectorAll(".creative-timeline-ruler span");
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(30);
  });

  it("mounts far clips once the timeline scrolls to them", async () => {
    const { container } = render(<VideoEditorWorkspace />);
    const scroller = mockTimelineViewport(container, 600);
    addTimelineClipAt("Clip near 0s", 0);
    addTimelineClipAt("Clip at 200s", 200);

    fireEvent.scroll(scroller);
    expect(timelineClipNames(container)).toEqual(["Clip near 0s"]);

    scroller.scrollLeft = 200 * 72;
    fireEvent.scroll(scroller);

    await waitFor(() => expect(timelineClipNames(container)).toContain("Clip at 200s"));
    expect(timelineClipNames(container)).not.toContain("Clip near 0s");
  });

  it("keeps the selected clip mounted even when it is far outside the window", () => {
    const { container } = render(<VideoEditorWorkspace />);
    const scroller = mockTimelineViewport(container, 600);
    addTimelineClipAt("Clip near 0s", 0);
    addTimelineClipAt("Clip at 400s", 400);

    fireEvent.scroll(scroller);
    expect(timelineClipNames(container)).not.toContain("Clip at 400s");

    const farClip = videoTrack().clips.find((clip) => clip.startSec === 400);
    expect(farClip).toBeDefined();
    act(() => useDirectorCreativeWorkspaceStore.getState().selectClip(farClip!.id));
    expect(timelineClipNames(container)).toContain("Clip at 400s");

    act(() => useDirectorCreativeWorkspaceStore.getState().selectClip(null));
    expect(timelineClipNames(container)).not.toContain("Clip at 400s");
  });
});
