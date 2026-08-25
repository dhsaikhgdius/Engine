import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clearDirectorDeskHostBridge, initDirectorDeskHostBridge, postDirectorDeskVideoToHost } from "../../../../src/comprehensive/editor/io/hostBridge";
import { createInitialDirectorState, useDirectorStore } from "../../../../src/comprehensive/editor/store/directorStore";
import { clearViewportCaptureHandler, setViewportCaptureHandler } from "../../../../src/comprehensive/editor/io/captureBridge";
import { getDirectorSessionRuntime } from "../../../../src/comprehensive/editor/session/directorSessionRuntime";

function createMemoryStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: () => storage.clear(),
    getItem: (key) => storage.get(key) ?? null,
    key: (index) => Array.from(storage.keys())[index] ?? null,
    removeItem: (key) => {
      storage.delete(key);
    },
    setItem: (key, value) => {
      storage.set(key, String(value));
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", createMemoryStorage());
  document.documentElement.classList.remove("dark");
  delete document.documentElement.dataset.theme;
  useDirectorStore.getState().openScopedScene(null);
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

afterEach(() => {
  clearDirectorDeskHostBridge();
  clearViewportCaptureHandler();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("applies an external agent scene without echoing it back to the host", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: "storyai:director-desk-session", payload: { instanceId: "main" } },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();
  const project = {
    ...useDirectorStore.getState().project,
    objects: useDirectorStore
      .getState()
      .project.objects.map((item) => (item.kind === "character" ? { ...item, name: "Agent更新角色" } : item)),
  };

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-external-scene",
        payload: { instanceId: "main", projectJson: JSON.stringify(project), viewMode: "camera" },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(useDirectorStore.getState().project.objects.some((item) => item.name === "Agent更新角色")).toBe(true);
  expect(postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "storyai:director-desk-project-changed" }),
    window.location.origin,
  );
});

it("restores a falsely deleted page-cache object from the authoritative confirmation rollback", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const authoritativeProject = structuredClone(useDirectorStore.getState().project);
  initDirectorDeskHostBridge();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "confirmation-rollback",
          sceneId: "confirmation-rollback-scene",
          revision: 12,
          projectJson: JSON.stringify(authoritativeProject),
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();

  useDirectorStore.getState().selectObject("char_default_a");
  useDirectorStore.getState().deleteSelectedObject();
  expect(useDirectorStore.getState().project.objects.some((item) => item.id === "char_default_a")).toBe(false);
  expect(getDirectorSessionRuntime()).toMatchObject({ revision: null, dirty: true });
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ type: "storyai:director-desk-project-changed" }),
    window.location.origin,
  );
  postMessage.mockClear();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-external-scene",
        payload: {
          instanceId: "confirmation-rollback",
          sceneId: "confirmation-rollback-scene",
          revision: 12,
          projectJson: JSON.stringify(authoritativeProject),
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(useDirectorStore.getState().project.objects.some((item) => item.id === "char_default_a")).toBe(true);
  expect(getDirectorSessionRuntime()).toMatchObject({
    sceneId: "confirmation-rollback-scene",
    revision: 12,
    dirty: false,
    conflict: null,
  });
  expect(postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "storyai:director-desk-project-changed" }),
    window.location.origin,
  );
});

it("answers a host capture request with real viewport capture payloads", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const captureHandler = vi.fn(async () => [
    {
      label: "当前机位",
      dataUrl: "data:image/png;base64,demo",
      meta: {
        mode: "camera" as const,
        cameraId: "cam_1",
        fov: 35,
        position: [1, 2, 3] as [number, number, number],
        target: [0, 1, 0] as [number, number, number],
        frame: 24,
        revisionRequested: 9,
      },
    },
  ]);
  setViewportCaptureHandler(captureHandler);
  initDirectorDeskHostBridge();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "main", revision: 8 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-revision-ack",
        payload: { instanceId: "main", revision: 9 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-capture-request",
        payload: {
          requestId: "capture-1",
          preset: "current",
          cameraId: "cam_1",
          frame: 24,
          revisionRequested: 9,
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "storyai:director-desk-capture-result",
        payload: expect.objectContaining({ requestId: "capture-1" }),
      }),
      window.location.origin,
    ),
  );
  expect(captureHandler).toHaveBeenCalledWith({
    preset: "current",
    source: "capture-panel",
    cameraId: "cam_1",
    frame: 24,
    revisionRequested: 9,
  });
});

