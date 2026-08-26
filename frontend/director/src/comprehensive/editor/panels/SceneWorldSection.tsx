import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  InspectorAxisGroup,
  InspectorColorField,
  InspectorRangeNumberField,
  InspectorSection,
  InspectorSelectField,
  InspectorTextField,
} from "./InspectorControls";
import { useDirectorStore } from "../store/directorStore";
import type {
  DirectorWorldEffect,
  DirectorWorldRoad,
  DirectorWorldWaterBody,
  DirectorWorldWildlifeGroup,
  WorldEffectKind,
  WorldWildlifeSpecies,
} from "../schema/directorProject";
import {
  DIRECTOR_WORLD_RIVER_MAX_POINTS,
  DIRECTOR_WORLD_ROAD_MAX_POINTS,
  DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
  WORLD_EFFECT_KINDS,
  WORLD_WEATHER_PRESETS,
  WORLD_WILDLIFE_SPECIES,
  createDefaultDirectorWorldSettings,
  type DirectorWorldRiver,
  type WorldEmitterShape,
  type WorldWeatherEvolutionMode,
  type WorldWeatherPreset,
} from "../../../../../../packages/protocol/src/worldSystemsProtocol";
import { useTimelineRuntimeStore } from "../runtime/timelineRuntimeStore";
import { evaluateWorldClimate, isWorldWeatherEvolving } from "../world/worldClimate";
import { getWorldSecondsForFrame } from "../world/worldTime";
import { getWorldAmbientOffsetSeconds } from "../world/worldClock";
import { computeWaterAmplitudeScale } from "../world/water/waterParams";
import {
  buildWaterSpatialIndex,
  findCombustionWaterConflict,
  findRoadWaterConflict,
  raiseRoadAboveWater,
  type WaterSpatialIndex,
} from "../world/worldWaterSpatial";

const WORLD_EFFECT_KIND_LABELS: Record<WorldEffectKind, string> = {
  fire: "火焰",
  smoke: "烟雾",
  steam: "蒸汽",
  sparks: "火花",
  fireflies: "萤火虫",
  dust: "尘埃",
  rain: "雨幕",
  snow: "飘雪",
};

const WORLD_WEATHER_PRESET_LABELS: Record<WorldWeatherPreset, string> = {
  clear: "晴朗",
  overcast: "阴天",
  rain: "降雨",
  snow: "降雪",
  storm: "风暴",
};

const WORLD_WILDLIFE_SPECIES_LABELS: Record<WorldWildlifeSpecies, string> = {
  birds: "鸟群",
  butterflies: "蝴蝶",
  fish: "鱼群",
  deer: "鹿群",
  rabbits: "兔群",
  wolves: "狼群",
  sheep: "羊群",
};

type WorldEmitterShapeType = WorldEmitterShape["type"];

const WORLD_EFFECT_SHAPE_TYPES: readonly WorldEmitterShapeType[] = ["point", "sphere", "disc", "box"];

/** "点" alone already means mesh vertices elsewhere; keep the emitter label distinct. */
const WORLD_EFFECT_SHAPE_LABELS: Record<WorldEmitterShapeType, string> = {
  point: "点状",
  sphere: "球体",
  disc: "圆盘",
  box: "盒体",
};

/** Mirrors the authoring-action defaults in agent/directorAuthoring.ts. */
const WORLD_EFFECT_WIND_INFLUENCE: Record<WorldEffectKind, number> = {
  fire: 0.35,
  smoke: 0.8,
  steam: 0.7,
  sparks: 0.5,
  fireflies: 0.25,
  dust: 0.9,
  rain: 1,
  snow: 1,
};

const WORLD_WILDLIFE_DEFAULT_COUNT: Record<WorldWildlifeSpecies, number> = {
  birds: 24,
  butterflies: 16,
  fish: 40,
  deer: 6,
  rabbits: 8,
  wolves: 4,
  sheep: 10,
};

type WorldPanelTab = "climate" | "effects" | "water" | "wildlife" | "traffic";

const WORLD_PANEL_TABS: Array<{ id: WorldPanelTab; label: string }> = [
  { id: "climate", label: "气候" },
  { id: "effects", label: "效果" },
  { id: "water", label: "水体" },
  { id: "wildlife", label: "生态" },
  { id: "traffic", label: "交通" },
];

type WorldChoiceOption<T extends string | number> = {
  value: T;
  label: string;
  description?: string;
};

type WorldWindPresetId = "still" | "breeze" | "windy" | "strong";

const WORLD_WIND_PRESETS: ReadonlyArray<
  WorldChoiceOption<WorldWindPresetId> & {
    wind: { speedMps: number; gustiness: number; turbulence: number };
  }
> = [
  {
    value: "still",
    label: "静稳",
    description: "植被基本静止",
    wind: { speedMps: 0.2, gustiness: 0.04, turbulence: 0.04 },
  },
  {
    value: "breeze",
    label: "微风",
    description: "枝叶轻微摆动",
    wind: { speedMps: 1.8, gustiness: 0.2, turbulence: 0.16 },
  },
  {
    value: "windy",
    label: "有风",
    description: "环境持续流动",
    wind: { speedMps: 5.5, gustiness: 0.42, turbulence: 0.34 },
  },
  {
    value: "strong",
    label: "强风",
    description: "明显阵风与湍流",
    wind: { speedMps: 11, gustiness: 0.7, turbulence: 0.62 },
  },
];

const WORLD_TIME_PRESETS: ReadonlyArray<WorldChoiceOption<string> & { hours: number }> = [
  { value: "dawn", label: "清晨", hours: 6.5 },
  { value: "morning", label: "上午", hours: 9.5 },
  { value: "noon", label: "正午", hours: 12.5 },
  { value: "dusk", label: "黄昏", hours: 17.5 },
  { value: "night", label: "夜晚", hours: 22 },
];

const WORLD_TIME_MODE_CHOICES: ReadonlyArray<WorldChoiceOption<"fixed" | "cycle">> = [
  { value: "fixed", label: "固定时刻", description: "保持当前光线" },
  { value: "cycle", label: "昼夜循环", description: "让时间自然推进" },
];

const WORLD_WEATHER_CHOICES: ReadonlyArray<WorldChoiceOption<WorldWeatherPreset>> = WORLD_WEATHER_PRESETS.map(
  (preset) => ({ value: preset, label: WORLD_WEATHER_PRESET_LABELS[preset] }),
);

const WORLD_WEATHER_VISUAL_DEFAULTS: Record<
  WorldWeatherPreset,
  { intensity: number; cloudCover: number; wetness: number }
> = {
  clear: { intensity: 0, cloudCover: 0.08, wetness: 0 },
  overcast: { intensity: 0.18, cloudCover: 0.86, wetness: 0.08 },
  rain: { intensity: 0.65, cloudCover: 0.92, wetness: 0.55 },
  snow: { intensity: 0.55, cloudCover: 0.84, wetness: 0.22 },
  storm: { intensity: 0.92, cloudCover: 1, wetness: 0.86 },
};

const WORLD_WEATHER_EVOLUTION_CHOICES: ReadonlyArray<WorldChoiceOption<WorldWeatherEvolutionMode>> = [
  { value: "static", label: "保持当前天气" },
  { value: "cycle", label: "自然变化" },
];

type WorldEffectPresencePresetId = "subtle" | "natural" | "dramatic";

const WORLD_EFFECT_PRESENCE_PRESETS: ReadonlyArray<
  WorldChoiceOption<WorldEffectPresencePresetId> & {
    patch: Pick<DirectorWorldEffect, "intensity" | "sizeScale" | "speedScale">;
  }
> = [
  {
    value: "subtle",
    label: "轻微",
    description: "低密度、慢节奏",
    patch: { intensity: 0.55, sizeScale: 0.8, speedScale: 0.85 },
  },
  {
    value: "natural",
    label: "自然",
    description: "平衡强度与尺度",
    patch: { intensity: 1, sizeScale: 1, speedScale: 1 },
  },
  {
    value: "dramatic",
    label: "强烈",
    description: "更大、更快、更密集",
    patch: { intensity: 1.8, sizeScale: 1.35, speedScale: 1.2 },
  },
];

type WorldWaterMotionPresetId = "calm" | "natural" | "rough";

type WorldWaterMotionPatch = Pick<
  DirectorWorldWaterBody,
  "waveAmplitude" | "waveLengthM" | "flowSpeedMps" | "foamIntensity"
>;

const WORLD_WATER_MOTION_PRESETS: ReadonlyArray<
  WorldChoiceOption<WorldWaterMotionPresetId> & {
    lake: WorldWaterMotionPatch;
    river: WorldWaterMotionPatch;
  }
