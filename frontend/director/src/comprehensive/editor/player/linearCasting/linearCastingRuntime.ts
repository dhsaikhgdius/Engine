import {
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
  type Camera,
  type Object3D,
  type WebGLRenderer,
} from "three";
import { AbilityManager } from "./vendor/abilities/AbilityManager.js";
import { ELEMENTS, settings } from "./vendor/config/settings.js";
import { frame } from "./vendor/core/FrameUniforms.js";
import { BurstSystem } from "./vendor/effects/BurstSphere.js";
import { CameraShake } from "./vendor/effects/CameraShake.js";
import { DecalSystem } from "./vendor/effects/GroundDecals.js";
import { FissureSystem } from "./vendor/effects/GroundFissures.js";
import { LightPool } from "./vendor/effects/LightPool.js";
import { ScreenFlash } from "./vendor/effects/ScreenFlash.js";
import { AimController } from "./vendor/input/AimController.js";
import { ParticleEngine } from "./vendor/particles/ParticleEngine.js";
import { createLinearCastingEnvironment } from "./linearCastingEnvironment";
import { LINEAR_CASTING_ELEMENTS, type LinearCastingElement } from "./linearCastingCatalog";

type AbilityManagerState = AbilityManager & { selected: LinearCastingElement };
type AimControllerState = AimController & { camera: Camera };
type ScreenFlashState = ScreenFlash & { color: { r: number; g: number; b: number }; strength: number };
type FrameUniformState = {
  uTime: { value: number };
  uDelta: { value: number };
  uShaderIntensity: { value: number };
  uGlobalGlow: { value: number };
  uCameraNear: { value: number };
  uCameraFar: { value: number };
  uResolution: { value: { set: (x: number, y: number) => void } };
  uSceneDepth: { value: DataTexture | null };
};

const frameState = frame as FrameUniformState;

function createFarDepthTexture() {
  const texture = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  texture.needsUpdate = true;
  return texture;
}

/**
 * Director-hosted skillshot sandbox: the upstream App loop without its renderer,
 * character, or post stack. Effects land in the live Stage scene.
 */
export class LinearCastingRuntime {
  /** Camera-relative aim controller that drives the casting reticle. */
  readonly aim: AimControllerState;

  /** Upstream ability manager that owns element lifecycle and cast dispatch. */
  readonly abilities: AbilityManagerState;

  /** Shared particle engine that renders per-element VFX. */
  readonly particles: ParticleEngine;

  /** Full-screen flash overlay driven by ability casts. */
  readonly flash: ScreenFlashState;

  /** Camera shake rig that accumulates shake offsets per frame. */
  readonly shake: CameraShake;

  /** Per-element cooldown timers in seconds, keyed by element id. */
  readonly cooldowns = new Map<string, number>(ELEMENTS.map((element: string) => [element, 0]));

  private readonly lights: LightPool;
  private readonly decals: DecalSystem;
  private readonly fissures: FissureSystem;
  private readonly bursts: BurstSystem;
  private readonly dummyDepth = createFarDepthTexture();
  private readonly shakeRig = { shakeOffset: new Vector3(), shakeRoll: 0 };
  private editor: { toggle: () => void; dispose?: () => void } | null = null;
  private elapsed = 0;
  private disposed = false;

  /**
   * Wires the upstream ability system into a Director Stage parent and camera.
   * All effects subsystems are created eagerly and attached to the given parent.
   *
   * @param parent - The Three.js Object3D that owns all casting effect meshes.
   * @param camera - The camera used for aim raycasting and effect positioning.
   */
  constructor(parent: Object3D, camera: Camera) {
    const environment = createLinearCastingEnvironment();
    this.particles = new ParticleEngine(parent);
    this.lights = new LightPool(parent);
    this.decals = new DecalSystem(parent);
    this.fissures = new FissureSystem(parent);
    this.bursts = new BurstSystem(parent);
    this.shake = new CameraShake(this.shakeRig);
    this.flash = new ScreenFlash() as ScreenFlashState;
    this.abilities = new AbilityManager({
      scene: parent,
      camera,
      environment,
      particles: this.particles,
      lights: this.lights,
      decals: this.decals,
      fissures: this.fissures,
      bursts: this.bursts,
      shake: this.shake,
      flash: this.flash,
    }) as AbilityManagerState;
    this.aim = new AimController(camera) as AimControllerState;
    parent.add(this.aim.object3D);
    this.abilities.select(ELEMENTS[0]);
    this.aim.setElement(ELEMENTS[0]);
    this.aim.on("cast", (origin: Vector3, direction: Vector3, distance: number) => {
      this.cast(origin, direction, distance);
    });
  }

  /** The currently selected casting element. */
  get selected(): LinearCastingElement {
    return this.abilities.selected as LinearCastingElement;
  }

  /** The current camera shake offset, consumed by the Stage camera rig. */
  get shakeOffset() {
    return this.shakeRig.shakeOffset;
  }

  /** Replaces the camera used for aim raycasting and effect positioning. */
  setCamera(camera: Camera) {
    this.aim.camera = camera;
  }

  /**
   * Sets the ground plane height for aim raycasting.
   *
   * @param height - World-space Y coordinate of the ground plane.
   */
  setGroundHeight(height: number) {
    this.aim.setGroundHeight(height);
  }

  /**
   * Selects a casting element by id. No-ops when the element is not in the catalog.
   *
   * @param element - The element to select.
   */
  select(element: LinearCastingElement) {
    if (!LINEAR_CASTING_ELEMENTS.includes(element)) return;
    this.abilities.select(element);
    this.aim.setElement(element);
  }