it("rejects a capture when the requested scene revision is not active", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const captureHandler = vi.fn(async () => []);
  setViewportCaptureHandler(captureHandler);
  initDirectorDeskHostBridge();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "main", revision: 10 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-capture-request",
        payload: { requestId: "capture-stale", preset: "current", frame: 24, revisionRequested: 9 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "storyai:director-desk-capture-result",
        payload: expect.objectContaining({
          requestId: "capture-stale",
          captures: [],
          error: expect.stringContaining("r9"),
        }),
      }),
      window.location.origin,
    ),
  );
  expect(captureHandler).not.toHaveBeenCalled();
});

it("drops a deferred capture result after the host bridge is cleared", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  let resolveCapture: ((captures: never[]) => void) | undefined;
  const pendingCapture = new Promise<never[]>((resolve) => {
    resolveCapture = resolve;
  });
  const captureHandler = vi.fn(() => pendingCapture);
  setViewportCaptureHandler(captureHandler);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "main", revision: 12 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-capture-request",
        payload: {
          requestId: "capture-deferred",
          preset: "current",
          revisionRequested: 12,
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  await vi.waitFor(() => expect(captureHandler).toHaveBeenCalledTimes(1));

  clearDirectorDeskHostBridge();
  resolveCapture?.([]);
  await pendingCapture;
  await new Promise((resolve) => window.setTimeout(resolve, 0));

  expect(postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "storyai:director-desk-capture-result" }),
    window.location.origin,
  );
});

it("sends a video Blob to the exact parent and resolves only its matching acknowledgement", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();
  const blob = new Blob(["video"], { type: "video/webm" });
  const resultPromise = postDirectorDeskVideoToHost({
    blob,
    fileName: "director/test.webm",
    mimeType: "video/webm;codecs=vp9",
    frameStart: 12,
    frameEnd: 36,
    fps: 24,
    durationSec: 1,
  });
  const lastCall = postMessage.mock.calls[postMessage.mock.calls.length - 1];
  const message = lastCall?.[0] as {
    type: string;
    payload: { requestId: string; video: Record<string, unknown> };
  };

  expect(message).toMatchObject({
    type: "storyai:director-desk-video-sent",
    payload: {
      video: {
        blob,
        fileName: "director-test.webm",
        mimeType: "video/webm",
        frameStart: 12,
        frameEnd: 36,
        fps: 24,
        durationSec: 1,
      },
    },
  });

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-video-result",
        payload: {
          requestId: message.payload.requestId,
          ok: true,
          relativeName: "director/test.webm",
          nodeType: "VHS_LoadVideo",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  await expect(resultPromise).resolves.toEqual({
    relativeName: "director/test.webm",
    nodeType: "VHS_LoadVideo",
  });
});

it("rejects an invalid reference-video MIME before posting to the host", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  await expect(
    postDirectorDeskVideoToHost({
      blob: new Blob(["bad"], { type: "text/plain" }),
      fileName: "bad.txt",
      mimeType: "text/plain",
      frameStart: 0,
      frameEnd: 1,
      fps: 24,
      durationSec: 1 / 24,
    }),
  ).rejects.toThrow("仅支持 WebM 或 MP4");
  expect(postMessage).not.toHaveBeenCalled();
});

it("rejects invalid clip metadata and a MIME-spoofed Blob before posting", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const valid = {
    fileName: "clip.webm",
    mimeType: "video/webm",
    frameStart: 12,
    frameEnd: 36,
    fps: 24,
    durationSec: 1,
  };

  await expect(
    postDirectorDeskVideoToHost({
      ...valid,
      blob: new Blob(["bad"], { type: "text/plain" }),
    }),
  ).rejects.toThrow("Blob 类型与声明格式不一致");
  await expect(
    postDirectorDeskVideoToHost({
      ...valid,
      blob: new Blob(["video"], { type: "video/webm" }),
      frameEnd: 11,
    }),
  ).rejects.toThrow("帧范围、FPS 或时长无效");
  expect(postMessage).not.toHaveBeenCalled();
});

it("imports a host panorama message into the director store", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director",
          sourceNodeId: "node_image",
          imageUrl: "data:image/png;base64,panorama",
          fileName: "画布图片.png",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  const state = useDirectorStore.getState();
  const panoramaAsset = state.project.assets.find((asset) => asset.id === state.project.panoramaAssetId);

  expect(panoramaAsset).toMatchObject({
    kind: "panorama",
    sourceType: "image",
    fileName: "画布图片.png",
    name: "画布图片.png",
    url: "data:image/png;base64,panorama",
  });
});

