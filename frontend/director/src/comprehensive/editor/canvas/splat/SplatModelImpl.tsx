import { ExtSplats, PackedSplats, SparkRenderer, SplatLoader, SplatMesh } from "@sparkjsdev/spark";
import { useLoader, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo } from "react";
import { Box3, FileLoader, Vector3, type WebGLRenderer } from "three";
import {
  DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
  getImportedModelNormalization,
} from "../../runtime/importedModelGeometry";
import {
  directorSplatSequenceManifestSchema,
  isDirectorSplatSequenceManifestFileName,
  resolveDirectorSplatSequenceFrameUrls,
} from "../../loaders/splatFormats";
import { getDirectorTimelineFps } from "../../timeline/frameRate";
import { useDirectorStore } from "../../store/directorStore";
import { useTimelineRuntimeStore } from "../../runtime/timelineRuntimeStore";
import type { DirectorSplatModelProps } from "./SplatModel";

/**
 * One SparkRenderer instance drives every splat under a given WebGL context
 * (main stage, asset preview, and model library canvases each get their own).
 * `onDirty` bridges Spark's asynchronous sort completions into R3F's
 * demand-driven frameloop so reordered splats repaint without user input.
 */
interface SparkRendererEntry {
  spark: SparkRenderer;
  refs: number;
}

const sparkRenderers = new WeakMap<WebGLRenderer, SparkRendererEntry>();

function useDirectorSparkRenderer() {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const invalidate = useThree((state) => state.invalidate);

  useEffect(() => {
    let entry = sparkRenderers.get(gl);
    if (!entry) {
      entry = { spark: new SparkRenderer({ renderer: gl, onDirty: () => invalidate() }), refs: 0 };
      sparkRenderers.set(gl, entry);
    }
    entry.refs += 1;
    if (entry.spark.parent !== scene) scene.add(entry.spark);
    invalidate();
    return () => {
      entry.refs -= 1;
      if (entry.refs <= 0) {
        sparkRenderers.delete(gl);
        entry.spark.removeFromParent();
        entry.spark.dispose();
      }
      invalidate();
    };
  }, [gl, scene, invalidate]);
}

/**
 * Splat centers are decoded once per cached asset; the box feeds the shared
 * imported-model normalization so splat captures land on the same metric
 * stage scale as mesh imports.
 */
const splatBoundsCache = new WeakMap<PackedSplats | ExtSplats, Box3>();

function getSplatSourceBounds(source: PackedSplats | ExtSplats): Box3 {
  let bounds = splatBoundsCache.get(source);
  if (!bounds) {
    const computed = new Box3();
    source.forEachSplat((_index, center) => computed.expandByPoint(center));
    splatBoundsCache.set(source, computed);
    bounds = computed;
  }
  return bounds;
}

/**
 * Gaussian splat captures conventionally use the OpenCV/COLMAP camera frame
 * (Y down, Z back); a baked 180° X rotation brings them upright in Director's
 * Y-up stage. The bounds are remapped into the rotated frame before
 * normalization so grounding and metric scaling see the upright capture.
 */
const SPLAT_UPRIGHT_ROTATION: [number, number, number] = [Math.PI, 0, 0];

function rotateSplatBoundsUpright(bounds: Box3): Box3 {
  if (bounds.isEmpty()) return new Box3();
  return new Box3(
    new Vector3(bounds.min.x, -bounds.max.y, -bounds.max.z),
    new Vector3(bounds.max.x, -bounds.min.y, -bounds.min.z),
  );
}

function useNormalizedSplatLayout(
  source: PackedSplats | ExtSplats,
  grounded: boolean,
  modelNormalization: "auto" | "preserve",
  realWorldSizeM: number | undefined,
  onCenterChange: DirectorSplatModelProps["onCenterChange"],
) {
  const layout = useMemo(() => {
    const uprightBounds = rotateSplatBoundsUpright(getSplatSourceBounds(source));
    const size = new Vector3();
    const center = new Vector3();
    uprightBounds.getSize(size);
    uprightBounds.getCenter(center);
    return {
      normalization: getImportedModelNormalization(
        uprightBounds,
        DIRECTOR_IMPORTED_MODEL_TARGET_MAX_SIZE,
        modelNormalization,
        grounded,
        realWorldSizeM,
      ),
      hitCenter: [center.x, center.y, center.z] as [number, number, number],
      hitSize: [Math.max(size.x, 0.01), Math.max(size.y, 0.01), Math.max(size.z, 0.01)] as [number, number, number],
    };
  }, [grounded, modelNormalization, realWorldSizeM, source]);

  useLayoutEffect(() => {
    onCenterChange?.(layout.normalization.center);
  }, [layout.normalization.center, onCenterChange]);

  return layout;
}

