import {
  Camera,
  DepthFormat,
  DepthTexture,
  LinearFilter,
  Mesh,
  NearestFilter,
  NoBlending,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  UnsignedIntType,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type PerspectiveCamera,
  type WebGLRenderer,
} from "three";
import { clamp } from "../../../../../../packages/protocol/src/primitives";
import { normalizeDirectorCameraOptics } from "../schema/cameraGeometry";
import {
  applyDirectorAnamorphicProjection,
  getDirectorCameraPhysicalFocalLength,
  getDirectorAnamorphicSensorGate,
  type DirectorAnamorphicProjectionMetadata,
} from "../schema/cameraProjection";
import type { DirectorCameraShot } from "../schema/directorProject";
import type { DirectorShotRenderPassId } from "../shot/shotPackage";
import {
  suppressDirectorCaptureHelpers,
  suppressDirectorEnvironmentDressing,
  type DirectorCaptureVisibilityScope,
} from "./captureVisibility";
import {
  assertDirectorRenderDimension as assertDimension,
  flipDirectorRgbaRowsInPlace as flipRgbaRowsInPlace,
  restoreDirectorRendererState,
  snapshotDirectorRendererState,
  unpremultiplyDirectorRgbaInPlace as unpremultiplyRgbaInPlace,
  type DirectorRendererStateSnapshot,
} from "./renderCaptureUtils";
import {
  captureDirectorRenderPass,
  type DirectorRenderPassCaptureInput,
  type DirectorRenderPassCaptureMetadata,
} from "./renderPassCapture";
import { captureDirectorDepthFloat, type DirectorDepthFloatCaptureMetadata } from "./depthFloatCapture";
import DOF_FRAGMENT_SHADER from "./dofFragment.glsl?raw";
import DOF_VERTEX_SHADER from "./dofVertex.glsl?raw";

export type DirectorDepthOfFieldQuality = "off" | "low" | "high";

export interface DirectorDepthOfFieldOptions {
  /** Explicit master switch. False wins over a non-off quality preset. */
  enabled?: boolean;
  quality?: DirectorDepthOfFieldQuality;
  /** Safety/performance ceiling in final-output pixels. */
  maxBlurPixels?: number;
}

export interface DirectorDepthOfFieldMetrics {
  /** Lens f-stop (aperture ratio); e.g. 2.8. */
  apertureFStop: number;
  /** Distance from the camera to the focal plane in metres. */
  focusDistanceM: number;
  /** Physical focal length of the lens in millimetres. */
  focalLengthMm: number;
  /** Height of the used sensor gate in millimetres. */
  sensorHeightMm: number;
  /** Physical aperture diameter in millimetres (focalLengthMm / fStop). */
  apertureDiameterMm: number;
}

export interface DirectorDepthOfFieldMetadata extends DirectorDepthOfFieldMetrics {
  /** Whether the caller requested depth of field at all. */
  requested: boolean;
  /** Whether the gather pass actually ran (false when bypassed). */
  applied: boolean;
  /** Resolved quality preset that governed the render. */
  quality: DirectorDepthOfFieldQuality;
  /** Reason the gather pass was skipped, when applicable. */
  bypassReason?: "disabled" | "technical-pass" | "zero-blur-budget" | "deep-focus";
  /** Number of Poisson samples used in the gather blur. */
  sampleCount: number;
  /** Downscale factor applied to the internal gather render. */
  renderScale: number;
  /** Hard ceiling on the blur radius in output pixels. */
  maxBlurPixels: number;
  /** The depth buffer encoding used for the gather pass. */
  depthEncoding: "hardware-perspective-depth";
}

/** Metadata for a cinematic render pass that layers anamorphic projection and depth-of-field information on top of the base render-pass metadata. */
export interface DirectorCinematicRenderPassMetadata extends DirectorRenderPassCaptureMetadata {
  anamorphic: DirectorAnamorphicProjectionMetadata;
  depthOfField: DirectorDepthOfFieldMetadata;
}

/** The RGBA pixel payload and its companion metadata for a single cinematic render pass. */
export interface DirectorCinematicRenderPassCaptureResult {
  rgba: Uint8Array;
  metadata: DirectorCinematicRenderPassMetadata;
}

