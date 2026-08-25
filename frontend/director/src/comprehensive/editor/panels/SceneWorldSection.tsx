import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { InspectorRangeNumberField, InspectorSection, InspectorSelectField } from "./InspectorControls";
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
  DIRECTOR_WORLD_WEATHER_DEFAULT_PERIOD_SECONDS,
  WORLD_EFFECT_KINDS,
  WORLD_WEATHER_PRESETS,
  WORLD_WILDLIFE_SPECIES,
  createDefaultDirectorWorldSettings,
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

export function SceneWorldSection() {
  const world = useDirectorStore((state) => state.project.world);
  const updateWorldSettings = useDirectorStore((state) => state.updateWorldSettings);
  const upsertWorldEffect = useDirectorStore((state) => state.upsertWorldEffect);
  const removeWorldEffects = useDirectorStore((state) => state.removeWorldEffects);
  const upsertWorldWaterBody = useDirectorStore((state) => state.upsertWorldWaterBody);
  const removeWorldWaterBodies = useDirectorStore((state) => state.removeWorldWaterBodies);
  const upsertWorldWildlifeGroup = useDirectorStore((state) => state.upsertWorldWildlifeGroup);
  const removeWorldWildlifeGroups = useDirectorStore((state) => state.removeWorldWildlifeGroups);

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
  const tabCount: Partial<Record<WorldPanelTab, number>> = {
    effects: effects.length,
    water: waterBodies.length,
    wildlife: wildlife.length,
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
                  <div className="scene-world-entry" key={effect.id} aria-label={`${effect.name}效果条目`}>
                    <div className="scene-world-entry-header">
                      <span className="scene-world-entry-name">
                        {effect.name}（{WORLD_EFFECT_KIND_LABELS[effect.kind]}）
                      </span>
                      <button
                        aria-label={`删除${effect.name}`}
                        className="scene-world-entry-delete"
                        type="button"
                        onClick={() => removeWorldEffects([effect.id])}
                      >
                        <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
                      </button>
                    </div>
                    <InspectorRangeNumberField
                      label="强度"
                      rangeAriaLabel={`${effect.name}强度滑杆`}
                      numberAriaLabel={`${effect.name}强度`}
                      max="3"
                      min="0"
                      step="0.05"
                      value={effect.intensity}
                      onValueChange={(value) => upsertWorldEffect({ ...effect, intensity: Number(value) })}
                    />
                    {effect.kind === "fire" && effect.anchor.objectId === null ? (
                      <>
                        <div
                          className="inspector-toggle-stack"
                          role="group"
                          aria-label={`${effect.name}蔓延开关`}
                        >
                          <WorldToggleRow
                            label="火势蔓延"
                            checked={effect.propagation?.enabled === true}
                            onChange={(checked) =>
                              upsertWorldEffect({
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
                                upsertWorldEffect({
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
                                upsertWorldEffect({
                                  ...effect,
                                  propagation: { ...effect.propagation!, spreadRate: Number(value) },
                                })
                              }
                            />
                          </>
                        ) : null}
                      </>
                    ) : null}
                    <div className="inspector-toggle-stack" role="group" aria-label={`${effect.name}可见性`}>
                      <WorldToggleRow
                        label="可见"
                        checked={effect.visible}
                        onChange={(checked) => upsertWorldEffect({ ...effect, visible: checked })}
                      />
                    </div>
                  </div>
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
                  <div className="scene-world-entry" key={body.id} aria-label={`${body.name}水体条目`}>
                    <div className="scene-world-entry-header">
                      <span className="scene-world-entry-name">
                        {body.name}
                        {body.river ? "（河流）" : ""}
                      </span>
                      <button
                        aria-label={`删除${body.name}`}
                        className="scene-world-entry-delete"
                        type="button"
                        onClick={() => removeWorldWaterBodies([body.id])}
                      >
                        <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
                      </button>
                    </div>
                    {body.river ? (
                      <InspectorRangeNumberField
                        label="河道宽度"
                        rangeAriaLabel={`${body.name}河道宽度滑杆`}
                        numberAriaLabel={`${body.name}河道宽度`}
                        max="60"
                        min="0.5"
                        step="0.5"
                        value={body.river.widthM}
                        onValueChange={(value) =>
                          upsertWorldWaterBody({ ...body, river: { ...body.river!, widthM: Number(value) } })
                        }
                      />
                    ) : (
                      <InspectorRangeNumberField
                        label="波浪幅度"
                        rangeAriaLabel={`${body.name}波浪幅度滑杆`}
                        numberAriaLabel={`${body.name}波浪幅度`}
                        max="3"
                        min="0"
                        step="0.01"
                        value={body.waveAmplitude}
                        onValueChange={(value) => upsertWorldWaterBody({ ...body, waveAmplitude: Number(value) })}
                      />
                    )}
                    <InspectorRangeNumberField
                      label="流速"
                      rangeAriaLabel={`${body.name}流速滑杆`}
                      numberAriaLabel={`${body.name}流速`}
                      max="10"
                      min="0"
                      step="0.1"
                      value={body.flowSpeedMps}
                      onValueChange={(value) => upsertWorldWaterBody({ ...body, flowSpeedMps: Number(value) })}
                    />
                    <div className="inspector-toggle-stack" role="group" aria-label={`${body.name}可见性`}>
                      <WorldToggleRow
                        label="可见"
                        checked={body.visible}
                        onChange={(checked) => upsertWorldWaterBody({ ...body, visible: checked })}
                      />
                    </div>
                  </div>
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
                  <div className="scene-world-entry" key={group.id} aria-label={`${group.name}动物群条目`}>
                    <div className="scene-world-entry-header">
                      <span className="scene-world-entry-name">
                        {group.name}（{WORLD_WILDLIFE_SPECIES_LABELS[group.species]}）
                      </span>
                      <button
                        aria-label={`删除${group.name}`}
                        className="scene-world-entry-delete"
                        type="button"
                        onClick={() => removeWorldWildlifeGroups([group.id])}
                      >
                        <Trash2 aria-hidden="true" size={13} strokeWidth={1.9} />
                      </button>
                    </div>
                    <InspectorRangeNumberField
                      label="数量"
                      rangeAriaLabel={`${group.name}数量滑杆`}
                      numberAriaLabel={`${group.name}数量`}
                      max="256"
                      min="1"
                      step="1"
                      value={group.count}
                      onValueChange={(value) =>
                        upsertWorldWildlifeGroup({ ...group, count: Math.max(1, Math.round(Number(value))) })
                      }
                    />
                    <div className="inspector-toggle-stack" role="group" aria-label={`${group.name}可见性`}>
                      <WorldToggleRow
                        label="可见"
                        checked={group.visible}
                        onChange={(checked) => upsertWorldWildlifeGroup({ ...group, visible: checked })}
                      />
                    </div>
                  </div>
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
        </>
      ) : null}
    </InspectorSection>
  );
}