it("switches director store persistence when the host sends a card session", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_a",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  useDirectorStore.getState().updateScene({ backgroundColor: "#151515" });

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_b",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#c9cdd3");

  useDirectorStore.getState().updateScene({ backgroundColor: "#303640" });

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_a",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#151515");
});

it("applies the light theme sent by the host session to the director desk document", () => {
  document.documentElement.classList.add("dark");
  document.documentElement.dataset.theme = "dark";
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_light",
          theme: "light",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(document.documentElement.dataset.theme).toBe("light");
  expect(document.documentElement.classList.contains("dark")).toBe(false);
});

it("applies the dark theme sent by the host session to the director desk document", () => {
  document.documentElement.dataset.theme = "light";
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_dark",
          theme: "dark",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(document.documentElement.dataset.theme).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("rejects a same-origin host message that was not sent by the parent window", () => {
  initDirectorDeskHostBridge();
  const iframe = document.createElement("iframe");
  document.body.appendChild(iframe);
  const nonParentSource = iframe.contentWindow;

  if (!nonParentSource) {
    throw new Error("Expected iframe contentWindow to exist in the test environment");
  }

  try {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: "storyai:director-desk-session",
          payload: {
            instanceId: "node_director_untrusted",
            theme: "light",
          },
        },
        origin: window.location.origin,
        source: nonParentSource,
      }),
    );

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  } finally {
    iframe.remove();
  }
});

it("loads a project and viewport settings sent by the host", () => {
  initDirectorDeskHostBridge();
  const project = {
    ...useDirectorStore.getState().project,
    scene: {
      ...useDirectorStore.getState().project.scene,
      backgroundColor: "#123456",
    },
  };

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_project",
          projectJson: JSON.stringify(project),
          viewMode: "camera",
          viewportAspectRatio: "9:16",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(useDirectorStore.getState().project.scene.backgroundColor).toBe("#123456");
  expect(useDirectorStore.getState().viewMode).toBe("director");
  expect(useDirectorStore.getState().viewportAspectRatio).toBe("9:16");
});

it("posts project changes back to the active host session", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "node_director_sync" },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();
  useDirectorStore.getState().updateScene({ backgroundColor: "#654321" });

  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "storyai:director-desk-project-changed",
      payload: expect.objectContaining({
        instanceId: "node_director_sync",
        projectJson: expect.stringContaining("#654321"),
      }),
    }),
    window.location.origin,
  );
});

it("keeps a local edit dirty across a same-session theme refresh", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const captureHandler = vi.fn(async () => []);
  setViewportCaptureHandler(captureHandler);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "node_director_theme_refresh", revision: 7 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();

  useDirectorStore.getState().updateScene({ backgroundColor: "#765432" });
  expect(postMessage).toHaveBeenCalledTimes(1);
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_theme_refresh",
          revision: 7,
          theme: "light",
          projectJson: "",
          viewMode: undefined,
          viewportAspectRatio: "",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(document.documentElement.dataset.theme).toBe("light");
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "storyai:director-desk-project-changed",
      payload: expect.objectContaining({
        instanceId: "node_director_theme_refresh",
        projectJson: expect.stringContaining("#765432"),
      }),
    }),
    window.location.origin,
  );

  postMessage.mockClear();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-capture-request",
        payload: {
          requestId: "capture-dirty-theme-refresh",
          preset: "current",
          revisionRequested: 7,
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "storyai:director-desk-capture-result",
        payload: expect.objectContaining({
          requestId: "capture-dirty-theme-refresh",
          captures: [],
          error: expect.stringContaining("r7"),
        }),
      }),
      window.location.origin,
    ),
  );
  expect(captureHandler).not.toHaveBeenCalled();
});

it("does not echo hydration or send later changes to the previous session", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "node_director_old" },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();
  useDirectorStore.getState().updateScene({ backgroundColor: "#111111" });
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ instanceId: "node_director_old" }),
    }),
    window.location.origin,
  );
  postMessage.mockClear();

  const incomingProject = {
    ...useDirectorStore.getState().project,
    scene: {
      ...useDirectorStore.getState().project.scene,
      backgroundColor: "#abcdef",
    },
  };
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_new",
          projectJson: JSON.stringify(incomingProject),
          viewMode: "camera",
          viewportAspectRatio: "16:9",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  useDirectorStore.setState({ project: useDirectorStore.getState().project });
  expect(postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "storyai:director-desk-project-changed" }),
    window.location.origin,
  );

  useDirectorStore.getState().updateScene({ backgroundColor: "#fedcba" });
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "storyai:director-desk-project-changed",
      payload: expect.objectContaining({
        instanceId: "node_director_new",
        projectJson: expect.stringContaining("#fedcba"),
      }),
    }),
    window.location.origin,
  );
});