/** Input descriptor for a single cinematic render-pass capture, extending the base capture input with camera-shot optics. */
export interface DirectorCinematicRenderPassCaptureInput extends Omit<DirectorRenderPassCaptureInput, "camera"> {
  camera: PerspectiveCamera;
  cameraShot: DirectorCameraShot;
  depthOfField?: DirectorDepthOfFieldOptions;
}

interface RendererStateSnapshot extends DirectorRendererStateSnapshot {
  viewport: Vector4;
  scissor: Vector4;
  scissorTest: boolean;
}

const DEFAULT_HIGH_QUALITY_MAX_BLUR_PX = 24;
const DEFAULT_LOW_QUALITY_MAX_BLUR_PX = 12;
const MAX_BLUR_PX = 64;

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

/** Derives the thin-lens depth-of-field metrics from a camera shot's optics and sensor gate. */
export function calculateDirectorDepthOfFieldMetrics(cameraShot: DirectorCameraShot): DirectorDepthOfFieldMetrics {
  const optics = normalizeDirectorCameraOptics(cameraShot);
  const focalLengthMm = getDirectorCameraPhysicalFocalLength(cameraShot);
  return {
    apertureFStop: optics.apertureFStop,
    focusDistanceM: optics.focusDistanceM,
    focalLengthMm,
    sensorHeightMm: getDirectorAnamorphicSensorGate(cameraShot).usedSensorHeightMm,
    apertureDiameterMm: focalLengthMm / optics.apertureFStop,
  };
}

/** Thin-lens circle of confusion at the capture gate, expressed in output pixels. */
export function calculateDirectorCircleOfConfusionPixels(
  metrics: DirectorDepthOfFieldMetrics,
  subjectDistanceM: number,
  outputHeightPixels: number,
): number {
  const focalLengthM = metrics.focalLengthMm / 1_000;
  const sensorHeightM = metrics.sensorHeightMm / 1_000;
  const focusDistanceM = Math.max(metrics.focusDistanceM, focalLengthM + 0.000001);
  const distanceM = Math.max(finiteOr(subjectDistanceM, focusDistanceM), focalLengthM + 0.000001);
  const cocM = Math.abs(
    (focalLengthM ** 2 * (focusDistanceM - distanceM)) /
      (Math.max(metrics.apertureFStop, 0.1) * distanceM * (focusDistanceM - focalLengthM)),
  );
  return (cocM / Math.max(sensorHeightM, 0.000001)) * Math.max(1, outputHeightPixels);
}

/** Acceptable circle of confusion: 0.6px on a 2160px-tall output. */
const DEEP_FOCUS_COC_OUTPUT_FRACTION = 0.6 / 2160;

/**
 * A shot focused at or beyond its hyperfocal distance keeps the whole scene
 * inside acceptable sharpness, so the gather pass would only add cost (and,
 * on renderers without real depth textures, artificial uniform blur).
 */
function isDeepFocusCameraShot(metrics: DirectorDepthOfFieldMetrics): boolean {
  const focalLengthM = metrics.focalLengthMm / 1_000;
  const acceptableCocM = Math.max(metrics.sensorHeightMm / 1_000, 0.000001) * DEEP_FOCUS_COC_OUTPUT_FRACTION;
  const hyperfocalM =
    (focalLengthM * focalLengthM) / (Math.max(metrics.apertureFStop, 0.1) * acceptableCocM) + focalLengthM;
  return metrics.focusDistanceM >= hyperfocalM;
}

/**
 * Resolves the full depth-of-field metadata for a shot, deciding whether the
 * gather pass should run and with what parameters. Deep-focus shots, technical
 * passes, and explicitly disabled DoF all bypass the gather.
 */