> = [
  {
    value: "calm",
    label: "平静",
    description: "水面几乎无扰动",
    lake: { waveAmplitude: 0.03, waveLengthM: 16, flowSpeedMps: 0.08, foamIntensity: 0.08 },
    river: { waveAmplitude: 0.015, waveLengthM: 7, flowSpeedMps: 0.45, foamIntensity: 0.25 },
  },
  {
    value: "natural",
    label: "自然",
    description: "日常风浪与流动",
    lake: { waveAmplitude: 0.12, waveLengthM: 8, flowSpeedMps: 0.4, foamIntensity: 0.5 },
    river: { waveAmplitude: 0.05, waveLengthM: 4, flowSpeedMps: 1.2, foamIntensity: 0.7 },
  },
  {
    value: "rough",
    label: "汹涌",
    description: "尺度匹配的强浪与泡沫",
    lake: { waveAmplitude: 0.24, waveLengthM: 4.5, flowSpeedMps: 0.65, foamIntensity: 0.78 },
    river: { waveAmplitude: 0.1, waveLengthM: 3.2, flowSpeedMps: 2.2, foamIntensity: 0.9 },
  },
];

type WorldPopulationPresetId = "sparse" | "natural" | "abundant";

const WORLD_POPULATION_PRESETS: ReadonlyArray<WorldChoiceOption<WorldPopulationPresetId>> = [
  { value: "sparse", label: "稀少", description: "少量个体" },
  { value: "natural", label: "自然", description: "自然密度" },
  { value: "abundant", label: "繁盛", description: "大量个体" },
];

type WorldTrafficPresetId = "quiet" | "everyday" | "busy";

const WORLD_TRAFFIC_PRESETS: ReadonlyArray<
  WorldChoiceOption<WorldTrafficPresetId> & { patch: Pick<DirectorWorldRoad, "vehicleCount" | "speedKph"> }
> = [
  { value: "quiet", label: "安静", description: "少量慢速车辆", patch: { vehicleCount: 2, speedKph: 30 } },
  { value: "everyday", label: "日常", description: "常规流量与车速", patch: { vehicleCount: 6, speedKph: 40 } },
  { value: "busy", label: "繁忙", description: "高流量、低车速", patch: { vehicleCount: 14, speedKph: 24 } },
];

type WorldVec3 = [number, number, number];

