import { toggleProductDemoTheme } from "./directorHomeTheme";

type DemoObjectKey = "camera" | "character" | "scene";
type DemoPanelKey = "properties" | "assets";
type DemoLocale = "en" | "zh";

type DemoObjectCopy = Record<
  DemoObjectKey,
  { title: string; kind: string; selection: string; axis: readonly [string, string, string] }
>;

const DEMO_OBJECTS: Record<DemoLocale, DemoObjectCopy> = {
  zh: {
    camera: { title: "相机 01", kind: "摄影机", selection: "相机 01", axis: ["1.23", "0.45", "−2.10"] },
    character: { title: "人物 01", kind: "基础白模", selection: "人物 01", axis: ["0.00", "0.00", "0.00"] },
    scene: { title: "场景地面", kind: "环境", selection: "场景地面", axis: ["0.00", "0.00", "0.00"] },
  },
  en: {
    camera: { title: "Camera 01", kind: "Cinema camera", selection: "Camera 01", axis: ["1.23", "0.45", "−2.10"] },
    character: {
      title: "Character 01",
      kind: "Base mannequin",
      selection: "Character 01",
      axis: ["0.00", "0.00", "0.00"],
    },
    scene: { title: "Scene Ground", kind: "Environment", selection: "Scene Ground", axis: ["0.00", "0.00", "0.00"] },
  },
};

const DEMO_STRINGS = {
  zh: {
    pauseTimeline: "暂停时间轴",
    playTimeline: "播放时间轴",
    cameraView: "相机视图",
    directorView: "导演视图",
  },
  en: {
    pauseTimeline: "Pause the timeline",
    playTimeline: "Play the timeline",
    cameraView: "Camera view",
    directorView: "Director view",
  },
} satisfies Record<DemoLocale, unknown>;