export function resolveDirectorDepthOfFieldMetadata(
  cameraShot: DirectorCameraShot,
  renderPass: DirectorShotRenderPassId,
  options: DirectorDepthOfFieldOptions | undefined,
): DirectorDepthOfFieldMetadata {
  const metrics = calculateDirectorDepthOfFieldMetrics(cameraShot);
  const requestedQuality = options?.enabled === false ? "off" : (options?.quality ?? "high");
  const requestedRenderScale = requestedQuality === "low" ? 0.5 : 1;
  const requestedSampleCount = requestedQuality === "high" ? 20 : requestedQuality === "low" ? 8 : 0;
  const defaultBlur = requestedQuality === "low" ? DEFAULT_LOW_QUALITY_MAX_BLUR_PX : DEFAULT_HIGH_QUALITY_MAX_BLUR_PX;
  const maxBlurPixels = clamp(finiteOr(options?.maxBlurPixels, defaultBlur), 0, MAX_BLUR_PX);
  const requested = requestedQuality !== "off";
  const bypassReason =
    renderPass !== "clean"
      ? "technical-pass"
      : !requested
        ? "disabled"
        : maxBlurPixels <= 0
          ? "zero-blur-budget"
          : isDeepFocusCameraShot(metrics)
            ? "deep-focus"
            : undefined;

  return {
    ...metrics,
    requested,
    applied: bypassReason === undefined,
    quality: requestedQuality,
    ...(bypassReason ? { bypassReason } : {}),
    sampleCount: bypassReason ? 0 : requestedSampleCount,
    renderScale: bypassReason ? 1 : requestedRenderScale,
    maxBlurPixels,
    depthEncoding: "hardware-perspective-depth",
  };
}

function snapshotRendererState(renderer: WebGLRenderer): RendererStateSnapshot {
  return {
    ...snapshotDirectorRendererState(renderer),
    viewport: renderer.getViewport(new Vector4()).clone(),
    scissor: renderer.getScissor(new Vector4()).clone(),
    scissorTest: renderer.getScissorTest(),
  };
}

function restoreRendererState(renderer: WebGLRenderer, state: RendererStateSnapshot): void {
  restoreDirectorRendererState(renderer, state);
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
}

function bindRendererOutputState(renderer: WebGLRenderer, state: RendererStateSnapshot): void {
  renderer.setRenderTarget(state.renderTarget, state.activeCubeFace, state.activeMipmapLevel);
  renderer.setViewport(state.viewport);
  renderer.setScissor(state.scissor);
  renderer.setScissorTest(state.scissorTest);
}

function createDepthOfFieldMaterial(): ShaderMaterial {
  return new ShaderMaterial({
    blending: NoBlending,
    depthTest: false,
    depthWrite: false,
    fragmentShader: DOF_FRAGMENT_SHADER,
    toneMapped: false,
    uniforms: {
      uColor: { value: null },
      uDepth: { value: null },
      uTexelSize: { value: new Vector2(1, 1) },
      uNear: { value: 0.1 },
      uFar: { value: 2_000 },
      uFocusDistanceM: { value: 5 },
      uFocalLengthM: { value: 0.035 },
      uApertureFStop: { value: 2.8 },
      uSensorHeightM: { value: 0.024 },
      uOutputHeightPx: { value: 1 },
      uMaxBlurPx: { value: 0 },
      uSampleCount: { value: 0 },
      uRenderScale: { value: 1 },
      uAnamorphicSqueeze: { value: 1 },
      uReversedDepthBuffer: { value: 0 },
    },
    vertexShader: DOF_VERTEX_SHADER,
  });
}

function rendererUsesReversedDepth(renderer: WebGLRenderer): boolean {
  // Mock renderers in tests may omit capabilities entirely; treat that as the
  // classic depth buffer, matching three's fallback when EXT_clip_control is missing.
  const capabilities = renderer.capabilities as { reversedDepthBuffer?: boolean } | undefined;
  return capabilities?.reversedDepthBuffer === true;
}

function updateDepthOfFieldMaterial(
  material: ShaderMaterial,
  colorTarget: WebGLRenderTarget,
  camera: PerspectiveCamera,
  metadata: DirectorDepthOfFieldMetadata,
  anamorphic: DirectorAnamorphicProjectionMetadata,
  outputHeight: number,
  renderWidth: number,
  renderHeight: number,
  reversedDepthBuffer: boolean,
): void {
  const focalLengthM = metadata.focalLengthMm / 1_000;
  material.uniforms.uColor!.value = colorTarget.texture;
  material.uniforms.uDepth!.value = colorTarget.depthTexture;
  (material.uniforms.uTexelSize!.value as Vector2).set(1 / renderWidth, 1 / renderHeight);
  material.uniforms.uNear!.value = camera.near;
  material.uniforms.uFar!.value = camera.far;
  material.uniforms.uFocusDistanceM!.value = metadata.focusDistanceM;
  material.uniforms.uFocalLengthM!.value = focalLengthM;
  material.uniforms.uApertureFStop!.value = metadata.apertureFStop;
  material.uniforms.uSensorHeightM!.value = metadata.sensorHeightMm / 1_000;
  material.uniforms.uOutputHeightPx!.value = outputHeight;
  material.uniforms.uMaxBlurPx!.value = metadata.maxBlurPixels;
  material.uniforms.uSampleCount!.value = metadata.sampleCount;
  material.uniforms.uRenderScale!.value = metadata.renderScale;
  material.uniforms.uAnamorphicSqueeze!.value = anamorphic.squeeze;
  material.uniforms.uReversedDepthBuffer!.value = reversedDepthBuffer ? 1 : 0;
}