function NormalizedSplatGroup({
  layout,
  splatMesh,
}: {
  layout: ReturnType<typeof useNormalizedSplatLayout>;
  splatMesh: SplatMesh;
}) {
  const { normalization, hitCenter, hitSize } = layout;
  return (
    <group position={normalization.position} scale={[normalization.scale, normalization.scale, normalization.scale]}>
      <group rotation={SPLAT_UPRIGHT_ROTATION}>
        {/* R3F auto-dispose would destroy the useLoader-cached PackedSplats shared across mounts. */}
        <primitive dispose={null} object={splatMesh} />
      </group>
      {/* Splat raycasting scans every splat per pointer event, so picking runs
          against an invisible proxy box over the capture bounds instead. The
          helper flags keep the box out of drop placement, ground probes, and
          player/camera collision, which would otherwise treat it as an
          invisible wall the size of the capture. */}
      <mesh
        name="splat-hit-proxy"
        position={hitCenter}
        userData={{
          hideFromViewportCapture: true,
          collisionDisabled: true,
          directorCollisionDisabled: true,
          directorGroundRaycastDisabled: true,
        }}
      >
        <boxGeometry args={hitSize} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}

function SingleSplatModel({
  grounded = false,
  modelNormalization = "auto",
  realWorldSizeM,
  url,
  onCenterChange,
}: DirectorSplatModelProps) {
  useDirectorSparkRenderer();
  const invalidate = useThree((state) => state.invalidate);
  const decoded = useLoader(SplatLoader, url) as PackedSplats | ExtSplats;
  const layout = useNormalizedSplatLayout(decoded, grounded, modelNormalization, realWorldSizeM, onCenterChange);

  const splatMesh = useMemo(
    () =>
      new SplatMesh(
        decoded instanceof PackedSplats
          ? { packedSplats: decoded, raycastable: false }
          : { extSplats: decoded, raycastable: false },
      ),
    [decoded],
  );

  useEffect(() => {
    let cancelled = false;
    // Repaint once decoding settles on demand-driven frameloops.
    void splatMesh.initialized.then(() => {
      if (!cancelled) invalidate();
    });
    return () => {
      cancelled = true;
    };
  }, [invalidate, splatMesh]);

  return <NormalizedSplatGroup layout={layout} splatMesh={splatMesh} />;
}

/** Frames within one loaded sequence budget; tuned for ~1M-splat frames (~16 MB each). */
const SPLAT_SEQUENCE_MAX_CACHED_FRAMES = 12;
const SPLAT_SEQUENCE_PREFETCH_AHEAD = 4;

/**
 * Bounded flipbook pager for 4DGS playback. Frame 0 belongs to the shared
 * useLoader cache and anchors normalization; the pager owns every other
 * decoded frame with LRU eviction so long sequences never load fully into
 * memory. Frame swaps assign `mesh.packedSplats`, which Spark detects on its
 * next update to rebind the generator.
 */
class SplatSequenceFramePager {
  private readonly cache = new Map<number, { splats: PackedSplats; lastUsed: number }>();
  private readonly loading = new Map<number, Promise<void>>();
  private clock = 0;
  private desired = 0;
  private applied = -1;
  private disposed = false;

  constructor(
    private readonly frameUrls: readonly string[],
    private readonly firstFrame: PackedSplats,
    private readonly mesh: SplatMesh,
    private readonly onFrameApplied: () => void,
  ) {}

  show(index: number) {
    if (this.disposed || !this.frameUrls.length) return;
    const target = ((index % this.frameUrls.length) + this.frameUrls.length) % this.frameUrls.length;
    this.desired = target;
    const ready = this.acquire(target);
    if (ready) this.apply(target, ready);
    for (let ahead = 1; ahead <= SPLAT_SEQUENCE_PREFETCH_AHEAD; ahead += 1) {
      this.ensureLoaded((target + ahead) % this.frameUrls.length);
    }
    this.evict();
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.cache.values()) entry.splats.dispose();
    this.cache.clear();
    this.loading.clear();
  }

  private acquire(index: number): PackedSplats | null {
    if (index === 0) return this.firstFrame;
    const entry = this.cache.get(index);
    if (entry) {
      entry.lastUsed = ++this.clock;
      return entry.splats;
    }
    this.ensureLoaded(index);
    return null;
  }

  private apply(index: number, splats: PackedSplats) {
    if (this.applied === index) return;
    this.applied = index;
    this.mesh.packedSplats = splats;
    this.onFrameApplied();
  }

  private ensureLoaded(index: number) {
    if (index === 0 || this.cache.has(index) || this.loading.has(index)) return;
    const packed = new PackedSplats({ url: this.frameUrls[index] });
    const pending = packed.initialized
      .then(() => {
        if (this.disposed) {
          packed.dispose();
          return;
        }
        this.cache.set(index, { splats: packed, lastUsed: ++this.clock });
        if (this.desired === index) this.apply(index, packed);
      })
      .catch(() => {
        // A missing or malformed frame leaves the previous frame on screen.
      })
      .finally(() => {
        this.loading.delete(index);
      });
    this.loading.set(index, pending);
  }

  private evict() {
    while (this.cache.size > SPLAT_SEQUENCE_MAX_CACHED_FRAMES) {
      let oldestIndex = -1;
      let oldestUsed = Number.POSITIVE_INFINITY;
      for (const [index, entry] of this.cache) {
        if (index === this.desired || index === this.applied) continue;
        if (entry.lastUsed < oldestUsed) {
          oldestUsed = entry.lastUsed;
          oldestIndex = index;
        }
      }
      if (oldestIndex < 0) return;
      this.cache.get(oldestIndex)?.splats.dispose();
      this.cache.delete(oldestIndex);
    }
  }
}

