import { useEffect, useState } from "react";
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

/** Default circuit: a rounded 24×16 m loop around the origin with light traffic. */
function createPanelRoad(): DirectorWorldRoad {
  return {
    id: createWorldEntryId("road"),
    name: "道路",
    points: [
      [12, 0.05, 8],
      [0, 0.05, 8],
      [-12, 0.05, 8],
      [-12, 0.05, 0],
      [-12, 0.05, -8],
      [0, 0.05, -8],
      [12, 0.05, -8],
      [12, 0.05, 0],
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
  effect,
  onUpsert,
  onRemove,
}: {
  effect: DirectorWorldEffect;
  onUpsert: (effect: DirectorWorldEffect) => void;
  onRemove: (effectId: string) => void;
}) {
  const shape = effect.shape;
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
      {effect.locked ? (
        <WorldLockedHint />
      ) : (
        <>
          <WorldEntryNameField
            ariaLabel={`${effect.name}名称`}
            value={effect.name}
            onCommit={(name) => onUpsert({ ...effect, name })}
          />
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
                onUpsert({ ...effect, shape: { ...shape, radius: toClampedNumber(value, shape.radius, 0.01, 500) } })
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
                        propagation: {
                          ...effect.propagation!,
                          radiusM: toClampedNumber(value, effect.propagation!.radiusM, 2, 64),
                        },
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
                        propagation: {
                          ...effect.propagation!,
                          spreadRate: toClampedNumber(value, effect.propagation!.spreadRate, 0.1, 3),
                        },
                      })
                    }
                  />
                </>
              ) : null}
            </>
          ) : null}
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
  road,
  onUpsert,
  onRemove,
}: {
  road: DirectorWorldRoad;
  onUpsert: (road: DirectorWorldRoad) => void;
  onRemove: (roadId: string) => void;
}) {
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
      {road.locked ? (
        <WorldLockedHint />
      ) : (
        <>
          <WorldEntryNameField
            ariaLabel={`${road.name}名称`}
            value={road.name}
            onCommit={(name) => onUpsert({ ...road, name })}
          />
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
          <div className="inspector-toggle-stack" role="group" aria-label={`${road.name}道路选项`}>
            <WorldToggleRow label="环路" checked={road.loop} onChange={(loop) => onUpsert({ ...road, loop })} />
            <WorldToggleRow
              label="显示路面"
              checked={road.showSurface}
              onChange={(showSurface) => onUpsert({ ...road, showSurface })}
            />
          </div>
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
  const waterBodies = world?.waterBodies ?? [];
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
                <InspectorSelectField
                  label="时刻模式"
                  ariaLabel="时刻模式"
                  value={settings.timeOfDay.mode}
                  options={[
                    { value: "fixed", label: "固定时刻" },
                    { value: "cycle", label: "昼夜循环" },
                  ]}
                  onChange={(value) => updateWorldSettings({ timeOfDay: { mode: value as "fixed" | "cycle" } })}
                />
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
                <InspectorSelectField
                  label="天气预设"
                  ariaLabel="天气预设"
                  value={settings.weather.preset}
                  options={WORLD_WEATHER_PRESETS.map((preset) => ({
                    value: preset,
                    label: WORLD_WEATHER_PRESET_LABELS[preset],
                  }))}
                  onChange={(value) => updateWorldSettings({ weather: { preset: value as WorldWeatherPreset } })}
                />
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
                <InspectorSelectField
                  label="天气演化"
                  ariaLabel="天气演化模式"
                  value={settings.weather.evolution?.mode ?? "static"}
                  options={[
                    { value: "static", label: "静态（固定预设）" },
                    { value: "cycle", label: "种子循环" },
                  ]}
                  onChange={(value) =>
                    updateWorldSettings({
                      weather: {
                        evolution: {
                          mode: value as WorldWeatherEvolutionMode,
                          periodSeconds:
                            settings.weather.evolution?.periodSeconds ??
                            DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
                        },
                      },
                    })
                  }
                />
                {weatherEvolving ? (
                  <InspectorRangeNumberField
                    label="演化周期（秒）"
                    rangeAriaLabel="演化周期滑杆"
                    numberAriaLabel="演化周期"
                    max="3600"
                    min="60"
                    step="30"
                    value={settings.weather.evolution?.periodSeconds ?? DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS}
                    onValueChange={(value) =>
                      updateWorldSettings({
                        weather: { evolution: { mode: "cycle", periodSeconds: Number(value) } },
                      })
                    }
                  />
                ) : null}
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
                    <span>实时湿度：{Math.round(climateReadout.wetness * 100)}%</span>
                    <span>实时云量：{Math.round(climateReadout.cloudCover * 100)}%</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {activeTab === "effects" ? (
            <div aria-label="环境效果设置" className="scene-world-tabpanel" role="tabpanel">
              <div className="scene-subgroup scene-world-card">
                <p className="scene-subgroup-title">环境效果</p>
                {effects.length === 0 ? <p className="inspector-empty-state">尚未添加效果</p> : null}
                {effects.map((effect) => (
                  <WorldEffectEntry
                    key={effect.id}
                    effect={effect}
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
                    key={road.id}
                    road={road}
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