function withCinematicMetadata(
  result: ReturnType<typeof captureDirectorRenderPass>,
  anamorphic: DirectorAnamorphicProjectionMetadata,
  depthOfField: DirectorDepthOfFieldMetadata,
): DirectorCinematicRenderPassCaptureResult {
  return {
    rgba: result.rgba,
    metadata: { ...result.metadata, anamorphic, depthOfField },
  };
}

function captureDepthOfFieldCleanPass(
  input: DirectorCinematicRenderPassCaptureInput,
  anamorphic: DirectorAnamorphicProjectionMetadata,
  depthOfField: DirectorDepthOfFieldMetadata,
): DirectorCinematicRenderPassCaptureResult {
  const { renderer, scene, camera, width, height } = input;
  const transparentBackground = input.background === "transparent";
  const renderWidth = Math.max(1, Math.round(width * depthOfField.renderScale));
  const renderHeight = Math.max(1, Math.round(height * depthOfField.renderScale));
  const rendererState = snapshotRendererState(renderer);
  const originalOverrideMaterial = scene.overrideMaterial;
  const originalBackground = scene.background;
  const depthTexture = new DepthTexture(renderWidth, renderHeight, UnsignedIntType);
  depthTexture.format = DepthFormat;
  depthTexture.magFilter = NearestFilter;
  depthTexture.minFilter = NearestFilter;
  depthTexture.generateMipmaps = false;

  const colorTarget = new WebGLRenderTarget(renderWidth, renderHeight, {
    depthBuffer: true,
    format: RGBAFormat,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    stencilBuffer: false,
    type: UnsignedByteType,
  });
  colorTarget.depthTexture = depthTexture;
  colorTarget.texture.colorSpace = renderer.outputColorSpace;
  colorTarget.texture.generateMipmaps = false;

  const outputTarget = new WebGLRenderTarget(width, height, {
    depthBuffer: false,
    format: RGBAFormat,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    stencilBuffer: false,
    type: UnsignedByteType,
  });
  outputTarget.texture.colorSpace = renderer.outputColorSpace;
  outputTarget.texture.generateMipmaps = false;

  const material = createDepthOfFieldMaterial();
  updateDepthOfFieldMaterial(
    material,
    colorTarget,
    camera,
    depthOfField,
    anamorphic,
    height,
    renderWidth,
    renderHeight,
    rendererUsesReversedDepth(renderer),
  );
  const geometry = new PlaneGeometry(2, 2);
  const postScene = new Scene();
  postScene.add(new Mesh(geometry, material));
  const postCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // Acquire visibility last so resource-construction failures cannot leave
  // editor helpers hidden before control reaches the restoration block.
  const visibilityScope = suppressDirectorCaptureHelpers(scene);
  const environmentScope: DirectorCaptureVisibilityScope | null = transparentBackground
    ? suppressDirectorEnvironmentDressing(scene)
    : null;

  try {
    scene.overrideMaterial = null;
    if (transparentBackground) {
      // The gather blends premultiplied samples over alpha-0 pixels; the
      // readback below converts the result back to straight alpha.
      scene.background = null;
      renderer.setClearColor(0x000000, 0);
    }
    renderer.autoClear = true;
    renderer.autoClearColor = true;
    renderer.autoClearDepth = true;
    renderer.autoClearStencil = true;

    renderer.setRenderTarget(colorTarget);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    renderer.setRenderTarget(outputTarget);
    renderer.clear(true, true, true);
    renderer.render(postScene, postCamera as Camera);

    const rgba = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(outputTarget, 0, 0, width, height, rgba);
    flipRgbaRowsInPlace(rgba, width, height);
    if (transparentBackground) unpremultiplyRgbaInPlace(rgba);

    return {
      rgba,
      metadata: {
        renderPass: "clean",
        width,
        height,
        pixelFormat: "rgba8",
        bitsPerChannel: 8,
        rowOrder: "top-to-bottom",
        colorSpace: "srgb",
        encoding: "color",
        helpersExcluded: true,
        ...(transparentBackground ? { background: "transparent" as const } : {}),
        anamorphic,
        depthOfField,
      },
    };
  } finally {
    try {
      scene.overrideMaterial = originalOverrideMaterial;
      scene.background = originalBackground;
      environmentScope?.restore();
      visibilityScope.restore();
      restoreRendererState(renderer, rendererState);
    } finally {
      material.dispose();
      geometry.dispose();
      depthTexture.dispose();
      colorTarget.dispose();
      outputTarget.dispose();
    }
  }
}