function mountDemo(root: HTMLElement) {
  if (root.dataset.demoMounted === "true") return;
  root.dataset.demoMounted = "true";

  const locale: DemoLocale = root.closest<HTMLElement>("[data-director-home]")?.dataset.locale === "zh" ? "zh" : "en";
  const objects = DEMO_OBJECTS[locale];
  const strings = DEMO_STRINGS[locale];

  const get = <ElementType extends Element>(selector: string) => root.querySelector<ElementType>(selector)!;
  const preview = get<HTMLElement>("[data-demo-preview]");
  const timeline = get<HTMLElement>("[data-demo-timeline]");
  const timecode = get<HTMLOutputElement>("[data-demo-timecode]");
  const scrubber = get<HTMLInputElement>("[data-demo-scrubber]");
  const playButton = get<HTMLButtonElement>("[data-demo-play]");
  const playIcon = get<SVGUseElement>("[data-demo-play] use");
  const focalInput = get<HTMLInputElement>("[data-demo-focal]");
  const focalOutput = get<HTMLOutputElement>("[data-demo-focal-output]");
  const lensLabel = get<HTMLElement>("[data-demo-lens-label]");
  const cameraProperties = get<HTMLElement>("[data-demo-camera-properties]");
  const inspectorTitle = get<HTMLElement>("[data-demo-inspector-title]");
  const inspectorKind = get<HTMLElement>("[data-demo-inspector-kind]");
  const selectionName = get<HTMLElement>("[data-demo-selection-name]");

  let selectedObject: DemoObjectKey = "camera";
  let frame = Number(scrubber.value);
  let playing = false;
  let animationFrame = 0;
  let previousTime = 0;

  function showPanel(panel: DemoPanelKey) {
    root.querySelectorAll<HTMLButtonElement>("[data-demo-panel]").forEach((button) => {
      button.setAttribute("aria-selected", String(button.dataset.demoPanel === panel));
    });
    root.querySelectorAll<HTMLElement>("[data-demo-pane]").forEach((pane) => {
      const active = pane.dataset.demoPane === panel;
      pane.hidden = !active;
      pane.classList.toggle("is-active", active);
    });
  }

  function selectObject(key: DemoObjectKey) {
    selectedObject = key;
    const object = objects[key];
    root.querySelectorAll<HTMLButtonElement>("[data-demo-object]").forEach((button) => {
      const active = button.dataset.demoObject === key;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    preview.dataset.selected = key;
    inspectorTitle.textContent = object.title;
    inspectorKind.textContent = object.kind;
    selectionName.textContent = object.selection;
    root.querySelectorAll<HTMLElement>("[data-demo-axis]").forEach((value, index) => {
      value.textContent = object.axis[index] ?? "0.00";
    });
    cameraProperties.hidden = key !== "camera";
  }

  function formatTimecode(currentFrame: number) {
    const wholeFrame = Math.round(currentFrame);
    const totalSeconds = Math.floor(wholeFrame / 24);
    const seconds = totalSeconds % 60;
    const minutes = Math.floor(totalSeconds / 60);
    const framePart = wholeFrame % 24;
    return `00:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}:${String(framePart).padStart(2, "0")}`;
  }

  function renderFrame(nextFrame: number) {
    frame = Math.max(0, Math.min(240, nextFrame));
    scrubber.value = String(Math.round(frame));
    timecode.value = formatTimecode(frame);
    const progress = frame / 240;
    root.style.setProperty("--dh-demo-progress", `${15.5 + progress * 83.5}%`);
    preview.style.setProperty("--dh-demo-playback-x", `${(progress - 0.5) * 8}px`);
  }

  function setPlaying(nextPlaying: boolean) {
    playing = nextPlaying;
    playButton.setAttribute("aria-label", playing ? strings.pauseTimeline : strings.playTimeline);
    playIcon.setAttribute("href", playing ? "#dh-icon-pause" : "#dh-icon-play");
    if (!playing) {
      window.cancelAnimationFrame(animationFrame);
      previousTime = 0;
      return;
    }
    animationFrame = window.requestAnimationFrame(tick);
  }

  function tick(timestamp: number) {
    if (!playing) return;
    if (previousTime) {
      const nextFrame = frame + ((timestamp - previousTime) / 1000) * 24;
      renderFrame(nextFrame > 240 ? 0 : nextFrame);
    }
    previousTime = timestamp;
    animationFrame = window.requestAnimationFrame(tick);
  }

  root.querySelectorAll<HTMLButtonElement>("[data-demo-object]").forEach((button) => {
    button.addEventListener("click", () => selectObject(button.dataset.demoObject as DemoObjectKey));
  });

  get<HTMLInputElement>("[data-demo-search]").addEventListener("input", (event) => {
    const query = (event.currentTarget as HTMLInputElement).value.trim().toLocaleLowerCase();
    let matches = 0;
    root.querySelectorAll<HTMLElement>("[data-demo-group]").forEach((group) => {
      const item = group.querySelector<HTMLButtonElement>("[data-demo-object]")!;
      const visible = !query || item.textContent!.toLocaleLowerCase().includes(query);
      item.hidden = !visible;
      group.hidden = !visible;
      if (visible) matches += 1;
    });
    get<HTMLElement>("[data-demo-search-empty]").hidden = matches > 0;
  });

  root.querySelectorAll<HTMLButtonElement>("[data-demo-panel]").forEach((button) => {
    button.addEventListener("click", () => showPanel(button.dataset.demoPanel as DemoPanelKey));
  });

  root.querySelectorAll<HTMLButtonElement>("[data-demo-asset-object]").forEach((button) => {
    button.addEventListener("click", () => {
      selectObject(button.dataset.demoAssetObject as DemoObjectKey);
      showPanel("properties");
    });
  });

  focalInput.addEventListener("input", () => {
    const focalLength = Number(focalInput.value);
    const label = `${focalLength} mm`;
    focalOutput.value = label;
    lensLabel.textContent = label;
    get<HTMLElement>('[data-demo-object="camera"] small').textContent = label;
    preview.style.setProperty("--dh-demo-lens-scale", String(1 + (focalLength - 35) / 350));
  });

  root.querySelectorAll<HTMLButtonElement>("[data-demo-viewport-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.demoViewportAction;
      if (action === "frame") {
        preview.classList.remove("is-framing");
        window.requestAnimationFrame(() => preview.classList.add("is-framing"));
        window.setTimeout(() => preview.classList.remove("is-framing"), 450);
      }
      if (action === "grid") {
        const visible = preview.classList.toggle("is-grid-hidden") === false;
        button.setAttribute("aria-pressed", String(visible));
      }
      if (action === "camera") {
        const active = preview.classList.toggle("is-camera-view");
        button.setAttribute("aria-pressed", String(active));
        get<HTMLElement>("[data-demo-view-label]").textContent = active ? strings.cameraView : strings.directorView;
      }
    });
  });

  get<HTMLButtonElement>("[data-demo-theme]").addEventListener("click", () => {
    toggleProductDemoTheme();
  });

  playButton.addEventListener("click", () => setPlaying(!playing));
  get<HTMLButtonElement>("[data-demo-reset]").addEventListener("click", () => {
    setPlaying(false);
    renderFrame(0);
  });
  scrubber.addEventListener("pointerdown", () => setPlaying(false));
  scrubber.addEventListener("input", () => renderFrame(Number(scrubber.value)));

  window.addEventListener(
    "pagehide",
    () => {
      window.cancelAnimationFrame(animationFrame);
    },
    { once: true },
  );

  selectObject("camera");
  renderFrame(frame);
}

export function mountDirectorProductDemo() {
  document.querySelectorAll<HTMLElement>("[data-director-product-demo]").forEach(mountDemo);
}