/** Protocol bound for `settings.seed` (32-bit signed int, non-negative). */
const WORLD_SEED_MAX = 2_147_483_647;
/** Protocol bound for every world-space coordinate. */
const WORLD_COORDINATE_LIMIT = 100_000;
const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function toFiniteNumber(value: string | number, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toClampedNumber(value: string | number, fallback: number, min: number, max: number): number {
  return clampNumber(toFiniteNumber(value, fallback), min, max);
}

function toClampedInt(value: string | number, fallback: number, min: number, max: number): number {
  return clampNumber(Math.round(toFiniteNumber(value, fallback)), min, max);
}

function resolveWaterMotionPresetPatch(
  body: DirectorWorldWaterBody,
  preset: (typeof WORLD_WATER_MOTION_PRESETS)[number],
): WorldWaterMotionPatch {
  const base = body.river ? preset.river : preset.lake;
  const fetchM = body.river
    ? body.river.widthM
    : Math.sqrt(Math.max(body.surface.sizeX, 0.1) * Math.max(body.surface.sizeZ, 0.1));
  const scale = clampNumber(Math.sqrt(fetchM / (body.river ? 6 : 20)), 0.1, 3);
  return {
    ...base,
    waveAmplitude: Number((base.waveAmplitude * scale).toFixed(3)),
    waveLengthM: Number((base.waveLengthM * scale).toFixed(2)),
  };
}

/** UI-created entry ids follow the clipping-plane precedent in ScenePanel. */
function createWorldEntryId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function createPanelWorldEffect(kind: WorldEffectKind): DirectorWorldEffect {
  return {
    id: createWorldEntryId(`fx-${kind}`),
    name: WORLD_EFFECT_KIND_LABELS[kind],
    kind,
    anchor: { objectId: null, position: [0, 0, 0] },
    shape: { type: "point" },
    intensity: 1,
    sizeScale: 1,
    speedScale: 1,
    windInfluence: WORLD_EFFECT_WIND_INFLUENCE[kind],
    seedOffset: 0,
    visible: true,
    locked: false,
    createdAt: new Date().toISOString(),
  };
}

function createPanelWaterBody(): DirectorWorldWaterBody {
  return {
    id: createWorldEntryId("water"),
    name: "水体",
    surface: { center: [0, 0, 0], sizeX: 20, sizeZ: 20, rotationDegrees: 0 },
    waveAmplitude: 0.12,
    waveLengthM: 8,
    flowDirectionDegrees: 90,
    flowSpeedMps: 0.4,
    colorShallow: "#4fa8c7",
    colorDeep: "#0b2e4f",
    opacity: 0.92,
    foamIntensity: 0.5,
    visible: true,
    locked: false,
  };
}

function createPanelRiver(): DirectorWorldWaterBody {
  return {
    id: createWorldEntryId("river"),
    name: "河流",
    // The surface rectangle is unused for rivers but keeps the shared schema shape.
    surface: { center: [0, 0.1, 0], sizeX: 40, sizeZ: 40, rotationDegrees: 0 },
    river: {
      points: [
        [-18, 0.2, -16],
        [-7, 0.15, -6],
        [3, 0.1, 2],
        [14, 0.05, 12],
      ],
      widthM: 6,
    },
    waveAmplitude: 0.05,
    waveLengthM: 4,
    flowDirectionDegrees: 0,
    flowSpeedMps: 1.2,
    colorShallow: "#5db3c9",
    colorDeep: "#123c52",
    opacity: 0.9,
    foamIntensity: 0.7,
    visible: true,
    locked: false,
  };
}

/** Default circuit: clears the default 20×20 m basin instead of driving through it. */
function createPanelRoad(): DirectorWorldRoad {
  return {
    id: createWorldEntryId("road"),
    name: "道路",
    points: [
      [19, 0.05, 15],
      [0, 0.05, 15],
      [-19, 0.05, 15],
      [-19, 0.05, 0],
      [-19, 0.05, -15],
      [0, 0.05, -15],
      [19, 0.05, -15],
      [19, 0.05, 0],
    ],
    widthM: 8,
    loop: true,
    vehicleCount: 6,
    speedKph: 40,
    showSurface: true,
    seedOffset: 0,
    visible: true,
    locked: false,
  };
}

function createPanelWildlifeGroup(species: WorldWildlifeSpecies): DirectorWorldWildlifeGroup {
  return {
    id: createWorldEntryId(`wildlife-${species}`),
    name: WORLD_WILDLIFE_SPECIES_LABELS[species],
    species,
    count: WORLD_WILDLIFE_DEFAULT_COUNT[species],
    area: { center: [0, 0, 0], radius: 15 },
    ...(species === "birds" ? { altitude: { minM: 8, maxM: 25 } } : {}),
    ...(species === "butterflies" ? { altitude: { minM: 0.5, maxM: 3 } } : {}),
    speedScale: 1,
    sizeScale: 1,
    seedOffset: 0,
    visible: true,
    locked: false,
  };
}

/** Converts a shape-type switch into a concrete shape, keeping the radius when compatible. */
function createEmitterShapeForType(type: WorldEmitterShapeType, previous: WorldEmitterShape): WorldEmitterShape {
  const previousRadius = previous.type === "sphere" || previous.type === "disc" ? previous.radius : null;
  switch (type) {
    case "point":
      return { type: "point" };
    case "sphere":
      return { type: "sphere", radius: previousRadius ?? 2 };
    case "disc":
      return { type: "disc", radius: previousRadius ?? 2 };
    case "box": {
      if (previous.type === "box") return previous;
      const edge = previousRadius ? clampNumber(previousRadius * 2, 0.01, 1_000) : 2;
      return { type: "box", size: [edge, edge, edge] };
    }
  }
}

/** Replaces river control points, keeping any width profile in sync with the point count. */
function withRiverPoints(river: DirectorWorldRiver, points: WorldVec3[]): DirectorWorldRiver {
  const next: DirectorWorldRiver = { ...river, points };
  if (river.widthProfile) {
    next.widthProfile = points.map((_, index) => river.widthProfile?.[index] ?? 1);
  }
  return next;
}

function getWindPresetId(speedMps: number): WorldWindPresetId {
  if (speedMps < 0.75) return "still";
  if (speedMps < 3.5) return "breeze";
  if (speedMps < 8) return "windy";
  return "strong";
}

function getClosestTimePresetId(hours: number): string {
  const normalizedHours = ((hours % 24) + 24) % 24;
  return WORLD_TIME_PRESETS.reduce((closest, candidate) => {
    const closestDistance = Math.min(
      Math.abs(normalizedHours - closest.hours),
      24 - Math.abs(normalizedHours - closest.hours),
    );
    const candidateDistance = Math.min(
      Math.abs(normalizedHours - candidate.hours),
      24 - Math.abs(normalizedHours - candidate.hours),
    );
    return candidateDistance < closestDistance ? candidate : closest;
  }).value;
}

function getEffectPresencePresetId(effect: DirectorWorldEffect): WorldEffectPresencePresetId {
  if (effect.intensity < 0.8) return "subtle";
  if (effect.intensity > 1.35) return "dramatic";
  return "natural";
}

function getWaterMotionPresetId(body: DirectorWorldWaterBody): WorldWaterMotionPresetId {
  const calmAmplitude = resolveWaterMotionPresetPatch(body, WORLD_WATER_MOTION_PRESETS[0]!).waveAmplitude;
  const naturalAmplitude = resolveWaterMotionPresetPatch(body, WORLD_WATER_MOTION_PRESETS[1]!).waveAmplitude;
  const roughAmplitude = resolveWaterMotionPresetPatch(body, WORLD_WATER_MOTION_PRESETS[2]!).waveAmplitude;
  if (body.waveAmplitude < (calmAmplitude + naturalAmplitude) / 2) return "calm";
  if (body.waveAmplitude > (naturalAmplitude + roughAmplitude) / 2) return "rough";
  return "natural";
}

function getPopulationPresetId(group: DirectorWorldWildlifeGroup): WorldPopulationPresetId {
  const naturalCount = WORLD_WILDLIFE_DEFAULT_COUNT[group.species];
  if (group.count < naturalCount * 0.75) return "sparse";
  if (group.count > naturalCount * 1.3) return "abundant";
  return "natural";
}

function getPopulationCount(species: WorldWildlifeSpecies, preset: WorldPopulationPresetId): number {
  const naturalCount = WORLD_WILDLIFE_DEFAULT_COUNT[species];
  if (preset === "sparse") return Math.max(1, Math.round(naturalCount * 0.45));
  if (preset === "abundant") return Math.min(256, Math.round(naturalCount * 1.75));
  return naturalCount;
}

function getTrafficPresetId(road: DirectorWorldRoad): WorldTrafficPresetId {
  if (road.vehicleCount <= 3) return "quiet";
  if (road.vehicleCount >= 10) return "busy";
  return "everyday";
}

function getSurfaceClimateLabel(wetness: number): string {
  if (wetness >= 0.65) return "地表湿润";
  if (wetness >= 0.18) return "地面微湿";
  return "地表干燥";
}

function getSkyClimateLabel(cloudCover: number): string {
  if (cloudCover >= 0.78) return "云层厚重";
  if (cloudCover >= 0.32) return "云层舒展";
  return "天空通透";
}

function WorldChoiceGroup<T extends string | number>({
  ariaLabel,
  options,
  value,
  onChange,
}: {
  ariaLabel: string;
  options: ReadonlyArray<WorldChoiceOption<T>>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div aria-label={ariaLabel} className="scene-world-choice-grid" role="group">
      {options.map((option) => (
        <button
          aria-label={option.label}
          aria-pressed={option.value === value}
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
        >
          <strong>{option.label}</strong>
          {option.description ? <span>{option.description}</span> : null}
        </button>
      ))}
    </div>
  );
}

function WorldEntryPrecision({ children }: { children: ReactNode }) {
  return (
    <InspectorSection
      title="Agent / 专业精调"
      className="scene-world-entry-precision"
      collapsible
      defaultOpen={false}
      description="普通创作无需输入数值；Agent 可直接操作全部精确参数。"
    >
      {children}
    </InspectorSection>
  );
}

function WorldToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="inspector-toggle-row">
      <span>{label}</span>
      <input
        aria-label={label}
        checked={checked}
        type="checkbox"
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function WorldLockedHint() {
  return <p className="inspector-empty-state">已锁定，解除锁定后可编辑</p>;
}

/**
 * Shared 可见/锁定 toggles. Locking hides the entry's parameter controls and
 * disables deletion; visibility stays editable so a locked dressing can still
 * be hidden for a shot.
 */
function WorldEntryStateToggles({
  entryName,
  visible,
  locked,
  onVisibleChange,
  onLockedChange,
}: {
  entryName: string;
  visible: boolean;
  locked: boolean;
  onVisibleChange: (visible: boolean) => void;
  onLockedChange: (locked: boolean) => void;
}) {
  return (
    <div className="inspector-toggle-stack" role="group" aria-label={`${entryName}状态开关`}>
      <WorldToggleRow label="可见" checked={visible} onChange={onVisibleChange} />
      <WorldToggleRow label="锁定" checked={locked} onChange={onLockedChange} />
    </div>
  );
}

/** Name edits keep a draft so the field can be cleared mid-typing; only valid names commit. */
function WorldEntryNameField({
  ariaLabel,
  value,
  onCommit,
}: {
  ariaLabel: string;
  value: string;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);
  return (
    <InspectorTextField
      label="名称"
      ariaLabel={ariaLabel}
      value={draft}
      onChange={(next) => {
        setDraft(next);
        const trimmed = next.trim();
        if (trimmed.length > 0 && trimmed.length <= 240) onCommit(trimmed);
      }}
    />
  );
}

function WorldVec3Field({
  label,
  ariaPrefix,
  value,
  onChange,
  min = String(-WORLD_COORDINATE_LIMIT),
  max = String(WORLD_COORDINATE_LIMIT),
  step = "0.1",
}: {
  label: string;
  ariaPrefix: string;
  value: WorldVec3;
  onChange: (next: WorldVec3) => void;
  min?: string;
  max?: string;
  step?: string;
}) {
  return (
    <InspectorAxisGroup
      label={label}
      axes={(["X", "Y", "Z"] as const).map((axis, index) => ({
        axis,
        ariaLabel: `${ariaPrefix} ${axis}`,
        value: value[index],
        step,
        min,
        max,
        onChange: (next: string) => {
          const parsed = Number(next);
          if (!Number.isFinite(parsed)) return;
          const tuple: WorldVec3 = [value[0], value[1], value[2]];
          tuple[index] = clampNumber(parsed, Number(min), Number(max));
          onChange(tuple);
        },
      }))}
    />
  );
}

/** Spline control-point editor shared by rivers and roads (min 2 points per protocol). */
function WorldPointListEditor({
  ownerName,
  points,
  maxPoints,
  onChange,
}: {
  ownerName: string;
  points: ReadonlyArray<WorldVec3>;
  maxPoints: number;
  onChange: (next: WorldVec3[]) => void;
}) {
  const canRemove = points.length > 2;
  const canAdd = points.length < maxPoints;
  const clonePoints = () => points.map((point) => [point[0], point[1], point[2]] as WorldVec3);
  return (
    <div className="scene-world-point-list" role="group" aria-label={`${ownerName}控制点列表`}>
      {points.map((point, index) => (
        <div className="scene-world-point-row" key={index}>
          <WorldVec3Field
            label={`控制点 ${index + 1}`}
            ariaPrefix={`${ownerName}控制点${index + 1}`}
            value={point}
            onChange={(next) => {
              const nextPoints = clonePoints();
              nextPoints[index] = next;
              onChange(nextPoints);
            }}
          />
          <button
            aria-label={`删除${ownerName}控制点${index + 1}`}
            className="scene-world-entry-delete"
            disabled={!canRemove}
            type="button"
            onClick={() => onChange(clonePoints().filter((_, pointIndex) => pointIndex !== index))}
          >
            <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
          </button>
        </div>
      ))}
      <button
        aria-label={`添加${ownerName}控制点`}
        className="inspector-action-button"
        disabled={!canAdd}
        type="button"
        onClick={() => {
          const nextPoints = clonePoints();
          const last = nextPoints[nextPoints.length - 1] ?? [0, 0, 0];
          const previous = nextPoints[nextPoints.length - 2] ?? last;
          // Extrapolate along the last segment so the spline keeps its heading.
          nextPoints.push([
            clampNumber(last[0] * 2 - previous[0], -WORLD_COORDINATE_LIMIT, WORLD_COORDINATE_LIMIT),
            clampNumber(last[1] * 2 - previous[1], -WORLD_COORDINATE_LIMIT, WORLD_COORDINATE_LIMIT),
            clampNumber(last[2] * 2 - previous[2], -WORLD_COORDINATE_LIMIT, WORLD_COORDINATE_LIMIT),
          ]);
          onChange(nextPoints);
        }}
      >
        <Plus aria-hidden="true" size={13} strokeWidth={1.9} />
        <span>添加控制点</span>
      </button>
    </div>
  );
}

function WorldEffectEntry({
  basinAmplitudeScale,
  effect,
  water,
  onUpsert,
  onRemove,
}: {
  basinAmplitudeScale: number;
  effect: DirectorWorldEffect;
  water: WaterSpatialIndex;
  onUpsert: (effect: DirectorWorldEffect) => void;
  onRemove: (effectId: string) => void;
}) {
  const shape = effect.shape;
  const waterConflict = useMemo(
    () =>
      effect.intensity > 0 && (effect.kind === "fire" || effect.kind === "sparks") && effect.anchor.objectId == null
        ? findCombustionWaterConflict(effect.anchor.position, water, basinAmplitudeScale)
        : null,
    [basinAmplitudeScale, effect, water],
  );
  const waterConflictTitle = effect.kind === "fire" ? "火焰位于水下" : "火花位于水下";
  return (
    <div className="scene-world-entry" aria-label={`${effect.name}效果条目`}>
      <div className="scene-world-entry-header">
        <span className="scene-world-entry-name">
          {effect.name}（{WORLD_EFFECT_KIND_LABELS[effect.kind]}）
        </span>
        <button
          aria-label={`删除${effect.name}`}
          className="scene-world-entry-delete"
          disabled={effect.locked}
          type="button"
          onClick={() => onRemove(effect.id)}
        >
          <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
        </button>
      </div>
      {waterConflict ? (
        <div className="scene-world-conflict" role="status">
          <strong>{waterConflictTitle}</strong>
          <span>水会熄灭燃烧效果；可移到水面上方，或让 Agent 调整位置。</span>
          {!effect.locked ? (
            <button
              className="inspector-action-button scene-world-conflict-action"
              type="button"
              onClick={() => {
                const [x, y, z] = effect.anchor.position;
                onUpsert({
                  ...effect,
                  anchor: { ...effect.anchor, position: [x, y + waterConflict.requiredLiftM, z] },
                });
              }}
            >
              移到水面上方
            </button>
          ) : null}
        </div>
      ) : null}
      {effect.locked ? (
        <WorldLockedHint />
      ) : (
        <>
          <WorldEntryNameField
            ariaLabel={`${effect.name}名称`}
            value={effect.name}
            onCommit={(name) => onUpsert({ ...effect, name })}
          />
          <p className="scene-world-entry-preset-title">表现强度</p>
          <WorldChoiceGroup
            ariaLabel={`${effect.name}表现预设`}
            options={WORLD_EFFECT_PRESENCE_PRESETS}
            value={getEffectPresencePresetId(effect)}
            onChange={(value) => {
              const preset = WORLD_EFFECT_PRESENCE_PRESETS.find((candidate) => candidate.value === value);
              if (preset) onUpsert({ ...effect, ...preset.patch });
            }}
          />
          <WorldEntryPrecision>
            <WorldVec3Field
              label="位置"
              ariaPrefix={`${effect.name}位置`}
              value={effect.anchor.position}
              onChange={(position) => onUpsert({ ...effect, anchor: { ...effect.anchor, position } })}
            />
            <InspectorSelectField
              label="发射形状"
              ariaLabel={`${effect.name}发射形状`}
              value={shape.type}
              options={WORLD_EFFECT_SHAPE_TYPES.map((type) => ({
                value: type,
                label: WORLD_EFFECT_SHAPE_LABELS[type],
              }))}
              onChange={(value) =>
                onUpsert({ ...effect, shape: createEmitterShapeForType(value as WorldEmitterShapeType, shape) })
              }
            />
            {shape.type === "sphere" || shape.type === "disc" ? (
              <InspectorRangeNumberField
                label="形状半径"
                rangeAriaLabel={`${effect.name}形状半径滑杆`}
                numberAriaLabel={`${effect.name}形状半径`}
                max="500"
                min="0.01"
                step="0.1"
                value={shape.radius}
                onValueChange={(value) =>
                  onUpsert({
                    ...effect,
                    shape: { ...shape, radius: toClampedNumber(value, shape.radius, 0.01, 500) },
                  })
                }
              />
            ) : null}
            {shape.type === "box" ? (
              <WorldVec3Field
                label="盒体尺寸"
                ariaPrefix={`${effect.name}盒体尺寸`}
                value={shape.size}
                min="0.01"
                max="1000"
                step="0.1"
                onChange={(size) => onUpsert({ ...effect, shape: { type: "box", size } })}
              />
            ) : null}
            <InspectorRangeNumberField
              label="强度"
              rangeAriaLabel={`${effect.name}强度滑杆`}
              numberAriaLabel={`${effect.name}强度`}
              max="3"
              min="0"
              step="0.05"
              value={effect.intensity}
              onValueChange={(value) =>
                onUpsert({ ...effect, intensity: toClampedNumber(value, effect.intensity, 0, 3) })
              }
            />
            <InspectorRangeNumberField
              label="尺寸倍率"
              rangeAriaLabel={`${effect.name}尺寸倍率滑杆`}
              numberAriaLabel={`${effect.name}尺寸倍率`}
              max="10"
              min="0.1"
              step="0.05"
              value={effect.sizeScale}
              onValueChange={(value) =>
                onUpsert({ ...effect, sizeScale: toClampedNumber(value, effect.sizeScale, 0.1, 10) })
              }
            />
            <InspectorRangeNumberField
              label="速度倍率"
              rangeAriaLabel={`${effect.name}速度倍率滑杆`}
              numberAriaLabel={`${effect.name}速度倍率`}
              max="10"
              min="0.1"
              step="0.05"
              value={effect.speedScale}
              onValueChange={(value) =>
                onUpsert({ ...effect, speedScale: toClampedNumber(value, effect.speedScale, 0.1, 10) })
              }
            />
            <InspectorRangeNumberField
              label="风力影响"
              rangeAriaLabel={`${effect.name}风力影响滑杆`}
              numberAriaLabel={`${effect.name}风力影响`}
              max="1"
              min="0"
              step="0.01"
              value={effect.windInfluence}
              onValueChange={(value) =>
                onUpsert({ ...effect, windInfluence: toClampedNumber(value, effect.windInfluence, 0, 1) })
              }
            />
            <InspectorRangeNumberField
              label="种子偏移"
              rangeAriaLabel={`${effect.name}种子偏移滑杆`}
              numberAriaLabel={`${effect.name}种子偏移`}
              max="65535"
              min="0"
              step="1"
              value={effect.seedOffset}
              onValueChange={(value) =>
                onUpsert({ ...effect, seedOffset: toClampedInt(value, effect.seedOffset, 0, 65_535) })
              }
            />
            <div className="inspector-toggle-stack" role="group" aria-label={`${effect.name}颜色叠加开关`}>
              <WorldToggleRow
                label="颜色叠加"
                checked={typeof effect.colorTint === "string"}
                onChange={(checked) => {
                  if (checked) {
                    onUpsert({ ...effect, colorTint: "#ffffff" });
                    return;
                  }
                  const next = { ...effect };
                  delete next.colorTint;
                  onUpsert(next);
                }}
              />
            </div>
            {effect.colorTint ? (
              <InspectorColorField
                label="色调"
                colorAriaLabel={`${effect.name}色调`}
                hexAriaLabel={`${effect.name}色调 HEX`}
                value={effect.colorTint}
                onColorChange={(value) => onUpsert({ ...effect, colorTint: value })}
                onHexChange={(value) => {
                  const trimmed = value.trim();
                  if (HEX_COLOR_PATTERN.test(trimmed)) onUpsert({ ...effect, colorTint: trimmed.toLowerCase() });
                }}
              />
            ) : null}
            {effect.kind === "fire" && effect.anchor.objectId === null ? (
              <>
                <div className="inspector-toggle-stack" role="group" aria-label={`${effect.name}蔓延开关`}>
                  <WorldToggleRow
                    label="火势蔓延"
                    checked={effect.propagation?.enabled === true}
                    onChange={(checked) =>
                      onUpsert({
                        ...effect,
                        propagation: {
                          enabled: checked,
                          radiusM: effect.propagation?.radiusM ?? 12,
                          spreadRate: effect.propagation?.spreadRate ?? 1,
                        },
                      })
                    }
                  />
                </div>
                {effect.propagation?.enabled ? (
                  <>
                    <InspectorRangeNumberField
                      label="蔓延半径"
                      rangeAriaLabel={`${effect.name}蔓延半径滑杆`}
                      numberAriaLabel={`${effect.name}蔓延半径`}
                      max="64"
                      min="2"
                      step="1"
                      value={effect.propagation.radiusM}
                      onValueChange={(value) =>
                        onUpsert({
                          ...effect,
                          propagation: { ...effect.propagation!, radiusM: Number(value) },
                        })
                      }
                    />
                    <InspectorRangeNumberField
                      label="蔓延速率"
                      rangeAriaLabel={`${effect.name}蔓延速率滑杆`}
                      numberAriaLabel={`${effect.name}蔓延速率`}
                      max="3"
                      min="0.1"
                      step="0.05"
                      value={effect.propagation.spreadRate}
                      onValueChange={(value) =>
                        onUpsert({
                          ...effect,
                          propagation: { ...effect.propagation!, spreadRate: Number(value) },
                        })
                      }
                    />
                  </>
                ) : null}
              </>
            ) : null}
          </WorldEntryPrecision>
        </>
      )}
      <WorldEntryStateToggles
        entryName={effect.name}
        visible={effect.visible}
        locked={effect.locked}
        onVisibleChange={(visible) => onUpsert({ ...effect, visible })}
        onLockedChange={(locked) => onUpsert({ ...effect, locked })}
      />
    </div>
  );
}

function WorldWaterEntry({
  body,
  onUpsert,
  onRemove,
}: {
  body: DirectorWorldWaterBody;
  onUpsert: (body: DirectorWorldWaterBody) => void;
  onRemove: (bodyId: string) => void;
}) {
  const river = body.river;
  return (
    <div className="scene-world-entry" aria-label={`${body.name}水体条目`}>
      <div className="scene-world-entry-header">
        <span className="scene-world-entry-name">
          {body.name}
          {river ? "（河流）" : ""}
        </span>
        <button
          aria-label={`删除${body.name}`}
          className="scene-world-entry-delete"
          disabled={body.locked}
          type="button"
          onClick={() => onRemove(body.id)}
        >
          <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
        </button>
      </div>
      {body.locked ? (
        <WorldLockedHint />
      ) : (
        <>
          <WorldEntryNameField
            ariaLabel={`${body.name}名称`}
            value={body.name}
            onCommit={(name) => onUpsert({ ...body, name })}
          />
          <p className="scene-world-entry-preset-title">水势</p>
          <WorldChoiceGroup
            ariaLabel={`${body.name}水势预设`}
            options={WORLD_WATER_MOTION_PRESETS}
            value={getWaterMotionPresetId(body)}
            onChange={(value) => {
              const preset = WORLD_WATER_MOTION_PRESETS.find((candidate) => candidate.value === value);
              if (preset) onUpsert({ ...body, ...resolveWaterMotionPresetPatch(body, preset) });
            }}
          />
          <WorldEntryPrecision>
            {river ? (
              <>
                <InspectorRangeNumberField
                  label="河道宽度"
                  rangeAriaLabel={`${body.name}河道宽度滑杆`}
                  numberAriaLabel={`${body.name}河道宽度`}
                  max="60"
                  min="0.5"
                  step="0.5"
                  value={river.widthM}
                  onValueChange={(value) =>
                    onUpsert({ ...body, river: { ...river, widthM: toClampedNumber(value, river.widthM, 0.5, 200) } })
                  }
                />
                <WorldPointListEditor
                  ownerName={body.name}
                  points={river.points}
                  maxPoints={DIRECTOR_WORLD_RIVER_MAX_POINTS}
                  onChange={(points) => onUpsert({ ...body, river: withRiverPoints(river, points) })}
                />
                <div className="inspector-toggle-stack" role="group" aria-label={`${body.name}宽度剖面开关`}>
                  <WorldToggleRow
                    label="宽度剖面"
                    checked={river.widthProfile !== undefined}
                    onChange={(checked) => {
                      if (checked) {
                        onUpsert({ ...body, river: { ...river, widthProfile: river.points.map(() => 1) } });
                        return;
                      }
                      const nextRiver = { ...river };
                      delete nextRiver.widthProfile;
                      onUpsert({ ...body, river: nextRiver });
                    }}
                  />
                </div>
                {river.widthProfile
                  ? river.widthProfile.map((multiplier, index) => (
                      <InspectorRangeNumberField
                        key={index}
                        label={`宽度倍率 ${index + 1}`}
                        rangeAriaLabel={`${body.name}宽度倍率${index + 1}滑杆`}
                        numberAriaLabel={`${body.name}宽度倍率${index + 1}`}
                        max="8"
                        min="0.1"
                        step="0.05"
                        value={multiplier}
                        onValueChange={(value) => {
                          const nextProfile = [...(river.widthProfile ?? [])];
                          nextProfile[index] = toClampedNumber(value, multiplier, 0.1, 8);
                          onUpsert({ ...body, river: { ...river, widthProfile: nextProfile } });
                        }}
                      />
                    ))
                  : null}
              </>
            ) : (
              <>
                <WorldVec3Field
                  label="位置"
                  ariaPrefix={`${body.name}位置`}
                  value={body.surface.center}
                  onChange={(center) => onUpsert({ ...body, surface: { ...body.surface, center } })}
                />
                <InspectorRangeNumberField
                  label="尺寸 X"
                  rangeAriaLabel={`${body.name}尺寸X滑杆`}
                  numberAriaLabel={`${body.name}尺寸X`}
                  max="5000"
                  min="0.1"
                  step="0.5"
                  value={body.surface.sizeX}
                  onValueChange={(value) =>
                    onUpsert({
                      ...body,
                      surface: { ...body.surface, sizeX: toClampedNumber(value, body.surface.sizeX, 0.1, 5_000) },
                    })
                  }
                />
                <InspectorRangeNumberField
                  label="尺寸 Z"
                  rangeAriaLabel={`${body.name}尺寸Z滑杆`}
                  numberAriaLabel={`${body.name}尺寸Z`}
                  max="5000"
                  min="0.1"
                  step="0.5"
                  value={body.surface.sizeZ}
                  onValueChange={(value) =>
                    onUpsert({
                      ...body,
                      surface: { ...body.surface, sizeZ: toClampedNumber(value, body.surface.sizeZ, 0.1, 5_000) },
                    })
                  }
                />
                <InspectorRangeNumberField
                  label="旋转"
                  rangeAriaLabel={`${body.name}旋转滑杆`}
                  numberAriaLabel={`${body.name}旋转`}
                  max="360"
                  min="-360"
                  step="1"
                  value={body.surface.rotationDegrees}
                  onValueChange={(value) =>
                    onUpsert({
                      ...body,
                      surface: {
                        ...body.surface,
                        rotationDegrees: toClampedNumber(value, body.surface.rotationDegrees, -360, 360),
                      },
                    })
                  }
                />
                <InspectorRangeNumberField
                  label="流向"
                  rangeAriaLabel={`${body.name}流向滑杆`}
                  numberAriaLabel={`${body.name}流向`}
                  max="360"
                  min="0"
                  step="1"
                  value={body.flowDirectionDegrees}
                  onValueChange={(value) =>
                    onUpsert({
                      ...body,
                      flowDirectionDegrees: toClampedNumber(value, body.flowDirectionDegrees, 0, 360),
                    })
                  }
                />
              </>
            )}
            <InspectorRangeNumberField
              label="波浪幅度"
              rangeAriaLabel={`${body.name}波浪幅度滑杆`}
              numberAriaLabel={`${body.name}波浪幅度`}
              max="3"
              min="0"
              step="0.01"
              value={body.waveAmplitude}
              onValueChange={(value) =>
                onUpsert({ ...body, waveAmplitude: toClampedNumber(value, body.waveAmplitude, 0, 3) })
              }
            />
            <InspectorRangeNumberField
              label="波长"
              rangeAriaLabel={`${body.name}波长滑杆`}
              numberAriaLabel={`${body.name}波长`}
              max="200"
              min="0.2"
              step="0.1"
              value={body.waveLengthM}
              onValueChange={(value) =>
                onUpsert({ ...body, waveLengthM: toClampedNumber(value, body.waveLengthM, 0.2, 200) })
              }
            />
            <InspectorRangeNumberField
              label="流速"
              rangeAriaLabel={`${body.name}流速滑杆`}
              numberAriaLabel={`${body.name}流速`}
              max="10"
              min="0"
              step="0.1"
              value={body.flowSpeedMps}
              onValueChange={(value) =>
                onUpsert({ ...body, flowSpeedMps: toClampedNumber(value, body.flowSpeedMps, 0, 10) })
              }
            />
            <InspectorColorField
              label="浅水颜色"
              colorAriaLabel={`${body.name}浅水颜色`}
              hexAriaLabel={`${body.name}浅水颜色 HEX`}
              value={body.colorShallow}
              onColorChange={(value) => onUpsert({ ...body, colorShallow: value })}
              onHexChange={(value) => {
                const trimmed = value.trim();
                if (HEX_COLOR_PATTERN.test(trimmed)) onUpsert({ ...body, colorShallow: trimmed.toLowerCase() });
              }}
            />
            <InspectorColorField
              label="深水颜色"
              colorAriaLabel={`${body.name}深水颜色`}
              hexAriaLabel={`${body.name}深水颜色 HEX`}
              value={body.colorDeep}
              onColorChange={(value) => onUpsert({ ...body, colorDeep: value })}
              onHexChange={(value) => {
                const trimmed = value.trim();
                if (HEX_COLOR_PATTERN.test(trimmed)) onUpsert({ ...body, colorDeep: trimmed.toLowerCase() });
              }}
            />
            <InspectorRangeNumberField
              label="不透明度"
              rangeAriaLabel={`${body.name}不透明度滑杆`}
              numberAriaLabel={`${body.name}不透明度`}
              max="1"
              min="0.05"
              step="0.01"
              value={body.opacity}
              onValueChange={(value) => onUpsert({ ...body, opacity: toClampedNumber(value, body.opacity, 0.05, 1) })}
            />
            <InspectorRangeNumberField
              label="泡沫强度"
              rangeAriaLabel={`${body.name}泡沫强度滑杆`}
              numberAriaLabel={`${body.name}泡沫强度`}
              max="1"
              min="0"
              step="0.01"
              value={body.foamIntensity}
              onValueChange={(value) =>
                onUpsert({ ...body, foamIntensity: toClampedNumber(value, body.foamIntensity, 0, 1) })
              }
            />
          </WorldEntryPrecision>
        </>
      )}
      <WorldEntryStateToggles
        entryName={body.name}
        visible={body.visible}
        locked={body.locked}
        onVisibleChange={(visible) => onUpsert({ ...body, visible })}
        onLockedChange={(locked) => onUpsert({ ...body, locked })}
      />
    </div>
  );
}

function WorldWildlifeEntry({
  group,
  onUpsert,
  onRemove,
}: {
  group: DirectorWorldWildlifeGroup;
  onUpsert: (group: DirectorWorldWildlifeGroup) => void;
  onRemove: (groupId: string) => void;
}) {
  const altitude = group.altitude;
  return (
    <div className="scene-world-entry" aria-label={`${group.name}动物群条目`}>
      <div className="scene-world-entry-header">
        <span className="scene-world-entry-name">
          {group.name}（{WORLD_WILDLIFE_SPECIES_LABELS[group.species]}）
        </span>
        <button
          aria-label={`删除${group.name}`}
          className="scene-world-entry-delete"
          disabled={group.locked}
          type="button"
          onClick={() => onRemove(group.id)}
        >
          <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
        </button>
      </div>
      {group.locked ? (
        <WorldLockedHint />
      ) : (
        <>
          <WorldEntryNameField
            ariaLabel={`${group.name}名称`}
            value={group.name}
            onCommit={(name) => onUpsert({ ...group, name })}
          />
          <p className="scene-world-entry-preset-title">群体规模</p>
          <WorldChoiceGroup
            ariaLabel={`${group.name}群体规模预设`}
            options={WORLD_POPULATION_PRESETS}
            value={getPopulationPresetId(group)}
            onChange={(value) => onUpsert({ ...group, count: getPopulationCount(group.species, value) })}
          />
          <WorldEntryPrecision>
            <WorldVec3Field
              label="活动中心"
              ariaPrefix={`${group.name}活动中心`}
              value={group.area.center}
              onChange={(center) => onUpsert({ ...group, area: { ...group.area, center } })}
            />
            <InspectorRangeNumberField
              label="活动半径"
              rangeAriaLabel={`${group.name}活动半径滑杆`}
              numberAriaLabel={`${group.name}活动半径`}
              max="1000"
              min="0.5"
              step="0.5"
              value={group.area.radius}
              onValueChange={(value) =>
                onUpsert({
                  ...group,
                  area: { ...group.area, radius: toClampedNumber(value, group.area.radius, 0.5, 1_000) },
                })
              }
            />
            <InspectorRangeNumberField
              label="数量"
              rangeAriaLabel={`${group.name}数量滑杆`}
              numberAriaLabel={`${group.name}数量`}
              max="256"
              min="1"
              step="1"
              value={group.count}
              onValueChange={(value) => onUpsert({ ...group, count: toClampedInt(value, group.count, 1, 256) })}
            />
            <InspectorRangeNumberField
              label="速度倍率"
              rangeAriaLabel={`${group.name}速度倍率滑杆`}
              numberAriaLabel={`${group.name}速度倍率`}
              max="4"
              min="0.1"
              step="0.05"
              value={group.speedScale}
              onValueChange={(value) =>
                onUpsert({ ...group, speedScale: toClampedNumber(value, group.speedScale, 0.1, 4) })
              }
            />
            <InspectorRangeNumberField
              label="尺寸倍率"
              rangeAriaLabel={`${group.name}尺寸倍率滑杆`}
              numberAriaLabel={`${group.name}尺寸倍率`}
              max="10"
              min="0.1"
              step="0.05"
              value={group.sizeScale}
              onValueChange={(value) =>
                onUpsert({ ...group, sizeScale: toClampedNumber(value, group.sizeScale, 0.1, 10) })
              }
            />
            {altitude ? (
              <>
                <InspectorRangeNumberField
                  label="最低高度"
                  rangeAriaLabel={`${group.name}最低高度滑杆`}
                  numberAriaLabel={`${group.name}最低高度`}
                  max="500"
                  min="0"
                  step="0.5"
                  value={altitude.minM}
                  onValueChange={(value) => {
                    const minM = toClampedNumber(value, altitude.minM, 0, 500);
                    onUpsert({ ...group, altitude: { minM, maxM: Math.max(minM, altitude.maxM) } });
                  }}
                />
                <InspectorRangeNumberField
                  label="最高高度"
                  rangeAriaLabel={`${group.name}最高高度滑杆`}
                  numberAriaLabel={`${group.name}最高高度`}
                  max="500"
                  min="0"
                  step="0.5"
                  value={altitude.maxM}
                  onValueChange={(value) => {
                    const maxM = toClampedNumber(value, altitude.maxM, 0, 500);
                    onUpsert({ ...group, altitude: { minM: Math.min(altitude.minM, maxM), maxM } });
                  }}
                />
              </>
            ) : null}
            <InspectorRangeNumberField
              label="种子偏移"
              rangeAriaLabel={`${group.name}种子偏移滑杆`}
              numberAriaLabel={`${group.name}种子偏移`}
              max="65535"
              min="0"
              step="1"
              value={group.seedOffset}
              onValueChange={(value) =>
                onUpsert({ ...group, seedOffset: toClampedInt(value, group.seedOffset, 0, 65_535) })
              }
            />
          </WorldEntryPrecision>
        </>
      )}
      <WorldEntryStateToggles
        entryName={group.name}
        visible={group.visible}
        locked={group.locked}
        onVisibleChange={(visible) => onUpsert({ ...group, visible })}
        onLockedChange={(locked) => onUpsert({ ...group, locked })}
      />
    </div>
  );
}

function WorldRoadEntry({
  basinAmplitudeScale,
  road,
  water,
  onUpsert,
  onRemove,
}: {
  basinAmplitudeScale: number;
  road: DirectorWorldRoad;
  water: WaterSpatialIndex;
  onUpsert: (road: DirectorWorldRoad) => void;
  onRemove: (roadId: string) => void;
}) {
  const waterConflict = useMemo(
    () => findRoadWaterConflict(road, water, basinAmplitudeScale),
    [basinAmplitudeScale, road, water],
  );
  return (
    <div className="scene-world-entry" aria-label={`${road.name}道路条目`}>
      <div className="scene-world-entry-header">
        <span className="scene-world-entry-name">{road.name}</span>
        <button
          aria-label={`删除${road.name}`}
          className="scene-world-entry-delete"
          disabled={road.locked}
          type="button"
          onClick={() => onRemove(road.id)}
        >
          <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
        </button>
      </div>
      {waterConflict ? (
        <div className="scene-world-conflict" role="status">
          <strong>道路与水面相交</strong>
          <span>车辆会穿过水面；可抬升道路，或让 Agent 调整路线。</span>
          {!road.locked ? (
            <button
              className="inspector-action-button scene-world-conflict-action"
              type="button"
              onClick={() => onUpsert(raiseRoadAboveWater(road, waterConflict))}
            >
              抬升到水面上方
            </button>
          ) : null}
        </div>
      ) : null}
      {road.locked ? (
        <WorldLockedHint />
      ) : (
        <>
          <WorldEntryNameField
            ariaLabel={`${road.name}名称`}
            value={road.name}
            onCommit={(name) => onUpsert({ ...road, name })}
          />
          <p className="scene-world-entry-preset-title">交通状态</p>
          <WorldChoiceGroup
            ariaLabel={`${road.name}交通状态预设`}
            options={WORLD_TRAFFIC_PRESETS}
            value={getTrafficPresetId(road)}
            onChange={(value) => {
              const preset = WORLD_TRAFFIC_PRESETS.find((candidate) => candidate.value === value);
              if (preset) onUpsert({ ...road, ...preset.patch });
            }}
          />
          <div className="inspector-toggle-stack" role="group" aria-label={`${road.name}道路选项`}>
            <WorldToggleRow label="环路" checked={road.loop} onChange={(loop) => onUpsert({ ...road, loop })} />
            <WorldToggleRow
              label="显示路面"
              checked={road.showSurface}
              onChange={(showSurface) => onUpsert({ ...road, showSurface })}
            />
          </div>
          <WorldEntryPrecision>
            <InspectorRangeNumberField
              label="路宽"
              rangeAriaLabel={`${road.name}路宽滑杆`}
              numberAriaLabel={`${road.name}路宽`}
              max="30"
              min="2"
              step="0.5"
              value={road.widthM}
              onValueChange={(value) => onUpsert({ ...road, widthM: toClampedNumber(value, road.widthM, 2, 30) })}
            />
            <InspectorRangeNumberField
              label="车辆数"
              rangeAriaLabel={`${road.name}车辆数滑杆`}
              numberAriaLabel={`${road.name}车辆数`}
              max="24"
              min="0"
              step="1"
              value={road.vehicleCount}
              onValueChange={(value) =>
                onUpsert({ ...road, vehicleCount: toClampedInt(value, road.vehicleCount, 0, 24) })
              }
            />
            <InspectorRangeNumberField
              label="车速（km/h）"
              rangeAriaLabel={`${road.name}车速滑杆`}
              numberAriaLabel={`${road.name}车速`}
              max="120"
              min="5"
              step="1"
              value={road.speedKph}
              onValueChange={(value) => onUpsert({ ...road, speedKph: toClampedNumber(value, road.speedKph, 5, 120) })}
            />
            <WorldPointListEditor
              ownerName={road.name}
              points={road.points}
              maxPoints={DIRECTOR_WORLD_ROAD_MAX_POINTS}
              onChange={(points) => onUpsert({ ...road, points })}
            />
            <InspectorRangeNumberField
              label="种子偏移"
              rangeAriaLabel={`${road.name}种子偏移滑杆`}
              numberAriaLabel={`${road.name}种子偏移`}
              max="65535"
              min="0"
              step="1"
              value={road.seedOffset}
              onValueChange={(value) =>
                onUpsert({ ...road, seedOffset: toClampedInt(value, road.seedOffset, 0, 65_535) })
              }
            />
          </WorldEntryPrecision>
        </>
      )}
      <WorldEntryStateToggles
        entryName={road.name}
        visible={road.visible}
        locked={road.locked}
        onVisibleChange={(visible) => onUpsert({ ...road, visible })}
        onLockedChange={(locked) => onUpsert({ ...road, locked })}
      />
    </div>
  );
}

export function SceneWorldSection() {
  const world = useDirectorStore((state) => state.project.world);
  const groundHeight = useDirectorStore((state) => state.project.scene.groundHeight);
  const updateWorldSettings = useDirectorStore((state) => state.updateWorldSettings);
  const upsertWorldEffect = useDirectorStore((state) => state.upsertWorldEffect);
  const removeWorldEffects = useDirectorStore((state) => state.removeWorldEffects);
  const upsertWorldWaterBody = useDirectorStore((state) => state.upsertWorldWaterBody);
  const removeWorldWaterBodies = useDirectorStore((state) => state.removeWorldWaterBodies);
  const upsertWorldWildlifeGroup = useDirectorStore((state) => state.upsertWorldWildlifeGroup);
  const removeWorldWildlifeGroups = useDirectorStore((state) => state.removeWorldWildlifeGroups);
  const upsertWorldRoad = useDirectorStore((state) => state.upsertWorldRoad);
  const removeWorldRoads = useDirectorStore((state) => state.removeWorldRoads);

  const [newEffectKind, setNewEffectKind] = useState<WorldEffectKind>("fire");
  const [newSpecies, setNewSpecies] = useState<WorldWildlifeSpecies>("birds");
  const [activeTab, setActiveTab] = useState<WorldPanelTab>("climate");

  const fps = useDirectorStore((state) => state.project.scene.timeline?.fps ?? 24);
  // Quantized playhead (~4 Hz at 24 fps): the live climate readout stays
  // current during playback without re-rendering the panel every frame.
  const readoutFrame = useTimelineRuntimeStore((state) => Math.floor(state.playheadFrame / 6) * 6);

  const settings = world?.settings ?? createDefaultDirectorWorldSettings();
  const enabled = world?.settings.enabled === true;
  const weatherEvolving = isWorldWeatherEvolving(settings);
  const climateReadout =
    enabled && weatherEvolving
      ? evaluateWorldClimate(settings, getWorldSecondsForFrame(readoutFrame, fps) + getWorldAmbientOffsetSeconds())
      : null;
  const effects = world?.effects ?? [];
  const waterBodies = useMemo(() => world?.waterBodies ?? [], [world?.waterBodies]);
  const waterSpatial = useMemo(
    () =>
      buildWaterSpatialIndex(
        waterBodies.filter((body) => body.visible),
        groundHeight,
      ),
    [groundHeight, waterBodies],
  );
  const waterAmplitudeScale = computeWaterAmplitudeScale(
    settings.wind.speedMps * (climateReadout?.windGain ?? 1),
    climateReadout?.weather ?? settings.weather,
  );
  const wildlife = world?.wildlife ?? [];
  // Pre-roads world blocks may lack the collection until reparsed from disk.
  const roads = world?.roads ?? [];
  const tabCount: Partial<Record<WorldPanelTab, number>> = {
    effects: effects.length,
    water: waterBodies.length,
    wildlife: wildlife.length,
    traffic: roads.length,
  };

  return (
    <InspectorSection title="世界系统" className="scene-world-section" collapsible defaultOpen={false}>
      <div className="inspector-toggle-stack" role="group" aria-label="世界系统开关">
        <WorldToggleRow
          label="启用世界系统"
          checked={enabled}
          onChange={(checked) => updateWorldSettings({ enabled: checked })}
        />
      </div>
      {enabled ? (
        <>
          <div aria-label="世界系统分类" className="scene-world-tabs" role="tablist">
            {WORLD_PANEL_TABS.map(({ id, label }) => (
              <button
                aria-selected={activeTab === id}
                key={id}
                onClick={() => setActiveTab(id)}
                role="tab"
                type="button"
              >
                <span>{label}</span>
                {tabCount[id] ? <small>{tabCount[id]}</small> : null}
              </button>
            ))}
          </div>

          {activeTab === "climate" ? (
            <div aria-label="气候设置" className="scene-world-tabpanel is-climate" role="tabpanel">
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">风感</p>
                <WorldChoiceGroup
                  ariaLabel="风感预设"
                  options={WORLD_WIND_PRESETS}
                  value={getWindPresetId(settings.wind.speedMps)}
                  onChange={(value) => {
                    const preset = WORLD_WIND_PRESETS.find((candidate) => candidate.value === value);
                    if (preset) updateWorldSettings({ wind: preset.wind });
                  }}
                />
              </div>
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">昼夜</p>
                <WorldChoiceGroup
                  ariaLabel="时刻模式"
                  options={WORLD_TIME_MODE_CHOICES}
                  value={settings.timeOfDay.mode}
                  onChange={(mode) =>
                    updateWorldSettings({
                      timeOfDay: { mode, ...(mode === "cycle" ? { drivesSky: true } : {}) },
                    })
                  }
                />
                <WorldChoiceGroup
                  ariaLabel="自然时段"
                  options={WORLD_TIME_PRESETS}
                  value={getClosestTimePresetId(settings.timeOfDay.hours)}
                  onChange={(value) => {
                    const preset = WORLD_TIME_PRESETS.find((candidate) => candidate.value === value);
                    if (preset) {
                      updateWorldSettings({
                        timeOfDay: { mode: "fixed", hours: preset.hours, drivesSky: true },
                      });
                    }
                  }}
                />
                <div className="inspector-toggle-stack" role="group" aria-label="天空驱动开关">
                  <WorldToggleRow
                    label="驱动天空与太阳"
                    checked={settings.timeOfDay.drivesSky}
                    onChange={(checked) => updateWorldSettings({ timeOfDay: { drivesSky: checked } })}
                  />
                </div>
              </div>
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">天气</p>
                <WorldChoiceGroup
                  ariaLabel="天气预设"
                  options={WORLD_WEATHER_CHOICES}
                  value={settings.weather.preset}
                  onChange={(preset) =>
                    updateWorldSettings({ weather: { preset, ...WORLD_WEATHER_VISUAL_DEFAULTS[preset] } })
                  }
                />
                <WorldChoiceGroup
                  ariaLabel="天气演化模式"
                  options={WORLD_WEATHER_EVOLUTION_CHOICES}
                  value={settings.weather.evolution?.mode ?? "static"}
                  onChange={(mode) =>
                    updateWorldSettings({
                      weather: {
                        evolution: {
                          mode,
                          periodSeconds:
                            settings.weather.evolution?.periodSeconds ?? DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
                        },
                      },
                    })
                  }
                />
                {climateReadout ? (
                  <div aria-label="气候实时读数" className="scene-world-climate-readout" role="status">
                    <span>
                      当前天气：{WORLD_WEATHER_PRESET_LABELS[climateReadout.preset]}
                      {climateReadout.blend < 1 ? (
                        <>
                          （{WORLD_WEATHER_PRESET_LABELS[climateReadout.fromPreset]}→
                          {WORLD_WEATHER_PRESET_LABELS[climateReadout.toPreset]}）
                        </>
                      ) : null}
                    </span>
                    <span>{getSurfaceClimateLabel(climateReadout.wetness)}</span>
                    <span>{getSkyClimateLabel(climateReadout.cloudCover)}</span>
                  </div>
                ) : null}
              </div>

              <InspectorSection
                title="Agent / 专业精调"
                className="scene-world-precision"
                collapsible
                defaultOpen={false}
                description="普通创作无需输入数值；Agent 可直接操作全部精确参数。"
              >
                <div className="scene-world-precision-content">
                  <div className="scene-subgroup scene-world-card">
                    <p className="scene-subgroup-title">随机种子</p>
                    <InspectorRangeNumberField
                      label="世界种子"
                      rangeAriaLabel="世界种子滑杆"
                      numberAriaLabel="世界种子"
                      max={String(WORLD_SEED_MAX)}
                      min="0"
                      step="1"
                      value={settings.seed}
                      onValueChange={(value) =>
                        updateWorldSettings({ seed: toClampedInt(value, settings.seed, 0, WORLD_SEED_MAX) })
                      }
                    />
                  </div>
                  <div className="scene-subgroup scene-world-card">
                    <p className="scene-subgroup-title">风场</p>
                    <InspectorRangeNumberField
                      label="风向"
                      rangeAriaLabel="风向滑杆"
                      numberAriaLabel="风向"
                      max="360"
                      min="0"
                      step="1"
                      value={settings.wind.directionDegrees}
                      onValueChange={(value) => updateWorldSettings({ wind: { directionDegrees: Number(value) } })}
                    />
                    <InspectorRangeNumberField
                      label="风速"
                      rangeAriaLabel="风速滑杆"
                      numberAriaLabel="风速"
                      max="40"
                      min="0"
                      step="0.1"
                      value={settings.wind.speedMps}
                      onValueChange={(value) => updateWorldSettings({ wind: { speedMps: Number(value) } })}
                    />
                    <InspectorRangeNumberField
                      label="阵风"
                      rangeAriaLabel="阵风滑杆"
                      numberAriaLabel="阵风"
                      max="1"
                      min="0"
                      step="0.01"
                      value={settings.wind.gustiness}
                      onValueChange={(value) => updateWorldSettings({ wind: { gustiness: Number(value) } })}
                    />
                    <InspectorRangeNumberField
                      label="湍流"
                      rangeAriaLabel="湍流滑杆"
                      numberAriaLabel="湍流"
                      max="1"
                      min="0"
                      step="0.01"
                      value={settings.wind.turbulence}
                      onValueChange={(value) => updateWorldSettings({ wind: { turbulence: Number(value) } })}
                    />
                  </div>
                  <div className="scene-subgroup scene-world-card">
                    <p className="scene-subgroup-title">昼夜</p>
                    <InspectorRangeNumberField
                      label="时刻"
                      rangeAriaLabel="时刻滑杆"
                      numberAriaLabel="时刻"
                      max="24"
                      min="0"
                      step="0.25"
                      value={settings.timeOfDay.hours}
                      onValueChange={(value) => updateWorldSettings({ timeOfDay: { hours: Number(value) } })}
                    />
                    {settings.timeOfDay.mode === "cycle" ? (
                      <InspectorRangeNumberField
                        label="循环时长（分钟）"
                        rangeAriaLabel="循环时长滑杆"
                        numberAriaLabel="循环时长"
                        max="240"
                        min="0.5"
                        step="0.5"
                        value={settings.timeOfDay.cycleMinutes}
                        onValueChange={(value) => updateWorldSettings({ timeOfDay: { cycleMinutes: Number(value) } })}
                      />
                    ) : null}
                  </div>
                  <div className="scene-subgroup scene-world-card">
                    <p className="scene-subgroup-title">天气</p>
                    <InspectorRangeNumberField
                      label="强度"
                      rangeAriaLabel="天气强度滑杆"
                      numberAriaLabel="天气强度"
                      max="1"
                      min="0"
                      step="0.01"
                      value={settings.weather.intensity}
                      onValueChange={(value) => updateWorldSettings({ weather: { intensity: Number(value) } })}
                    />
                    <InspectorRangeNumberField
                      label="云量"
                      rangeAriaLabel="云量滑杆"
                      numberAriaLabel="云量"
                      max="1"
                      min="0"
                      step="0.01"
                      value={settings.weather.cloudCover}
                      onValueChange={(value) => updateWorldSettings({ weather: { cloudCover: Number(value) } })}
                    />
                    <InspectorRangeNumberField
                      label="湿润"
                      rangeAriaLabel="湿润滑杆"
                      numberAriaLabel="湿润"
                      max="1"
                      min="0"
                      step="0.01"
                      value={settings.weather.wetness}
                      onValueChange={(value) => updateWorldSettings({ weather: { wetness: Number(value) } })}
                    />
                    {weatherEvolving ? (
                      <InspectorRangeNumberField
                        label="演化周期（秒）"
                        rangeAriaLabel="演化周期滑杆"
                        numberAriaLabel="演化周期"
                        max="3600"
                        min="60"
                        step="30"
                        value={
                          settings.weather.evolution?.periodSeconds ?? DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS
                        }
                        onValueChange={(value) =>
                          updateWorldSettings({
                            weather: { evolution: { mode: "cycle", periodSeconds: Number(value) } },
                          })
                        }
                      />
                    ) : null}
                  </div>
                </div>
              </InspectorSection>
            </div>
          ) : null}

          {activeTab === "effects" ? (
            <div aria-label="环境效果设置" className="scene-world-tabpanel" role="tabpanel">
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">环境效果</p>
                {effects.length === 0 ? <p className="inspector-empty-state">尚未添加效果</p> : null}
                {effects.map((effect) => (
                  <WorldEffectEntry
                    basinAmplitudeScale={waterAmplitudeScale}
                    key={effect.id}
                    effect={effect}
                    water={waterSpatial}
                    onUpsert={upsertWorldEffect}
                    onRemove={(effectId) => removeWorldEffects([effectId])}
                  />
                ))}
                <div className="scene-world-add-row">
                  <InspectorSelectField
                    label="效果种类"
                    ariaLabel="新效果种类"
                    value={newEffectKind}
                    options={WORLD_EFFECT_KINDS.map((kind) => ({ value: kind, label: WORLD_EFFECT_KIND_LABELS[kind] }))}
                    onChange={(value) => setNewEffectKind(value as WorldEffectKind)}
                  />
                  <button
                    aria-label="添加效果"
                    className="inspector-action-button"
                    type="button"
                    onClick={() => upsertWorldEffect(createPanelWorldEffect(newEffectKind))}
                  >
                    <Plus aria-hidden="true" size={13} strokeWidth={1.9} />
                    <span>添加效果</span>
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "water" ? (
            <div aria-label="水体设置" className="scene-world-tabpanel" role="tabpanel">
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">水体</p>
                {waterBodies.length === 0 ? <p className="inspector-empty-state">尚未添加水体</p> : null}
                {waterBodies.map((body) => (
                  <WorldWaterEntry
                    key={body.id}
                    body={body}
                    onUpsert={upsertWorldWaterBody}
                    onRemove={(bodyId) => removeWorldWaterBodies([bodyId])}
                  />
                ))}
                <div className="scene-world-add-row">
                  <button
                    aria-label="添加水体"
                    className="inspector-action-button"
                    type="button"
                    onClick={() => upsertWorldWaterBody(createPanelWaterBody())}
                  >
                    <Plus aria-hidden="true" size={13} strokeWidth={1.9} />
                    <span>添加水体</span>
                  </button>
                  <button
                    aria-label="添加河流"
                    className="inspector-action-button"
                    type="button"
                    onClick={() => upsertWorldWaterBody(createPanelRiver())}
                  >
                    <Plus aria-hidden="true" size={13} strokeWidth={1.9} />
                    <span>添加河流</span>
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "wildlife" ? (
            <div aria-label="生态设置" className="scene-world-tabpanel" role="tabpanel">
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">野生动物</p>
                {wildlife.length === 0 ? <p className="inspector-empty-state">尚未添加动物群</p> : null}
                {wildlife.map((group) => (
                  <WorldWildlifeEntry
                    key={group.id}
                    group={group}
                    onUpsert={upsertWorldWildlifeGroup}
                    onRemove={(groupId) => removeWorldWildlifeGroups([groupId])}
                  />
                ))}
                <div className="scene-world-add-row">
                  <InspectorSelectField
                    label="物种"
                    ariaLabel="新动物物种"
                    value={newSpecies}
                    options={WORLD_WILDLIFE_SPECIES.map((species) => ({
                      value: species,
                      label: WORLD_WILDLIFE_SPECIES_LABELS[species],
                    }))}
                    onChange={(value) => setNewSpecies(value as WorldWildlifeSpecies)}
                  />
                  <button
                    aria-label="添加动物群"
                    className="inspector-action-button"
                    type="button"
                    onClick={() => upsertWorldWildlifeGroup(createPanelWildlifeGroup(newSpecies))}
                  >
                    <Plus aria-hidden="true" size={13} strokeWidth={1.9} />
                    <span>添加动物群</span>
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {activeTab === "traffic" ? (
            <div aria-label="交通设置" className="scene-world-tabpanel" role="tabpanel">
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">交通道路</p>
                {roads.length === 0 ? <p className="inspector-empty-state">尚未添加道路</p> : null}
                {roads.map((road) => (
                  <WorldRoadEntry
                    basinAmplitudeScale={waterAmplitudeScale}
                    key={road.id}
                    road={road}
                    water={waterSpatial}
                    onUpsert={upsertWorldRoad}
                    onRemove={(roadId) => removeWorldRoads([roadId])}
                  />
                ))}
                <div className="scene-world-add-row">
                  <button
                    aria-label="添加道路"
                    className="inspector-action-button"
                    type="button"
                    onClick={() => upsertWorldRoad(createPanelRoad())}
                  >
                    <Plus aria-hidden="true" size={13} strokeWidth={1.9} />
                    <span>添加道路</span>
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </InspectorSection>
  );
}