/**
 * Captures a helper-free pass with scoped anamorphic projection. Depth of
 * field is a clean-pass-only color+hardware-depth post effect; technical
 * passes retain exact data values and can never be blurred.
 */
export function captureDirectorCinematicRenderPass(
  input: DirectorCinematicRenderPassCaptureInput,
): DirectorCinematicRenderPassCaptureResult {
  assertDimension(input.width, "Render width");
  assertDimension(input.height, "Render height");
  const depthOfField = resolveDirectorDepthOfFieldMetadata(input.cameraShot, input.renderPass, input.depthOfField);
  const projectionScope = applyDirectorAnamorphicProjection(input.camera, input.cameraShot);

  try {
    if (!depthOfField.applied) {
      return withCinematicMetadata(captureDirectorRenderPass(input), projectionScope.metadata, depthOfField);
    }
    return captureDepthOfFieldCleanPass(input, projectionScope.metadata, depthOfField);
  } finally {
    projectionScope.restore();
  }
}

export interface DirectorCinematicDepthFloatCaptureInput {
  /** The WebGL renderer to use for the capture. */
  renderer: WebGLRenderer;
  /** The scene containing authored objects. */
  scene: Scene;
  /** Perspective camera whose view and clip planes define the depth range. */
  camera: PerspectiveCamera;
  /** Camera shot providing the anamorphic projection parameters. */
  cameraShot: DirectorCameraShot;
  /** Output raster width in pixels. */
  width: number;
  /** Output raster height in pixels. */
  height: number;
}

/** Float-depth result with anamorphic projection metadata layered on top of the base depth metadata. */
export interface DirectorCinematicDepthFloatCaptureResult {
  depth: Float32Array;
  metadata: DirectorDepthFloatCaptureMetadata & { anamorphic: DirectorAnamorphicProjectionMetadata };
}

/**
 * Float-depth companion to `captureDirectorCinematicRenderPass`: the same
 * scoped anamorphic projection, no depth of field (depth is a technical pass),
 * and a linear eye-space Float32 result instead of 8-bit packed RGBA.
 */
export function captureDirectorCinematicDepthFloat(
  input: DirectorCinematicDepthFloatCaptureInput,
): DirectorCinematicDepthFloatCaptureResult {
  assertDimension(input.width, "Render width");
  assertDimension(input.height, "Render height");
  const projectionScope = applyDirectorAnamorphicProjection(input.camera, input.cameraShot);
  try {
    const captured = captureDirectorDepthFloat({
      renderer: input.renderer,
      scene: input.scene,
      camera: input.camera,
      width: input.width,
      height: input.height,
    });
    return {
      depth: captured.depth,
      metadata: { ...captured.metadata, anamorphic: projectionScope.metadata },
    };
  } finally {
    projectionScope.restore();
  }
}

export interface CreateDirectorCinematicRenderSessionInput {
  /** The WebGL renderer that will own the session's GPU resources. */
  renderer: WebGLRenderer;
  /** The scene rendered by the session; must outlive the session. */
  scene: Scene;
  /** Initial output raster width in pixels. */
  width: number;
  /** Initial output raster height in pixels. */
  height: number;
}