  /**
   * Arms the aim controller for the given element, preparing it to cast.
   * Fails silently when the element is on cooldown.
   *
   * @param element - The element to arm; defaults to the currently selected element.
   * @returns `true` when the arm was accepted, `false` when the element is on cooldown.
   */
  arm(element: LinearCastingElement = this.selected) {
    if ((this.cooldowns.get(element) ?? 0) > 0) return false;
    if (element !== this.selected) this.select(element);
    this.aim.arm();
    return true;
  }

  /**
   * Toggles the aim controller for an element: cancels when the same element is
   * already armed, otherwise arms it.
   *
   * @param element - The element to toggle.
   */
  toggleArm(element: LinearCastingElement) {
    if (this.aim.isArmed && element === this.selected) {
      this.aim.cancel();
      return;
    }
    this.arm(element);
  }

  /**
   * Confirms the current aim and fires the cast.
   *
   * @returns `true` when the cast was confirmed, `false` when the aim is not armed.
   */
  confirm() {
    return this.aim.confirm();
  }

  /** Cancels the current aim without casting. */
  cancel() {
    this.aim.cancel();
  }

  /** Clears all active effects, particles, decals, and resets every subsystem. */
  clearEffects() {
    this.aim.cancel();
    this.abilities.clear();
    this.particles.reset();
    this.decals.clear();
    this.fissures.clear();
    this.bursts.clear();
    this.lights.reset();
    this.shake.reset();
    this.flash.reset();
  }

  /**
   * Toggles the in-world casting ability editor panel. The editor module is
   * lazy-loaded on first invocation so it does not add to the initial bundle.
   */
  toggleEditor() {
    if (this.editor) {
      this.editor.toggle();
      return;
    }
    void import("./vendor/ui/Editor.js").then(({ Editor }) => {
      if (this.disposed || this.editor) return;
      this.editor = new Editor({
        onClear: () => this.clearEffects(),
        onToast: () => undefined,
      });
      // Constructor shows the panel; the first toggle hides it, the second shows it.
      this.editor.toggle();
      this.editor.toggle();
    });
  }

  /**
   * Fires the currently selected element at the given world-space origin and
   * direction, then starts its cooldown timer.
   *
   * @param origin - World-space cast origin.
   * @param direction - Normalized world-space cast direction.
   * @param distance - Maximum cast distance in world units.
   */
  cast(origin: Vector3, direction: Vector3, distance: number) {
    const element = this.selected;
    this.abilities.cast(origin, direction, distance, element);
    this.cooldowns.set(element, Math.max(0, settings[element].cooldown));
  }

  /**
   * Advances the full casting simulation by one frame. Updates frame uniforms,
   * aim, cooldowns, and every effect subsystem. No-ops when disposed.
   *
   * @param dtRaw - Raw frame delta in seconds, before time scaling.
   * @param origin - The current world-space origin of the caster (e.g. character position).
   * @param options - Per-frame options including paused state, camera, and renderer.
   */
  update(dtRaw: number, origin: Vector3, options: { paused: boolean; camera: Camera; gl: WebGLRenderer }) {
    if (this.disposed) return;
    const camera = options.camera as Camera & { near: number; far: number };
    this.setCamera(camera);
    const dt = options.paused ? 0 : dtRaw * settings.global.timeScale;
    this.elapsed += dt;
    frameState.uTime.value = this.elapsed;
    frameState.uDelta.value = dt;
    frameState.uShaderIntensity.value = settings.global.shaderIntensity;
    frameState.uGlobalGlow.value = settings.global.glow;
    frameState.uCameraNear.value = camera.near;
    frameState.uCameraFar.value = camera.far;
    frameState.uResolution.value.set(options.gl.domElement.width, options.gl.domElement.height);
    if (!frameState.uSceneDepth.value) frameState.uSceneDepth.value = this.dummyDepth;

    this.aim.setOrigin(origin);
    this.aim.update(dtRaw);

    for (const element of ELEMENTS) {
      const remaining = this.cooldowns.get(element) ?? 0;
      if (remaining > 0) this.cooldowns.set(element, Math.max(0, remaining - dtRaw));
    }

    this.abilities.update(dt);
    this.particles.flush();
    this.decals.update(dt);
    this.fissures.update(dt);
    this.bursts.update(dt);
    this.lights.update(dt);
    this.shake.update(dtRaw);
    this.flash.update(dtRaw);
  }

  /**
   * Returns the remaining cooldown as a ratio of the element's total cooldown duration.
   * 0 means ready; 1 means the cooldown just started.
   *
   * @param element - The element whose cooldown ratio to query.
   * @returns A value in [0, 1] representing the cooldown progress.
   */
  cooldownRatio(element: LinearCastingElement) {
    const duration = Math.max(0.001, settings[element]?.cooldown ?? 1);
    return Math.min(1, (this.cooldowns.get(element) ?? 0) / duration);
  }

  /**
   * Disposes every subsystem, detaches the aim object from the scene, and
   * releases all GPU resources. Safe to call multiple times.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearEffects();
    this.aim.object3D.removeFromParent();
    this.aim.dispose();
    this.abilities.dispose();
    this.particles.dispose();
    this.decals.dispose();
    this.fissures.dispose();
    this.bursts.dispose();
    this.lights.dispose();
    this.dummyDepth.dispose();
    this.editor?.dispose?.();
    this.editor = null;
  }
}