it("forwards rapid project updates immediately for the parent save coalescer", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "node_director_coalesced" },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();

  useDirectorStore.getState().updateScene({ backgroundColor: "#100000" });
  useDirectorStore.getState().updateScene({ backgroundColor: "#200000" });
  useDirectorStore.getState().updateScene({ backgroundColor: "#300000" });
  expect(postMessage).toHaveBeenCalledTimes(3);
  expect(postMessage).toHaveBeenLastCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        instanceId: "node_director_coalesced",
        projectJson: expect.stringContaining("#300000"),
      }),
    }),
    window.location.origin,
  );
});

it("keeps capture dirty until the newest project change is acknowledged", async () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  const captureHandler = vi.fn(async () => []);
  setViewportCaptureHandler(captureHandler);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "node_director_ack_race", revision: 1 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();

  useDirectorStore.getState().updateScene({ backgroundColor: "#110000" });
  useDirectorStore.getState().updateScene({ backgroundColor: "#220000" });
  const projectChanges = postMessage.mock.calls
    .map(([message]) => message)
    .filter((message) => message.type === "storyai:director-desk-project-changed");
  expect(projectChanges.map((message) => message.payload.changeId)).toEqual([1, 2]);

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-revision-ack",
        payload: { instanceId: "node_director_ack_race", revision: 2, changeId: 1 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-capture-request",
        payload: { requestId: "capture-stale-ack", revisionRequested: 2 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "storyai:director-desk-capture-result",
        payload: expect.objectContaining({
          requestId: "capture-stale-ack",
          captures: [],
          error: expect.stringContaining("r2"),
        }),
      }),
      window.location.origin,
    ),
  );
  expect(captureHandler).not.toHaveBeenCalled();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-revision-ack",
        payload: { instanceId: "node_director_ack_race", revision: 3, changeId: 2 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-capture-request",
        payload: { requestId: "capture-current-ack", revisionRequested: 3 },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "storyai:director-desk-capture-result",
        payload: expect.objectContaining({
          requestId: "capture-current-ack",
          captures: [],
        }),
      }),
      window.location.origin,
    ),
  );
  expect(captureHandler).toHaveBeenCalledTimes(1);
});

it("does not post project messages after the host bridge is disposed", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "node_director_disposed" },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  postMessage.mockClear();
  clearDirectorDeskHostBridge();
  useDirectorStore.getState().updateScene({ backgroundColor: "#777777" });
  expect(postMessage).not.toHaveBeenCalled();
});

it("ignores a host panorama message without an image url", () => {
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director",
          sourceNodeId: "node_image",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(useDirectorStore.getState().project.panoramaAssetId).toBeNull();
});

it("notifies the host canvas when a host-connected panorama is removed", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director",
          sourceNodeId: "node_image",
          imageUrl: "data:image/png;base64,panorama",
          fileName: "画布图片.png",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  useDirectorStore.getState().removePanoramaAsset();

  expect(postMessage).toHaveBeenCalledWith(
    {
      type: "storyai:director-desk-panorama-removed",
      payload: {
        edgeId: "edge-image-director",
        sourceNodeId: "node_image",
      },
    },
    window.location.origin,
  );
});

it("does not notify the host canvas when changing to a different card session clears the current panorama", () => {
  const postMessage = vi.spyOn(window.parent, "postMessage").mockImplementation(() => undefined);
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_a",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-panorama",
        payload: {
          edgeId: "edge-image-director-a",
          sourceNodeId: "node_image_a",
          imageUrl: "data:image/png;base64,panorama-a",
          fileName: "画布图片A.png",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: {
          instanceId: "node_director_b",
        },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(postMessage).not.toHaveBeenCalledWith(
    expect.objectContaining({
      type: "storyai:director-desk-panorama-removed",
    }),
    window.location.origin,
  );
});

it("ignores a malformed host project instead of partially hydrating it", () => {
  const before = structuredClone(useDirectorStore.getState().project);
  const malformed = structuredClone(before);
  malformed.objects[0]!.transform.rotation = [0, 0] as unknown as [number, number, number];
  initDirectorDeskHostBridge();

  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "storyai:director-desk-session",
        payload: { instanceId: "invalid-project", projectJson: JSON.stringify(malformed) },
      },
      origin: window.location.origin,
      source: window.parent,
    }),
  );

  expect(useDirectorStore.getState().project).toEqual(before);
});