export interface DirectorCinematicRealtimeRenderInput {
  /** Perspective camera for the current frame. */
  camera: PerspectiveCamera;
  /** Camera shot providing anamorphic projection and optics. */
  cameraShot: DirectorCameraShot;
  /** Optional depth-of-field override; defaults to the session's quality preset. */
  depthOfField?: DirectorDepthOfFieldOptions;
  /** Clears only the bound output viewport/scissor before drawing. */
  clearOutput?: boolean;
}

export interface DirectorCinematicRealtimeRenderMetadata {
  /** Output raster width in pixels. */
  width: number;
  /** Output raster height in pixels. */
  height: number;
  /** Whether the render targeted the current viewport or a caller-owned render target. */
  output: "current-viewport" | "render-target";
  /** Editor helpers are always excluded from cinematic renders. */
  helpersExcluded: true;
  /** Anamorphic projection parameters applied for this frame. */
  anamorphic: DirectorAnamorphicProjectionMetadata;
  /** Resolved depth-of-field metadata for this frame. */
  depthOfField: DirectorDepthOfFieldMetadata;
}

/**
 * A persistent, reusable cinematic renderer for real-time PIP and live camera
 * surfaces. Owns the GPU targets, shader, and geometry; renders on demand
 * without per-frame allocations.
 */
export interface DirectorCinematicRenderSession {
  /** Current output raster width. */
  readonly width: number;
  /** Current output raster height. */
  readonly height: number;
  /** Reallocates owned targets only when the requested raster actually changes. */
  resize: (width: number, height: number) => void;
  /** Blits into the renderer target, viewport, and scissor active on entry. */
  renderToCurrentViewport: (input: DirectorCinematicRealtimeRenderInput) => DirectorCinematicRealtimeRenderMetadata;
  /** Renders into the full area of a caller-owned target. */
  renderToTarget: (
    target: WebGLRenderTarget,
    input: DirectorCinematicRealtimeRenderInput,
  ) => DirectorCinematicRealtimeRenderMetadata;
  /** Releases all owned GPU resources. */
  dispose: () => void;
}

interface OwnedColorDepthTarget {
  target: WebGLRenderTarget;
  depthTexture: DepthTexture;
}

function createOwnedColorDepthTarget(
  width: number,
  height: number,
  outputColorSpace: WebGLRenderer["outputColorSpace"],
): OwnedColorDepthTarget {
  const depthTexture = new DepthTexture(width, height, UnsignedIntType);
  depthTexture.format = DepthFormat;
  depthTexture.magFilter = NearestFilter;
  depthTexture.minFilter = NearestFilter;
  depthTexture.generateMipmaps = false;
  const target = new WebGLRenderTarget(width, height, {
    depthBuffer: true,
    format: RGBAFormat,
    magFilter: LinearFilter,
    minFilter: LinearFilter,
    stencilBuffer: false,
    type: UnsignedByteType,
  });
  target.depthTexture = depthTexture;
  target.texture.colorSpace = outputColorSpace;
  target.texture.generateMipmaps = false;
  return { target, depthTexture };
}

function resizeOwnedColorDepthTarget(owned: OwnedColorDepthTarget, width: number, height: number): void {
  if (owned.target.width === width && owned.target.height === height) return;
  owned.target.setSize(width, height);
}

function disposeOwnedColorDepthTarget(owned: OwnedColorDepthTarget): void {
  owned.depthTexture.dispose();
  owned.target.dispose();
}

/**
 * Creates a persistent clean-view renderer for PIP/live camera surfaces.
 * WebGL targets, shader, geometry, and post scene are allocated once; `render`
 * only updates uniforms and issues draw calls. Low/high quality targets coexist
 * so switching quality does not allocate GPU resources mid-frame.
 */