function SplatSequenceModel({
  grounded = false,
  modelNormalization = "auto",
  realWorldSizeM,
  url,
  onCenterChange,
}: DirectorSplatModelProps) {
  useDirectorSparkRenderer();
  const invalidate = useThree((state) => state.invalidate);
  const manifestText = useLoader(FileLoader, url) as string;
  const manifest = useMemo(() => directorSplatSequenceManifestSchema.parse(JSON.parse(manifestText)), [manifestText]);
  const frameUrls = useMemo(() => resolveDirectorSplatSequenceFrameUrls(url, manifest.frames), [manifest.frames, url]);

  // The first frame anchors suspense, bounds, and metric normalization for the
  // whole sequence; per-frame re-normalization would jitter the stage placement.
  const firstFrame = useLoader(SplatLoader, frameUrls[0]) as PackedSplats;
  const layout = useNormalizedSplatLayout(firstFrame, grounded, modelNormalization, realWorldSizeM, onCenterChange);
  const splatMesh = useMemo(() => new SplatMesh({ packedSplats: firstFrame, raycastable: false }), [firstFrame]);

  const timelineFps = useDirectorStore((state) => getDirectorTimelineFps(state.project.scene.timeline));
  const pager = useMemo(
    () => new SplatSequenceFramePager(frameUrls, firstFrame, splatMesh, () => invalidate()),
    [firstFrame, frameUrls, invalidate, splatMesh],
  );

  useEffect(() => {
    const applyPlayhead = (playheadFrame: number) => {
      const seconds = Math.max(0, playheadFrame) / timelineFps;
      pager.show(Math.floor(seconds * manifest.fps));
    };
    applyPlayhead(useTimelineRuntimeStore.getState().playheadFrame);
    const unsubscribe = useTimelineRuntimeStore.subscribe((state) => applyPlayhead(state.playheadFrame));
    return () => {
      unsubscribe();
      pager.dispose();
    };
  }, [manifest.fps, pager, timelineFps]);

  return <NormalizedSplatGroup layout={layout} splatMesh={splatMesh} />;
}

export default function SplatModelImpl(props: DirectorSplatModelProps) {
  if (isDirectorSplatSequenceManifestFileName(props.fileName)) return <SplatSequenceModel {...props} />;
  return <SingleSplatModel {...props} />;
}