export function createDirectorCinematicRenderSession({
  renderer,
  scene,
  width: initialWidth,
  height: initialHeight,
}: CreateDirectorCinematicRenderSessionInput): DirectorCinematicRenderSession {
  assertDimension(initialWidth, "Render width");
  assertDimension(initialHeight, "Render height");

  let width = initialWidth;
  let height = initialHeight;
  let disposed = false;
  const highTarget = createOwnedColorDepthTarget(width, height, renderer.outputColorSpace);
  const lowTarget = createOwnedColorDepthTarget(
    Math.max(1, Math.round(width * 0.5)),
    Math.max(1, Math.round(height * 0.5)),
    renderer.outputColorSpace,
  );
  const material = createDepthOfFieldMaterial();
  const geometry = new PlaneGeometry(2, 2);
  const postScene = new Scene();
  postScene.add(new Mesh(geometry, material));
  const postCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const ensureActive = () => {
    if (disposed) throw new Error("Director cinematic render session has been disposed.");
  };

  const render = (
    output: { kind: "current" } | { kind: "target"; target: WebGLRenderTarget },
    input: DirectorCinematicRealtimeRenderInput,
  ): DirectorCinematicRealtimeRenderMetadata => {
    ensureActive();
    if (output.kind === "target" && (output.target.width !== width || output.target.height !== height)) {
      throw new Error(
        `Cinematic output target must match the session raster ${width}x${height}; received ${output.target.width}x${output.target.height}.`,
      );
    }
    const rendererState = snapshotRendererState(renderer);
    const originalOverrideMaterial = scene.overrideMaterial;
    const depthOfField = resolveDirectorDepthOfFieldMetadata(input.cameraShot, "clean", input.depthOfField);
    const projectionScope = applyDirectorAnamorphicProjection(input.camera, input.cameraShot);
    const visibilityScope = suppressDirectorCaptureHelpers(scene);
    const bindOutput = () => {
      if (output.kind === "current") {
        renderer.setRenderTarget(null);
        bindRendererOutputState(renderer, rendererState);
        return;
      }
      renderer.setRenderTarget(output.target);
      renderer.setViewport(0, 0, width, height);
      renderer.setScissor(0, 0, width, height);
      renderer.setScissorTest(false);
    };

    try {
      scene.overrideMaterial = null;
      renderer.autoClear = false;

      if (depthOfField.applied) {
        const owned = depthOfField.quality === "low" ? lowTarget : highTarget;
        const renderWidth = owned.target.width;
        const renderHeight = owned.target.height;
        renderer.setRenderTarget(owned.target);
        renderer.setViewport(0, 0, renderWidth, renderHeight);
        renderer.setScissor(0, 0, renderWidth, renderHeight);
        renderer.setScissorTest(false);
        renderer.clear(true, true, true);
        renderer.render(scene, input.camera);

        updateDepthOfFieldMaterial(
          material,
          owned.target,
          input.camera,
          depthOfField,
          projectionScope.metadata,
          height,
          renderWidth,
          renderHeight,
          rendererUsesReversedDepth(renderer),
        );
        bindOutput();
        if (input.clearOutput !== false) renderer.clear(true, true, true);
        renderer.render(postScene, postCamera);
      } else {
        bindOutput();
        if (input.clearOutput !== false) renderer.clear(true, true, true);
        renderer.render(scene, input.camera);
      }

      return {
        width,
        height,
        output: output.kind === "current" ? "current-viewport" : "render-target",
        helpersExcluded: true,
        anamorphic: projectionScope.metadata,
        depthOfField,
      };
    } finally {
      try {
        scene.overrideMaterial = originalOverrideMaterial;
        visibilityScope.restore();
        projectionScope.restore();
      } finally {
        restoreRendererState(renderer, rendererState);
      }
    }
  };

  return {
    get width() {
      return width;
    },
    get height() {
      return height;
    },
    resize: (nextWidth, nextHeight) => {
      ensureActive();
      assertDimension(nextWidth, "Render width");
      assertDimension(nextHeight, "Render height");
      if (nextWidth === width && nextHeight === height) return;
      width = nextWidth;
      height = nextHeight;
      resizeOwnedColorDepthTarget(highTarget, width, height);
      resizeOwnedColorDepthTarget(
        lowTarget,
        Math.max(1, Math.round(width * 0.5)),
        Math.max(1, Math.round(height * 0.5)),
      );
    },
    renderToCurrentViewport: (input) => render({ kind: "current" }, input),
    renderToTarget: (target, input) => render({ kind: "target", target }, input),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      material.dispose();
      geometry.dispose();
      disposeOwnedColorDepthTarget(highTarget);
      disposeOwnedColorDepthTarget(lowTarget);
    },
  };
}
