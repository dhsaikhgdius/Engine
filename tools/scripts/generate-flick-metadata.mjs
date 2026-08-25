#!/usr/bin/env node
/**
 * Deterministic Chinese localization, tagging, and metric metadata generator for the
 * Flick stage-prop library (assets/library/flick-stage-props).
 *
 * Reads catalog.json, tokenizes every fileName, translates through the
 * hand-authored dictionaries below (word roots, multi-token phrases, and
 * per-item overrides), derives per-item metric bounds from the GLB scene, and
 * writes metadata.i18n.json conforming to
 * flickMetadataOverlaySchema in packages/protocol/src/assetCatalogProtocol.ts
 * (structural checks are mirrored in plain JS here; the vitest suite
 * cross-checks against the real zod schema).
 *
 * No runtime dependencies, no network, no LLM calls. Running the script twice
 * produces byte-identical output.
 *
 *   node tools/scripts/generate-flick-metadata.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..", "..");

export const CATALOG_PATH = path.join(repoRoot, "assets", "library", "flick-stage-props", "catalog.json");
export const OUTPUT_PATH = path.join(repoRoot, "assets", "library", "flick-stage-props", "metadata.i18n.json");

const GENERATOR_ID = "tools/scripts/generate-flick-metadata.mjs";

/**
 * Metres represented by one authored source unit in each Flick pack. The
 * source packs do not share a physical unit, so this is the one calibration
 * boundary that converts their geometry into Director's 1 unit = 1 metre
 * contract. Per-item overrides below cover normalized models whose geometry
 * intentionally discarded semantic size (notably animals).
 */
const METRES_PER_SOURCE_UNIT = {
  animals: 0.8,
  boats: 10,
  buildings: 5,
  cars: 1,
  dungeon: 2.5,
  furniture: 2,
  guns: 0.35,
  houses: 2,
  medieval: 2.5,
  medievalkit: 1.6,
  nature: 2,
  pirate: 2.3,
  spaceships: 1.5,
  tanks: 0.45,
  trains: 2,
  trees: 3,
  vehicles: 3,
  weapons: 1.8,
};

/** Largest real-world dimension in metres for normalized or audited models. */
const ITEM_MAX_SIZE_M = {
  "animals/betta_fish.glb": 0.18,
  "animals/brown_bear.glb": 2.2,
  "animals/cat_2.glb": 0.6,
  "animals/cat.glb": 0.6,
  "animals/cow.glb": 2.4,
  "animals/dolphin.glb": 3.5,
  "animals/elephant.glb": 6.5,
  "animals/giraffe.glb": 5.5,
  "animals/horse.glb": 2.5,
  "animals/kangaroo.glb": 2.1,
  "animals/lion.glb": 2.5,
  "animals/mallard_duck.glb": 0.6,
  "animals/panda.glb": 1.9,
  "animals/penguin.glb": 1.1,
  "animals/pig.glb": 1.6,
  "animals/pigeon.glb": 0.35,
  "animals/rabbit.glb": 0.5,
  "animals/sheep.glb": 1.5,
  "animals/tiger.glb": 3,
  "animals/whale.glb": 12,
  "furniture/cabinet_television.glb": 1.8,
  "furniture/lamp_round_floor.glb": 1.75,
  "furniture/lounge_sofa_long.glb": 2.4,
  "furniture/potted_plant.glb": 1.1,
  "furniture/rug_rectangle.glb": 2.4,
  "furniture/table_coffee.glb": 1.2,
  "furniture/television_modern.glb": 1.35,
};

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiplyMatrices(left, right) {
  const result = new Array(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let index = 0; index < 4; index += 1) {
        result[column * 4 + row] += left[index * 4 + row] * right[column * 4 + index];
      }
    }
  }
  return result;
}

function nodeMatrix(node) {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return node.matrix;
  const [x, y, z, w] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ];
}

function transformPoint(matrix, point) {
  const [x, y, z] = point;
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function unionBounds(target, min, max, matrix = IDENTITY_MATRIX) {
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) {
        const point = transformPoint(matrix, [x, y, z]);
        for (let axis = 0; axis < 3; axis += 1) {
          target.min[axis] = Math.min(target.min[axis], point[axis]);
          target.max[axis] = Math.max(target.max[axis], point[axis]);
        }
      }
    }
  }
}

function meshBounds(gltf, meshIndex) {
  const bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const mesh = gltf.meshes?.[meshIndex];
  for (const primitive of mesh?.primitives ?? []) {
    const accessor = gltf.accessors?.[primitive.attributes?.POSITION];
    if (!accessor?.min || !accessor?.max) continue;
    unionBounds(bounds, accessor.min, accessor.max);
  }
  return Number.isFinite(bounds.min[0]) ? bounds : null;
}

/** Derive a complete scene-space AABB from glTF accessor bounds and node transforms. */
export function extractGltfPositionBounds(gltf) {
  const result = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const nodes = gltf.nodes ?? [];
  const meshBoundsByIndex = (gltf.meshes ?? []).map((_, index) => meshBounds(gltf, index));
  const referencedChildren = new Set(nodes.flatMap((node) => node.children ?? []));
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, index) => index).filter((index) => !referencedChildren.has(index));

  const visit = (nodeIndex, parentMatrix, ancestors) => {
    if (ancestors.has(nodeIndex)) return;
    const node = nodes[nodeIndex];
    if (!node) return;
    const worldMatrix = multiplyMatrices(parentMatrix, nodeMatrix(node));
    const localBounds = Number.isInteger(node.mesh) ? meshBoundsByIndex[node.mesh] : null;
    if (localBounds) unionBounds(result, localBounds.min, localBounds.max, worldMatrix);
    const nextAncestors = new Set(ancestors).add(nodeIndex);
    for (const child of node.children ?? []) visit(child, worldMatrix, nextAncestors);
  };

  for (const root of roots) visit(root, IDENTITY_MATRIX, new Set());
  if (!Number.isFinite(result.min[0])) {
    for (const bounds of meshBoundsByIndex) {
      if (bounds) unionBounds(result, bounds.min, bounds.max);
    }
  }
  return Number.isFinite(result.min[0]) ? result : null;
}

function readGlbGltf(category, fileName) {
  const bytes = readFileSync(path.join(repoRoot, "assets", "library", "flick-stage-props", category, fileName));
  const jsonLength = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
}

function roundMetres(value) {
  const rounded = Math.round(value * 1e6) / 1e6;
  return rounded === 0 ? 0 : rounded;
}

function metricSpatialFor(category, fileName) {
  const key = `${category}/${fileName}`;
  const sourceBounds = extractGltfPositionBounds(readGlbGltf(category, fileName));
  if (!sourceBounds) throw new Error(`${key} has no measurable POSITION bounds`);
  const sourceSize = sourceBounds.max.map((value, axis) => value - sourceBounds.min[axis]);
  const sourceMax = Math.max(...sourceSize);
  if (!(sourceMax > 0)) throw new Error(`${key} has degenerate POSITION bounds`);
  const targetMax = ITEM_MAX_SIZE_M[key];
  const scale = targetMax === undefined ? METRES_PER_SOURCE_UNIT[category] : targetMax / sourceMax;
  if (!(scale > 0)) throw new Error(`${key} has no metric source calibration`);
  const bounds = sourceSize.map((value) => roundMetres(value * scale));
  return {
    bounds_m: bounds,
    footprint_m: [bounds[0], bounds[2]],
    height_m: bounds[1],
    ground_offset_y: roundMetres(-sourceBounds.min[1] * scale),
    front_axis: null,
  };
}

/**
 * name_zh values that are allowed to contain no CJK character at all.
 * Currently every generated name is Chinese-led, so the list stays empty;
 * add full "<category>/<fileName>" keys here only for pure designations.
 */
export const DESIGNATION_NAME_EXCEPTIONS = [];

/** Mirrors frontend/director/src/comprehensive/editor/modelLibrary/flickSourceCategories.json */
const STANDARD_CATEGORY = {
  animals: "animals",
  boats: "vehicles",
  buildings: "structure",
  cars: "vehicles",
  dungeon: "structure",
  furniture: "furniture",
  guns: "guns",
  houses: "structure",
  medieval: "structure",
  medievalkit: "structure",
  nature: "nature",
  pirate: "structure",
  spaceships: "vehicles",
  tanks: "vehicles",
  trains: "vehicles",
  trees: "nature",
  vehicles: "vehicles",
  weapons: "weapons",
};

/** Baseline semantic tags contributed by the source category itself. */
const CATEGORY_TAGS = {
  animals: ["animal"],
  boats: ["boat", "watercraft"],
  buildings: ["building", "city", "modular"],
  cars: ["car"],
  dungeon: ["sci-fi", "modular"],
  furniture: ["furniture", "interior"],
  guns: ["gun", "firearm"],
  houses: ["house", "building"],
  medieval: ["medieval", "building"],
  medievalkit: ["medieval", "modular", "building"],
  nature: ["nature", "outdoor"],
  pirate: ["pirate"],
  spaceships: ["spaceship", "sci-fi", "spacecraft"],
  tanks: ["tank", "military", "vehicle"],
  trains: ["train", "railway"],
  trees: ["vegetation"],
  vehicles: ["vehicle"],
  weapons: ["weapon"],
};

// ---------------------------------------------------------------------------
// Dictionary helpers.
//
// Entry roles:
//   pre     -> adjective/qualifier placed before the head noun ("大", "木制")
//   head    -> noun; consecutive heads concatenate ("厨房" + "水槽")
//              `alt` (optional) is used as a parenthetical post instead when a
//              head noun already exists ("岩石" vs "…（棕岩）")
//   post    -> parenthetical qualifier appended at the end ("精细", "积雪")
//   marker  -> structural token: `suffix` appended after heads when the marker
//              is the first token (dungeon "details_*"), otherwise/or `alt`
//              becomes a post ("残骸"); contributes tags only when bare.
//   variant -> Latin designation kept verbatim in the variant slot ("Oobi")
// ---------------------------------------------------------------------------
const pre = (zh, extra = {}) => ({ role: "pre", zh, ...extra });
const head = (zh, extra = {}) => ({ role: "head", zh, ...extra });
const post = (zh, extra = {}) => ({ role: "post", zh, ...extra });
const marker = (extra = {}) => ({ role: "marker", ...extra });
const designation = (zh, extra = {}) => ({ role: "variant", zh, ...extra });

// ---------------------------------------------------------------------------
// Global word dictionary (token -> entry). Category-specific overrides live in
// CATEGORY_WORDS below and win over these defaults.
// ---------------------------------------------------------------------------
const WORDS = {
  // --- generic size / shape / state modifiers -----------------------------
  large: pre("大", { tags: ["large"] }),
  larger: post("加大"),
  big: post("大"),
  small: pre("小", { tags: ["small"] }),
  medium: post("中型"),
  tall: pre("高"),
  short: post("短款"),
  long: post("长款"),
  wide: post("宽体"),
  slim: post("窄体"),
  thin: post("窄款"),
  thick: post("加厚"),
  narrow: post("窄版"),
  flat: post("扁平"),
  round: pre("圆形"),
  rounded: post("圆角"),
  rond: post("圆角"),
  square: post("方形"),
  high: post("高款"),
  low: post("矮款"),
  fat: pre("粗壮"),
  left: pre("左"),
  right: pre("右"),
  inner: post("内侧"),
  interior: pre("室内"),
  exterior: pre("室外"),
  top: post("顶部"),
  bottom: pre("底部"),
  back: post("后"),
  front: post("前"),
  center: post("中段"),
  middle: post("中间"),
  side: post("侧边"),
  sides: post("双侧"),
  corner: post("转角"),
  diagonal: post("对角"),
  double: post("双拼"),
  single: post("单体"),
  triple: post("三联"),
  empty: post("空白"),
  full: post("满载"),
  half: post("半款"),
  quarter: post("四分之一"),
  open: post("敞开"),
  closed: post("关闭"),
  cut: post("已砍伐"),
  detailed: post("精细", { tags: ["detailed"] }),
  details: post("细节装饰"),
  detail: post("细节件"),
  default: post("标准"),
  basic: pre("基础"),
  simple: pre("简易"),
  clean: post("简洁"),
  modern: pre("现代", { tags: ["modern"] }),
  vintage: pre("复古", { tags: ["vintage"] }),
  design: pre("设计师", { tags: ["designer"] }),
  luxury: pre("豪华", { tags: ["luxury"] }),
  normal: pre("普通"),
  common: pre("普通"),
  old: pre("老"),
  damaged: post("破损", { tags: ["damaged"] }),
  dead: post("枯死", { tags: ["dead"] }),
  autumn: post("秋季", { tags: ["autumn"] }),
  fall: post("秋季", { tags: ["autumn"] }),
  snow: post("积雪", { tags: ["snow", "winter"] }),
  moss: post("苔藓", { tags: ["moss"] }),
  dark: post("深色"),
  darkh: post("深色"), // catalog typo for "dark" (nature/tree_fat_darkh.glb)
  light: post("浅色"),
  mirror: post("镜像"),
  extended: post("加长"),
  extension: post("延伸段"),
  standing: post("立式"),
  stacked: post("叠放"),
  stack: post("叠层"),
  mobile: pre("移动式"),
  built: pre("嵌入"), // consumed by the (built, in) phrase
  in: post("内"),
  future: pre("未来", { tags: ["futuristic"] }),
  ghost: pre("幽灵", { tags: ["ghost"] }),
  relax: post("躺姿"),
  solid: post("实心"),
  incline: post("斜面"),
  angle: post("转角"),
  straight: post("直段"),
  rails: post("带扶手", { tags: ["railing"] }),
  only: post("仅"),
  down: post("下延"),
  off: post("锯短"),
  sawed: pre("锯短"),
  no: post("无"),
  first: pre("第一"),
  second: pre("第二"),
  three: pre("三"),
  age: post("时代"),
  level: post("级"),
  leve: post("级"), // catalog typo for "level" (medieval/storage_first_age_leve3.glb)
  stage: post("生长期"),
  group: post("成组", { tags: ["group"] }),
  complete: pre("完整"),
  modular: pre("模块化", { tags: ["modular"] }),
  upper: pre("上部"),
  passenger: pre("客运", { tags: ["passenger"] }),
  cargo: pre("货运", { tags: ["cargo"] }),

  // --- colors / materials ---------------------------------------------------
  brown: pre("棕色"),
  red: pre("红色"),
  blue: pre("蓝色"),
  purple: pre("紫色"),
  yellow: pre("黄色"),
  orange: pre("橙色"),
  tan: pre("棕褐色"),
  gold: head("黄金", { tags: ["gold"] }),
  wood: head("木材", { alt: "木面", tags: ["wood"] }),
  wooden: pre("木制", { tags: ["wood"] }),
  metal: pre("金属", { tags: ["metal"] }),
  glass: pre("玻璃", { tags: ["glass"] }),
  stone: head("石头", { alt: "灰石", tags: ["stone"] }),
  rock: head("岩石", { alt: "棕岩", tags: ["rock"] }),
  brick: head("砖块", { alt: "砖面", tags: ["brick"] }),
  bricks: head("砖块组", { alt: "砖砌", tags: ["brick"] }),
  plaster: head("灰泥", { alt: "灰泥面", tags: ["plaster"] }),
  uneven: pre("不规则"),
  sand: pre("沙地", { tags: ["sand"] }),
  dirt: head("泥土", { tags: ["dirt"] }),
  cardboard: pre("纸质"),
  foam: pre("泡沫", { tags: ["foam"] }),
  coal: pre("煤", { tags: ["coal"] }),

  // --- animals ---------------------------------------------------------------
  betta: pre("斗"),
  fish: head("鱼", { tags: ["fish", "aquatic"] }),
  bear: head("熊", { alias: ["狗熊"], tags: ["bear", "wildlife", "predator"] }),
  cat: head("猫", { alias: ["猫咪", "小猫"], tags: ["cat", "pet", "feline"] }),
  cow: head("奶牛", { alias: ["牛", "母牛"], tags: ["cow", "cattle", "livestock", "farm"] }),
  dolphin: head("海豚", { tags: ["dolphin", "marine", "aquatic"] }),
  elephant: head("大象", { alias: ["象"], tags: ["elephant", "wildlife"] }),
  giraffe: head("长颈鹿", { tags: ["giraffe", "wildlife"] }),
  horse: head("马", { alias: ["骏马"], tags: ["horse", "livestock"] }),
  kangaroo: head("袋鼠", { tags: ["kangaroo", "wildlife"] }),
  lion: head("狮子", { alias: ["狮", "雄狮"], tags: ["lion", "wildlife", "predator", "feline"] }),
  mallard: pre("绿头"),
  duck: head("鸭", { alias: ["鸭子"], tags: ["duck", "bird", "waterfowl"] }),
  panda: head("熊猫", { alias: ["大熊猫"], tags: ["panda", "wildlife", "bear"] }),
  penguin: head("企鹅", { tags: ["penguin", "bird"] }),
  pig: head("猪", { alias: ["小猪"], tags: ["pig", "livestock", "farm"] }),
  pigeon: head("鸽子", { alias: ["鸽", "信鸽"], tags: ["pigeon", "bird"] }),
  rabbit: head("兔子", { alias: ["兔", "小兔"], tags: ["rabbit", "wildlife", "pet"] }),
  sheep: head("绵羊", { alias: ["羊"], tags: ["sheep", "livestock", "farm"] }),
  tiger: head("老虎", { alias: ["虎"], tags: ["tiger", "wildlife", "predator", "feline"] }),
  whale: head("鲸鱼", { alias: ["鲸"], tags: ["whale", "marine", "aquatic"] }),

  // --- watercraft --------------------------------------------------------------
  boat: head("小船", { alias: ["船"], tags: ["boat"] }),
  ship: head("船", { tags: ["ship"] }),
  cruise: pre("游轮"),
  lifeboat: head("救生艇", { tags: ["lifeboat", "rescue"] }),
  sail: pre("帆", { tags: ["sail"] }),
  viking: pre("维京", { tags: ["viking"] }),
  wsail: post("带帆", { tags: ["sail"] }),
  canoe: head("独木舟", { tags: ["canoe"] }),
  paddle: head("船桨", { tags: ["paddle"] }),
  mast: head("桅杆", { tags: ["mast"] }),
  ropes: post("带缆绳", { tags: ["rope"] }),
  wreck: post("残骸", { tags: ["wreck"] }),
  row: post("单行"),

  // --- buildings / city ---------------------------------------------------------
  story: head("楼房", { tags: ["storefront"] }),
  base: post("基础素体"),
  mat: post("彩色材质", { tags: ["textured"] }),
  balcony: head("阳台", { alt: "带阳台", tags: ["balcony"] }),
  columns: post("带立柱", { tags: ["column"] }),
  column: head("立柱", { tags: ["column"] }),
  doors: post("带门"),
  door: head("门", { tags: ["door"] }),
  doorway: head("门洞", { tags: ["doorway"] }),
  doormat: head("门垫", { tags: ["doormat"] }),
  window: head("窗户", { alt: "带窗", tags: ["window"] }),
  windows: post("带窗", { tags: ["window"] }),
  roof: head("屋顶", { alt: "带屋顶", tags: ["roof"] }),
  sign: head("招牌", { alt: "带招牌", tags: ["sign"] }),
  sidehouse: post("带侧屋"),
  stairs: head("楼梯", { alt: "带楼梯", tags: ["stairs"] }),
  stair: head("楼梯", { tags: ["stairs"] }),
  staircase: head("楼梯", { alias: ["阶梯"], tags: ["stairs", "staircase"] }),
  step: head("台阶"),
  steps: post("台阶"),
  pipe: head("管道", { tags: ["pipe"] }),
  pipes: head("管道", { alt: "管道", tags: ["pipe"] }),
  bakery: head("面包店", { tags: ["bakery", "shop"] }),
  barbershop: head("理发店", { tags: ["barbershop", "shop"] }),
  bookshop: head("书店", { tags: ["bookshop", "shop"] }),
  hardware: head("五金店", { tags: ["shop"] }),
  pharmacy: head("药店", { tags: ["pharmacy", "shop"] }),
  casino: pre("赌场", { tags: ["casino"] }),
  ac: head("空调", { tags: ["air-conditioner"] }),
  unit: head("机组"),
  unitx4: post("×4"), // ac_unitx4; the item itself is overridden
  building: head("楼房", { alias: ["建筑"], tags: ["building"] }),
  house: head("住宅", { alias: ["房屋", "房子"], tags: ["house"] }),
  houses: head("民居", { alias: ["住宅"], tags: ["house"] }),
  wall: head("墙体", { alias: ["墙"], tags: ["wall"] }),
  walls: post("带侧壁"),
  floor: head("地板", { tags: ["floor"] }),
  ceiling: pre("吸顶"),
  platform: head("平台", { alt: "带平台", tags: ["platform"] }),
  structure: head("木构架", { tags: ["structure"] }),
  arch: post("拱形", { tags: ["arch"] }),
  frame: head("框架", { alt: "框架式" }),
  grid: post("木格架"),
  paneling: head("护墙板", { alias: ["墙板"], tags: ["paneling", "wall"] }),
  hallway: post("走廊"),
  tile: head("砖块", { tags: ["tile"] }),
  tiles: head("砖块", { tags: ["tile"] }),
  border: head("包边"),
  cover: head("盖板"),
  hole: head("洞口"),
  support: head("支撑", { tags: ["support"] }),
  supports: post("带支撑", { tags: ["support"] }),
  overhang: head("悬挑层", { alias: ["出挑"], tags: ["overhang"] }),
  dormer: post("老虎窗", { tags: ["dormer", "window"] }),
  chimney: head("烟囱", { tags: ["chimney"] }),
  shutters: post("带窗板", { tags: ["shutters"] }),
  inset: post("内嵌"),
  vine: head("藤蔓", { tags: ["vine", "plant"] }),
  wagon: head("运货马车", { alias: ["马车", "板车"], tags: ["wagon", "cart"] }),
  ornament: post("花饰"),
  fence: head("栅栏", { alias: ["围栏", "篱笆"], tags: ["fence"] }),
  gate: head("大门", { tags: ["gate"] }),

  // --- medieval RTS buildings -----------------------------------------------
  archery: head("射箭场", { alias: ["靶场", "弓箭场"], tags: ["archery"] }),
  barracks: head("兵营", { alias: ["军营"], tags: ["barracks", "military"] }),
  farm: head("农田", { alias: ["农场"], tags: ["farm"] }),
  market: head("市集", { alias: ["市场"], tags: ["market"] }),
  port: head("港口", { tags: ["port", "harbor"] }),
  storage: head("仓储库", { alias: ["仓库"], tags: ["storage", "warehouse"] }),
  temple: head("神庙", { alias: ["圣殿"], tags: ["temple"] }),
  town: pre("城镇"),
  windmill: head("风车磨坊", { alias: ["风车"], tags: ["windmill"] }),
  wonder: head("奇观", { tags: ["wonder", "monument"] }),
  dock: head("码头", { tags: ["dock", "harbor"] }),
  mine: head("矿井", { alias: ["矿场"], tags: ["mine"] }),
  mountain: head("山峰", { alias: ["山"], tags: ["mountain", "terrain"] }),
  resource: pre("资源", { tags: ["resource"] }),
  tower: head("塔楼", { alias: ["塔"], tags: ["tower"] }),
  towers: post("带塔楼", { tags: ["tower"] }),
  watch: pre("瞭望"),
  wheat: head("小麦", { alt: "带小麦", tags: ["wheat", "crop"] }),
  barrel: head("木桶", { alias: ["桶"], tags: ["barrel", "container"] }),
  crate: head("板条箱", { alias: ["木箱", "货箱"], tags: ["crate", "container"] }),
  logs: head("原木堆", { tags: ["log", "wood"] }),
  log: head("原木", { tags: ["log", "wood"] }),

  // --- sci-fi dungeon kit ---------------------------------------------------
  capsule: head("胶囊舱", { tags: ["capsule"] }),
  chest: head("宝箱", { alias: ["箱子", "储物箱"], tags: ["chest", "container"] }),
  computer: head("电脑", { alias: ["计算机"], tags: ["computer"] }),
  container: head("集装箱", { tags: ["container"] }),
  laser: head("激光钻机", { alias: ["激光装置"], tags: ["laser"] }),
  pod: head("休眠舱", { alias: ["太空舱"], tags: ["pod"] }),
  shelf: head("置物架", { alias: ["架子"], tags: ["shelf"] }),
  statue: head("雕像", { alias: ["塑像"], tags: ["statue"] }),
  teleporter: head("传送装置", { alias: ["传送器", "传送门"], tags: ["teleporter"] }),
  vessel: head("储罐", { alias: ["容器"], tags: ["vessel", "container"] }),
  output: head("输出端口", { tags: ["port"] }),
  cylinder: head("圆柱", { tags: ["cylinder"] }),
  dots: head("圆点", { tags: ["dots"] }),
  hexagon: head("六边形", { tags: ["hexagon"] }),
  triangles: head("三角形", { tags: ["triangle"] }),
  triangle: post("三角形", { tags: ["triangle"] }),
  vent: head("通风口", { alt: "通风口", tags: ["vent"] }),
  vents: head("通风口", { alt: "通风口", tags: ["vent"] }),
  plate: head("板件", { alt: "板件", tags: ["plate"] }),
  props: marker({ tags: ["prop"] }),
  prop: marker({ tags: ["prop"] }),

  // --- furniture --------------------------------------------------------------
  bathroom: pre("浴室", { tags: ["bathroom"] }),
  bathtub: head("浴缸", { tags: ["bathtub", "bathroom"] }),
  bed: head("床", { tags: ["bed", "bedroom"] }),
  bunk: post("双层"),
  bench: head("长凳", { alias: ["长椅"], tags: ["bench", "seating"] }),
  bookcase: head("书柜", { alias: ["书架"], tags: ["bookcase", "storage"] }),
  books: head("书堆", { alias: ["书本", "书籍"], tags: ["book"] }),
  box: head("纸箱", { alias: ["箱子"], tags: ["box", "container"] }),
  cabinet: head("收纳柜", { alias: ["柜子"], tags: ["cabinet", "storage"] }),
  chair: head("椅子", { alias: ["椅"], tags: ["chair", "seating"] }),
  cushion: pre("软垫", { tags: ["cushion"] }),
  coat: pre("挂衣"),
  rack: head("架", { tags: ["rack"] }),
  desk: head("书桌", { alias: ["办公桌"], tags: ["desk", "table"] }),
  drawer: post("带抽屉", { tags: ["drawer"] }),
  drawers: post("带抽屉", { tags: ["drawer"] }),
  dryer: head("烘干机", { alias: ["干衣机"], tags: ["dryer", "appliance", "laundry"] }),
  fan: head("风扇", { tags: ["fan"] }),
  hood: head("抽油烟机罩", { alias: ["油烟机"], tags: ["hood", "kitchen"] }),
  kitchen: pre("厨房", { tags: ["kitchen"] }),
  bar: head("吧台", { tags: ["bar"] }),
  blender: head("搅拌机", { alias: ["料理机"], tags: ["blender", "appliance"] }),
  coffee: pre("咖啡"),
  machine: head("机器"),
  fridge: head("冰箱", { alias: ["雪柜", "冰柜"], tags: ["fridge", "appliance"] }),
  microwave: head("微波炉", { tags: ["microwave", "appliance"] }),
  sink: head("水槽", { alias: ["洗手池"], tags: ["sink"] }),
  stove: head("炉灶", { alias: ["灶台"], tags: ["stove", "appliance"] }),
  electric: post("电磁", { tags: ["electric"] }),
  lamp: head("灯", { tags: ["lamp", "lighting"] }),
  laptop: head("笔记本电脑", { alias: ["手提电脑"], tags: ["laptop", "computer"] }),
  lounge: pre("休闲"),
  sofa: head("沙发", { alias: ["长沙发"], tags: ["sofa", "seating"] }),
  ottoman: head("脚凳", { alias: ["搁脚凳"], tags: ["ottoman", "seating"] }),
  pillow: head("抱枕", { alias: ["枕头", "靠垫"], tags: ["pillow"] }),
  plant: head("植物", { tags: ["plant"] }),
  potted: pre("盆栽"),
  radio: head("收音机", { tags: ["radio"] }),
  rug: head("地毯", { alias: ["毯子"], tags: ["rug", "carpet"] }),
  rectangle: post("长方形"),
  shower: head("淋浴间", { alias: ["淋浴房", "花洒"], tags: ["shower", "bathroom"] }),
  speaker: head("音箱", { alias: ["扬声器", "喇叭"], tags: ["speaker", "audio"] }),
  stool: head("凳子", { alias: ["凳"], tags: ["stool", "seating"] }),
  table: head("桌子", { alias: ["桌"], tags: ["table"] }),
  cloth: post("带桌布"),
  cross: post("交叉"),
  television: head("电视机", { alias: ["电视"], tags: ["television"] }),
  antenna: post("带天线", { tags: ["antenna"] }),
  toaster: head("烤面包机", { alias: ["多士炉"], tags: ["toaster", "appliance"] }),
  toilet: head("马桶", { alias: ["坐便器"], tags: ["toilet", "bathroom"] }),
  trashcan: head("垃圾桶", { alias: ["垃圾箱"], tags: ["trashcan"] }),
  washer: head("洗衣机", { tags: ["washer", "appliance", "laundry"] }),
  keyboard: head("键盘", { tags: ["keyboard"] }),
  mouse: head("鼠标", { tags: ["mouse"] }),
  screen: head("显示器", { alias: ["屏幕"], tags: ["screen", "monitor"] }),
  slide: post("推拉"),

  // --- guns -------------------------------------------------------------------
  assault: pre("突击"),
  rifle: head("步枪", { tags: ["rifle"] }),
  bayonet: head("刺刀", { tags: ["bayonet", "blade"] }),
  bipod: head("两脚架", { tags: ["bipod", "attachment"] }),
  bullpup: head("无托步枪", { alias: ["犊牛式步枪"], tags: ["bullpup", "rifle"] }),
  flashlight: head("战术手电筒", { alias: ["手电筒"], tags: ["flashlight", "attachment"] }),
  grip: head("握把", { alias: ["前握把"], tags: ["grip", "attachment"] }),
  pistol: head("手枪", { tags: ["pistol", "handgun"] }),
  revolver: head("左轮手枪", { alias: ["转轮手枪"], tags: ["revolver", "handgun"] }),
  scope: head("瞄准镜", { alias: ["光学瞄具"], tags: ["scope", "attachment"] }),
  shotgun: head("霰弹枪", { alias: ["散弹枪"], tags: ["shotgun"] }),
  silencer: head("消音器", { alias: ["消声器", "抑制器"], tags: ["silencer", "attachment"] }),
  sniper: pre("狙击"),
  stock: head("枪托", { tags: ["stock", "attachment"] }),
  submachine: pre("冲锋"),
  gun: head("枪", { tags: ["gun"] }),
  tripod: head("三脚架", { tags: ["tripod", "attachment"] }),

  // --- blaster kit (weapons) -----------------------------------------------
  blaster: head("爆能枪", { alias: ["镭射枪", "激光枪"], tags: ["blaster", "sci-fi"] }),
  bullet: head("子弹", { tags: ["bullet", "ammo"] }),
  tip: post("尖头"),
  clip: head("弹匣", { alias: ["弹夹"], tags: ["magazine", "ammo"] }),
  grenade: head("手雷", { alias: ["手榴弹"], tags: ["grenade", "explosive"] }),
  smoke: head("烟雾", { tags: ["smoke", "effect"] }),
  target: head("靶子", { alias: ["标靶"], tags: ["target"] }),
  fragment: head("碎片", { tags: ["fragment"] }),

  // --- vehicles ---------------------------------------------------------------
  ambulance: head("救护车", { alias: ["急救车"], tags: ["ambulance", "emergency"] }),
  cone: head("交通锥", { alias: ["雪糕筒", "路锥"], tags: ["cone", "traffic"] }),
  debris: marker({ alt: "残骸", tags: ["debris", "wreckage"] }),
  bolt: head("螺栓", { tags: ["bolt", "part"] }),
  bumper: head("保险杠", { tags: ["bumper", "part"] }),
  drivetrain: head("传动系统", { tags: ["drivetrain", "part"] }),
  axle: post("带车轴", { tags: ["axle"] }),
  nut: head("螺母", { tags: ["nut", "part"] }),
  spoiler: head("尾翼", { alias: ["扰流板"], tags: ["spoiler", "part"] }),
  tire: head("轮胎", { tags: ["tire", "wheel", "part"] }),
  delivery: head("送货车", { alias: ["快递车"], tags: ["delivery", "truck"] }),
  firetruck: head("消防车", { tags: ["firetruck", "emergency"] }),
  garbage: pre("垃圾"),
  truck: head("卡车", { alias: ["货车"], tags: ["truck"] }),
  hatchback: head("掀背车", { alias: ["两厢车"], tags: ["hatchback"] }),
  sports: pre("运动", { tags: ["sports"] }),
  kart: head("卡丁车", { tags: ["kart", "racing"] }),
  oobi: designation("Oobi"),
  oodi: designation("Oodi"),
  ooli: designation("Ooli"),
  oopi: designation("Oopi"),
  oozi: designation("Oozi"),
  police: head("警车", { alias: ["警察巡逻车"], tags: ["police", "emergency"] }),
  cop: head("警车", { alias: ["警察巡逻车"], tags: ["police", "emergency"] }),
  race: head("赛车", { tags: ["racing"] }),
  racing: pre("赛车", { tags: ["racing"] }),
  sedan: head("轿车", { alias: ["三厢车"], tags: ["sedan"] }),
  suv: head("SUV 越野车", { alias: ["越野车", "运动型多用途车"], tags: ["suv"] }),
  taxi: head("出租车", { alias: ["的士", "计程车"], tags: ["taxi"] }),
  tractor: head("拖拉机", { tags: ["tractor", "farm"] }),
  shovel: head("铁锹", { alias: ["铲子"], tags: ["shovel", "tool"] }),
  van: head("厢式货车", { alias: ["面包车"], tags: ["van"] }),
  wheel: head("车轮", { alias: ["轮子"], tags: ["wheel"] }),
  car: head("轿车", { alias: ["汽车"], tags: ["car"] }),

  // --- tanks / trains / spaceships -------------------------------------------
  tank: head("坦克", { alias: ["主战坦克"], tags: ["tank", "armored"] }),
  train: head("列车", { alias: ["火车"], tags: ["train"] }),
  locomotive: pre("蒸汽机车", { tags: ["locomotive", "steam"] }),
  tender: head("煤水车", { tags: ["tender"] }),
  railway: pre("铁路"),
  track: head("轨道", { tags: ["track", "rail"] }),
  curve: post("弯道"),
  speed: head("速度"),
  bob: designation("Bob"),
  challenger: designation("Challenger"),
  dispatcher: designation("Dispatcher"),
  executioner: designation("Executioner"),
  imperial: designation("Imperial"),
  insurgent: designation("Insurgent"),
  omen: designation("Omen"),
  pancake: designation("Pancake"),
  spitfire: designation("Spitfire"),
  striker: designation("Striker"),
  zenith: designation("Zenith"),

  // --- nature ------------------------------------------------------------------
  bamboo: head("竹子", { tags: ["bamboo"] }),
  bank: post("堤岸"),
  beach: pre("沙滩", { tags: ["beach"] }),
  bend: post("弯道"),
  berries: pre("浆果", { tags: ["berry"] }),
  birch: pre("白桦", { tags: ["birch"] }),
  block: head("块", { tags: ["block"] }),
  blocks: pre("方块"),
  bridge: head("桥", { alias: ["桥梁"], tags: ["bridge"] }),
  bush: head("灌木", { alias: ["灌木丛"], tags: ["bush", "shrub"] }),
  cactus: head("仙人掌", { tags: ["cactus", "desert"] }),
  campfire: head("篝火", { alias: ["营火"], tags: ["campfire", "camp", "fire"] }),
  carrot: head("胡萝卜", { tags: ["carrot", "crop", "vegetable"] }),
  cave: post("洞穴", { tags: ["cave"] }),
  character: pre("角色"),
  archer: head("弓箭手", { tags: ["archer", "character"] }),
  circle: post("圆片"),
  cliff: head("悬崖", { alias: ["崖壁"], tags: ["cliff", "terrain"] }),
  corn: head("玉米", { tags: ["corn", "crop"] }),
  crop: pre("作物", { tags: ["crop"] }),
  crops: pre("作物", { tags: ["crop"] }),
  end: post("末端"),
  flag: head("旗帜", { alias: ["旗"], tags: ["flag"] }),
  flower: head("花", { alias: ["花朵"], tags: ["flower"] }),
  flowers: head("花丛", { alias: ["花朵"], tags: ["flower"] }),
  foliage: post("带植被", { tags: ["foliage"] }),
  grass: head("草丛", { alias: ["草"], tags: ["grass"] }),
  ground: head("地面", { tags: ["ground", "terrain"] }),
  hanging: pre("垂挂"),
  ladder: head("梯子", { alias: ["爬梯"], tags: ["ladder"] }),
  leafs: head("叶片", { tags: ["leaf"] }),
  lily: head("睡莲", { alias: ["莲花"], tags: ["lily", "aquatic"] }),
  lilypad: head("睡莲叶", { alias: ["荷叶"], tags: ["lily", "aquatic"] }),
  melon: head("西瓜", { alias: ["甜瓜"], tags: ["melon", "crop"] }),
  mushroom: head("蘑菇", { tags: ["mushroom", "fungus"] }),
  oak: head("橡树", { tags: ["oak"] }),
  obelisk: head("方尖碑", { tags: ["obelisk", "monument"] }),
  old: pre("老"),
  palm: head("棕榈树", { alias: ["椰子树"], tags: ["palm", "tropical"] }),
  patch: head("地块", { tags: ["patch", "terrain"] }),
  path: head("小径", { alias: ["小路"], tags: ["path"] }),
  pennant: post("三角旗"),
  pine: head("松树", { alias: ["松"], tags: ["pine", "conifer"] }),
  planks: post("木板", { tags: ["plank", "wood"] }),
  plateau: pre("平顶"),
  pot: head("陶罐", { alias: ["罐子", "花盆"], tags: ["pot"] }),
  pumpkin: head("南瓜", { tags: ["pumpkin", "crop"] }),
  quarter: post("四分之一"),
  ramp: head("坡道", { tags: ["ramp"] }),
  ring: head("圆环", { tags: ["ring"] }),
  river: head("河流", { tags: ["river", "water"] }),
  rocks: head("岩石群", { tags: ["rock", "terrain"] }),
  slope: post("斜坡", { tags: ["slope"] }),
  split: post("分岔"),
  stones: head("石堆", { alt: "石围", tags: ["stone"] }),
  stump: head("树桩", { alias: ["树墩"], tags: ["stump"] }),
  tent: head("帐篷", { tags: ["tent", "camp"] }),
  tree: head("树", { alias: ["树木"], tags: ["tree"] }),
  turnip: head("芜菁", { alias: ["大头菜"], tags: ["turnip", "crop"] }),
  waterfall: post("瀑布", { tags: ["waterfall", "water"] }),
  weapon: head("武器", { tags: ["weapon"] }),
  arrow: head("箭头", { tags: ["arrow"] }),
  bow: head("弓", { tags: ["bow"] }),
  willow: head("柳树", { alias: ["垂柳"], tags: ["willow"] }),

  // --- pirate ------------------------------------------------------------------
  bottle: head("瓶子", { alias: ["酒瓶", "朗姆酒瓶"], tags: ["bottle"] }),
  bottles: post("装酒瓶", { tags: ["bottle"] }),
  cannon: head("加农炮", { alias: ["大炮", "火炮"], tags: ["cannon", "artillery"] }),
  ball: head("炮弹", { tags: ["cannonball"] }),
  castle: pre("城堡", { tags: ["castle"] }),
  pirate: pre("海盗", { tags: ["pirate"] }),
  tool: pre("工具", { tags: ["tool"] }),
};

// ---------------------------------------------------------------------------
// Category-specific word overrides (win over WORDS).
// ---------------------------------------------------------------------------
const CATEGORY_WORDS = {
  buildings: {
    small: post("小型"),
    center: post("中间段"),
    double: post("双拼"),
    short: post("短款"),
    straight: pre("直"),
  },
  dungeon: {
    details: marker({ suffix: "装饰件", alt: "细节装饰", tags: ["greeble", "detail"] }),
    chest: head("储物箱", { alias: ["宝箱", "箱子"], tags: ["chest", "container"] }),
    small: pre("小型"),
    large: pre("大型"),
    long: pre("长"),
    tall: pre("高"),
    short: pre("矮"),
    slim: pre("细"),
    basic: pre("基础"),
    empty: post("空白"),
    side: post("边缘"),
    x: post("X 形"),
  },
  furniture: {
    corner: pre("转角"),
    round: post("圆角"),
    mirror: head("镜子", { alias: ["穿衣镜"], tags: ["mirror"] }),
    front: post("正面"),
    closed: post("封口"),
    open: post("敞开"),
    large: pre("大"),
    small: pre("小"),
    long: pre("长条"),
    full: pre("整块"),
    half: pre("半块"),
    single: post("单侧"),
    double: post("双开门"),
    low: post("矮款"),
    glass: pre("玻璃", { tags: ["glass"] }),
  },
  guns: {
    long: post("长款"),
    short: post("短款"),
  },
  weapons: {
    small: post("小型"),
    large: post("大型"),
    wide: post("宽型"),
  },
  medieval: {
    group: post("成片", { tags: ["group"] }),
    closed: post("关闭"),
    wall: head("城墙", { alias: ["围墙"], tags: ["wall", "fortification"] }),
    big: pre("大"),
  },
  medievalkit: {
    l: post("左"),
    r: post("右"),
    u: post("U 形"),
    base: post("带基座"),
    support: head("支撑架", { alias: ["支撑木架"], tags: ["support"] }),
    half: post("半幅"),
    long: post("长段"),
    short: post("短段"),
    straight: post("直段"),
    flat: post("平拱"),
    round: post("圆拱"),
    open: post("开启"),
    closed: post("关闭"),
    simple: post("简易"),
    single: post("单段"),
    thin: post("窄款"),
    wide: post("宽款"),
    big: post("大"),
    small: post("小"),
    interior: pre("室内"),
  },
  nature: {
    small: pre("小"),
    large: pre("大"),
    tall: pre("高"),
    short: pre("矮"),
    flat: pre("扁平"),
    square: pre("方形"),
    high: pre("高"),
    low: pre("矮"),
    half: post("半高"),
    open: post("开放"),
    closed: post("封闭"),
    single: post("单块"),
    double: post("双层"),
    ground: post("枝叶垂地"),
    top: post("顶部"),
    cross: post("十字"),
    tile: post("整块"),
    rocks: head("岩石群", { alt: "带岩石", tags: ["rock", "terrain"] }),
    sign: head("指示牌", { alias: ["路牌", "木牌"], tags: ["sign"] }),
    target: head("箭靶", { alias: ["靶子", "标靶"], tags: ["target", "archery"] }),
    bricks: post("砖围", { tags: ["brick"] }),
    group: post("成丛", { tags: ["group"] }),
  },
  pirate: {
    large: pre("大型"),
    medium: pre("中型"),
    small: pre("小型"),
    ship: head("帆船", { alias: ["船"], tags: ["ship"] }),
    high: pre("高杆"),
    bend: post("弯干"),
    straight: post("笔直"),
    sides: post("带侧板"),
    door: post("带门", { tags: ["door"] }),
    windows: post("带窗", { tags: ["window"] }),
    rocks: head("礁石", { alias: ["岩石群"], tags: ["rock", "reef"] }),
    grass: head("草丛", { alias: ["草"], tags: ["grass"] }),
    detailed: post("精细", { tags: ["detailed"] }),
  },
  trains: {
    straight: post("直道"),
    front: head("车头", { tags: ["locomotive-front"] }),
    wagon: head("车厢", { tags: ["wagon", "carriage"] }),
    container: head("集装箱车厢", { alias: ["集装箱"], tags: ["container"] }),
    empty: post("空载"),
    open: pre("敞口"),
  },
  trees: {
    short: pre("矮"),
    small: pre("小"),
  },
  vehicles: {
    front: post("前"),
    back: post("后"),
    flat: post("平板"),
    door: head("车门", { tags: ["door", "part"] }),
    police: head("警车", { alias: ["警察巡逻车"], tags: ["police", "emergency"] }),
  },
  houses: {
    large: post("大型"),
    small: post("小型"),
    big: post("大型"),
  },
};

// ---------------------------------------------------------------------------
// Phrases: contiguous token sequences translated as one chunk (longest match
// wins). Category phrases are tried before global phrases.
// ---------------------------------------------------------------------------
const phrase = (seq, zh, role = "head", extra = {}) => ({ seq: seq.split(" "), zh, role, ...extra });

const PHRASES = [
  // building storeys
  phrase("1 story", "单层楼房", "head", { alias: ["一层楼房", "一层商铺"], tags: ["storefront"] }),
  phrase("2 story", "两层楼房", "head", { alias: ["二层楼房"], tags: ["storefront"] }),
  phrase("3 story", "三层楼房", "head", { tags: ["storefront"] }),
  phrase("4 story", "四层楼房", "head", { tags: ["storefront"] }),
  phrase("6 story", "六层楼房", "head", { tags: ["storefront"] }),
  phrase("2 doors", "双门", "post"),
  phrase("gable roof", "人字顶", "post", { tags: ["gable-roof"] }),
  phrase("round roof", "圆弧顶", "post", { tags: ["round-roof"] }),
  phrase("door window", "门窗组合", "head", { tags: ["door", "window"] }),
  phrase("window double roof", "双联屋顶窗", "head", { tags: ["window", "roof"] }),
  phrase("window double", "双联窗", "head", { tags: ["window"] }),
  phrase("window roof", "屋顶窗", "head", { alias: ["天窗"], tags: ["window", "roof"] }),
  phrase("stairs roof", "屋顶楼梯间", "head", { tags: ["stairs", "roof"] }),
  phrase("pipe l", "L 形管道", "head", { tags: ["pipe"] }),
  phrase("sign bakery", "面包店招牌", "head", { tags: ["sign", "bakery", "shop"] }),
  phrase("sign barbershop", "理发店招牌", "head", { tags: ["sign", "barbershop", "shop"] }),
  phrase("sign bookshop", "书店招牌", "head", { tags: ["sign", "bookshop", "shop"] }),
  phrase("sign hardware", "五金店招牌", "head", { tags: ["sign", "shop"] }),
  phrase("sign pharmacy", "药店招牌", "head", { tags: ["sign", "pharmacy", "shop"] }),
  phrase("casino sign", "赌场招牌", "head", { tags: ["sign", "casino"] }),

  // animals
  phrase("betta fish", "斗鱼", "head", { alias: ["泰国斗鱼", "暹罗斗鱼"], tags: ["fish", "aquatic", "pet"] }),
  phrase("brown bear", "棕熊", "head", { alias: ["熊", "灰熊"], tags: ["bear", "wildlife", "predator"] }),
  phrase("mallard duck", "绿头鸭", "head", { alias: ["野鸭", "鸭子"], tags: ["duck", "bird", "waterfowl"] }),

  // watercraft
  phrase("cruise ship", "游轮", "head", { alias: ["邮轮", "豪华游轮"], tags: ["cruise", "ship"] }),
  phrase("sail ship", "帆船", "head", { alias: ["帆船军舰"], tags: ["sailboat", "ship"] }),
  phrase("viking boat", "维京战船", "head", { alias: ["维京长船", "龙头船"], tags: ["viking", "ship"] }),
  phrase("boat row", "划艇", "head", { alias: ["划船", "小艇"], tags: ["rowboat"] }),

  // guns
  phrase("assault rifle", "突击步枪", "head", { alias: ["自动步枪"], tags: ["rifle", "assault-rifle"] }),
  phrase("sniper rifle", "狙击步枪", "head", { alias: ["狙击枪"], tags: ["rifle", "sniper"] }),
  phrase("submachine gun", "冲锋枪", "head", { tags: ["smg"] }),
  phrase("shotgun sawed off", "锯短霰弹枪", "head", { alias: ["锯短散弹枪"], tags: ["shotgun", "sawed-off"] }),
  phrase("shotgun short stock", "短托霰弹枪", "head", { tags: ["shotgun"] }),

  // blaster kit
  phrase("bullet foam", "泡沫子弹", "head", { alias: ["软弹"], tags: ["bullet", "ammo", "foam", "toy"] }),

  // vehicles
  phrase("normal car", "家用轿车", "head", { alias: ["普通轿车"], tags: ["sedan"] }),
  phrase("sports car", "跑车", "head", { alias: ["运动轿车"], tags: ["sports-car"] }),
  phrase("garbage truck", "垃圾车", "head", { alias: ["环卫车"], tags: ["garbage-truck", "truck"] }),
  phrase("delivery flat", "平板送货车", "head", { tags: ["delivery", "flatbed"] }),
  phrase("truck flat", "平板卡车", "head", { alias: ["平板货车"], tags: ["truck", "flatbed"] }),
  phrase("cone flat", "交通锥（压扁）", "head", { alias: ["压扁路锥"], tags: ["cone", "traffic"] }),
  phrase("race future", "未来赛车", "head", { alias: ["科幻赛车"], tags: ["racing", "futuristic"] }),
  phrase("sedan sports", "运动轿车", "head", { tags: ["sedan", "sports-car"] }),
  phrase("hatchback sports", "运动掀背车", "head", { tags: ["hatchback", "sports-car"] }),
  phrase("suv luxury", "豪华 SUV", "head", { alias: ["豪华越野车"], tags: ["suv", "luxury"] }),
  phrase("tractor police", "警用拖拉机", "head", { tags: ["tractor", "police"] }),
  phrase("tractor shovel", "铲斗拖拉机", "head", { alias: ["装载机"], tags: ["tractor", "loader"] }),
  phrase("wheel default", "车轮（标准）", "head", { tags: ["wheel"] }),
  phrase("wheel racing", "赛车车轮", "head", { tags: ["wheel", "racing"] }),
  phrase("wheel truck", "卡车车轮", "head", { tags: ["wheel", "truck"] }),
  phrase("wheel tractor", "拖拉机车轮", "head", { tags: ["wheel", "tractor"] }),

  // trains
  phrase("cargo train", "货运列车", "pre", { alias: ["货车列车"], tags: ["cargo", "freight"] }),
  phrase("coal container", "运煤车厢", "head", { alias: ["煤斗车"], tags: ["coal", "wagon"] }),
  phrase("high speed", "高速列车", "pre", { alias: ["高铁", "动车"], tags: ["high-speed"] }),
  phrase("coal tender", "煤水车", "head", { tags: ["tender", "coal"] }),
  phrase("railway track", "铁轨", "head", { alias: ["铁路轨道", "轨道"], tags: ["track", "rail"] }),

  // medieval
  phrase("first age", "第一时代", "post", { tags: ["age-1"] }),
  phrase("second age", "第二时代", "post", { tags: ["age-2"] }),
  phrase("level 1", "1 级", "post", { tags: ["level-1"] }),
  phrase("level 2", "2 级", "post", { tags: ["level-2"] }),
  phrase("level 3", "3 级", "post", { tags: ["level-3"] }),
  phrase("leve 3", "3 级", "post", { tags: ["level-3"] }),
  phrase("town center", "城镇中心", "head", { alias: ["主城", "市政厅"], tags: ["town-center"] }),
  phrase("watch tower", "瞭望塔", "head", { alias: ["哨塔", "了望塔"], tags: ["watchtower", "tower"] }),
  phrase("tower house", "塔楼住宅", "head", { tags: ["tower", "house"] }),
  phrase("wall towers door", "城墙塔门段", "head", { alias: ["城门"], tags: ["wall", "gate", "fortification"] }),
  phrase("wall towers", "城墙塔楼段", "head", { tags: ["wall", "tower", "fortification"] }),
  phrase("wonder walls", "奇观围墙", "head", { tags: ["wonder", "wall"] }),
  phrase("farm dirt", "农田泥地", "head", { tags: ["farm", "dirt"] }),
  phrase("mountain group", "群山", "head", { tags: ["mountain", "terrain"] }),
  phrase("mountain large single", "大型独立山峰", "head", { tags: ["mountain", "terrain"] }),
  phrase("mountain single", "独立山峰", "head", { tags: ["mountain", "terrain"] }),
  phrase("resource gold", "金矿", "head", { alias: ["黄金资源", "金块"], tags: ["gold", "resource"] }),
  phrase("resource rock", "石料堆", "head", { alias: ["石头资源"], tags: ["rock", "resource"] }),
  phrase("resource pine tree", "资源松树", "head", { alias: ["松树资源"], tags: ["pine", "tree", "resource"] }),
  phrase("resource tree", "资源树", "head", { alias: ["树木资源"], tags: ["tree", "resource"] }),
  phrase("crate big stack", "大板条箱堆", "head", { tags: ["crate", "container"] }),
  phrase("crate stack", "板条箱堆", "head", { tags: ["crate", "container"] }),
  phrase("rock group", "岩石群", "head", { tags: ["rock", "terrain"] }),

  // dungeon sci-fi kit
  phrase("door double long wall", "双开门长墙", "head", { tags: ["door", "wall"] }),
  phrase("door double wall", "双开门墙", "head", { tags: ["door", "wall"] }),
  phrase("door double", "双开门", "head", { tags: ["door"] }),
  phrase("door single long wall", "单开门长墙", "head", { tags: ["door", "wall"] }),
  phrase("door single wall", "单开门墙", "head", { tags: ["door", "wall"] }),
  phrase("door single", "单开门", "head", { tags: ["door"] }),
  phrase("side a", "A 面", "post"),
  phrase("side b", "B 面", "post"),
  phrase("long window wall", "长窗墙", "head", { tags: ["window", "wall"] }),
  phrase("small windows wall", "小窗墙", "head", { tags: ["window", "wall"] }),
  phrase("three windows wall", "三窗墙", "head", { tags: ["window", "wall"] }),
  phrase("window wall", "窗墙", "head", { tags: ["window", "wall"] }),
  phrase("floor tile", "地板块", "head", { tags: ["floor", "tile"] }),
  phrase("roof tile", "屋顶板", "head", { tags: ["roof", "tile"] }),
  phrase("double hallway", "双走廊", "post"),
  phrase("inner corner", "内转角", "post"),
  phrase("corner inner", "内转角", "post"),
  phrase("corner pipes", "转角管道", "post", { tags: ["pipe"] }),
  phrase("sides pipes", "侧边管道", "post", { tags: ["pipe"] }),
  phrase("small vents", "小通风口", "post", { tags: ["vent"] }),
  phrase("orange vent", "橙色通风口", "post", { tags: ["vent"] }),

  // furniture
  phrase("bathroom mirror", "浴室镜", "head", { alias: ["镜子", "浴室镜子"], tags: ["mirror", "bathroom"] }),
  phrase("bathroom sink", "浴室洗手池", "head", { alias: ["洗手池", "洗脸池"], tags: ["sink", "bathroom"] }),
  phrase("bed bunk", "双层床", "head", { alias: ["上下铺"], tags: ["bed", "bunk-bed"] }),
  phrase("bed double", "双人床", "head", { tags: ["bed", "double-bed"] }),
  phrase("bed single", "单人床", "head", { tags: ["bed", "single-bed"] }),
  phrase("bookcase closed", "封闭式书柜", "head", { alias: ["书柜"], tags: ["bookcase", "storage"] }),
  phrase("bookcase open", "开放式书柜", "head", { alias: ["书架"], tags: ["bookcase", "storage"] }),
  phrase("cabinet bed", "床头柜", "head", { alias: ["床边柜"], tags: ["nightstand", "cabinet", "bedroom"] }),
  phrase("cabinet television", "电视柜", "head", { tags: ["tv-stand", "cabinet"] }),
  phrase("cardboard box", "纸箱", "head", { alias: ["纸盒", "纸皮箱"], tags: ["box", "cardboard"] }),
  phrase("ceiling fan", "吊扇", "head", { tags: ["fan", "ceiling"] }),
  phrase("chair desk", "办公椅", "head", { alias: ["书桌椅", "转椅"], tags: ["chair", "seating", "office"] }),
  phrase("chair rounded", "圆背椅", "head", { tags: ["chair", "seating"] }),
  phrase("chair modern frame cushion", "现代软垫椅（框架式）", "head", { tags: ["chair", "seating", "modern"] }),
  phrase("chair modern cushion", "现代软垫椅", "head", { tags: ["chair", "seating", "modern"] }),
  phrase("chair cushion", "软垫椅", "head", { tags: ["chair", "seating", "cushion"] }),
  phrase("coat rack", "挂衣架", "head", { alias: ["衣帽架"], tags: ["coat-rack"] }),
  phrase("computer keyboard", "键盘", "head", { alias: ["电脑键盘"], tags: ["keyboard", "computer"] }),
  phrase("computer mouse", "鼠标", "head", { alias: ["电脑鼠标"], tags: ["mouse", "computer"] }),
  phrase("computer screen", "电脑显示器", "head", { alias: ["显示器", "屏幕"], tags: ["monitor", "computer"] }),
  phrase("corner round", "圆转角", "post"),
  phrase("built in", "嵌入式", "post"),
  phrase("coffee machine", "咖啡机", "head", { tags: ["coffee-machine", "appliance"] }),
  phrase("kitchen cabinet upper", "厨房吊柜", "head", { alias: ["吊柜"], tags: ["cabinet", "kitchen"] }),
  phrase("kitchen cabinet", "橱柜", "head", { alias: ["厨柜"], tags: ["cabinet", "kitchen"] }),
  phrase("kitchen fridge", "冰箱", "head", { alias: ["雪柜", "冰柜"], tags: ["fridge", "appliance", "kitchen"] }),
  phrase("kitchen microwave", "微波炉", "head", { tags: ["microwave", "appliance", "kitchen"] }),
  phrase("kitchen blender", "搅拌机", "head", { alias: ["料理机"], tags: ["blender", "appliance", "kitchen"] }),
  phrase("kitchen stove", "炉灶", "head", { alias: ["灶台"], tags: ["stove", "appliance", "kitchen"] }),
  phrase("upper double", "双开门", "post"),
  phrase("lamp round floor", "圆形落地灯", "head", { alias: ["落地灯"], tags: ["lamp", "lighting", "floor-lamp"] }),
  phrase("lamp round table", "圆形台灯", "head", { alias: ["台灯"], tags: ["lamp", "lighting", "table-lamp"] }),
  phrase("lamp square ceiling", "方形吸顶灯", "head", { alias: ["吸顶灯"], tags: ["lamp", "lighting", "ceiling-lamp"] }),
  phrase("lamp square floor", "方形落地灯", "head", { alias: ["落地灯"], tags: ["lamp", "lighting", "floor-lamp"] }),
  phrase("lamp square table", "方形台灯", "head", { alias: ["台灯"], tags: ["lamp", "lighting", "table-lamp"] }),
  phrase("lamp wall", "壁灯", "head", { tags: ["lamp", "lighting", "wall-lamp"] }),
  phrase("lounge chair relax", "休闲躺椅", "head", { alias: ["躺椅"], tags: ["chair", "seating", "lounge"] }),
  phrase("lounge chair", "休闲椅", "head", { tags: ["chair", "seating", "lounge"] }),
  phrase("lounge sofa ottoman", "沙发脚凳", "head", { alias: ["脚凳"], tags: ["ottoman", "seating"] }),
  phrase("lounge sofa long", "长沙发", "head", { alias: ["三人沙发"], tags: ["sofa", "seating"] }),
  phrase("lounge sofa", "沙发", "head", { alias: ["长沙发"], tags: ["sofa", "seating"] }),
  phrase("lounge design", "设计师", "pre", { tags: ["designer"] }),
  phrase("plant small", "小型盆栽", "head", { alias: ["小盆栽", "绿植"], tags: ["plant", "potted-plant"] }),
  phrase("potted plant", "盆栽植物", "head", { alias: ["盆栽", "绿植"], tags: ["plant", "potted-plant"] }),
  phrase("rug doormat", "门垫", "head", { alias: ["脚垫", "地垫"], tags: ["rug", "doormat"] }),
  phrase("rug rectangle", "长方形地毯", "head", { tags: ["rug", "carpet"] }),
  phrase("rug round", "圆形地毯", "head", { tags: ["rug", "carpet"] }),
  phrase("rug rounded", "圆角地毯", "head", { tags: ["rug", "carpet"] }),
  phrase("rug square", "方形地毯", "head", { tags: ["rug", "carpet"] }),
  phrase("shower round", "圆形淋浴间", "head", { tags: ["shower", "bathroom"] }),
  phrase("side table", "边桌", "head", { alias: ["边几", "床头桌"], tags: ["side-table", "table"] }),
  phrase("stairs open", "开放式楼梯", "head", { tags: ["stairs"] }),
  phrase("stool bar", "吧台凳", "head", { alias: ["吧凳", "高脚凳"], tags: ["stool", "seating", "bar"] }),
  phrase("table coffee", "茶几", "head", { alias: ["咖啡桌"], tags: ["coffee-table", "table"] }),
  phrase("table cross", "交叉腿桌", "head", { tags: ["table"] }),
  phrase("table glass", "玻璃桌", "head", { tags: ["table", "glass"] }),
  phrase("table round", "圆桌", "head", { tags: ["table"] }),
  phrase("television antenna", "电视天线", "head", { alias: ["天线"], tags: ["antenna", "television"] }),
  phrase("washer dryer stacked", "洗衣烘干叠放机", "head", { alias: ["洗烘一体机"], tags: ["washer", "dryer", "laundry"] }),
  phrase("wall doorway", "门洞墙", "head", { tags: ["wall", "doorway"] }),
  phrase("wall half", "半高墙", "head", { tags: ["wall"] }),
  phrase("wall window", "窗墙", "head", { tags: ["wall", "window"] }),
  phrase("kitchen bar", "厨房吧台", "head", { alias: ["吧台", "早餐台"], tags: ["bar", "kitchen"] }),

  // nature
  phrase("campfire logs", "篝火（原木）", "head", { alias: ["营火"], tags: ["campfire", "camp", "fire"] }),
  phrase("campfire bricks", "篝火（砖围）", "head", { alias: ["营火"], tags: ["campfire", "camp", "fire"] }),
  phrase("campfire planks", "篝火（木板）", "head", { alias: ["营火"], tags: ["campfire", "camp", "fire"] }),
  phrase("campfire stones", "篝火（石围）", "head", { alias: ["营火"], tags: ["campfire", "camp", "fire"] }),
  phrase("character archer", "弓箭手角色", "head", { alias: ["弓箭手", "射手"], tags: ["archer", "character"] }),
  phrase("cliff block", "悬崖块", "head", { tags: ["cliff", "terrain", "block"] }),
  phrase("half walls", "半侧壁", "post"),
  phrase("crop carrot", "胡萝卜", "head", { alias: ["田间胡萝卜"], tags: ["carrot", "crop", "vegetable"] }),
  phrase("crop melon", "西瓜", "head", { alias: ["甜瓜"], tags: ["melon", "crop"] }),
  phrase("crop pumpkin", "南瓜", "head", { tags: ["pumpkin", "crop"] }),
  phrase("crop turnip", "芜菁", "head", { alias: ["大头菜"], tags: ["turnip", "crop"] }),
  phrase("crops bamboo", "竹丛", "head", { alias: ["竹子"], tags: ["bamboo", "crop"] }),
  phrase("crops corn", "玉米作物", "head", { alias: ["玉米"], tags: ["corn", "crop"] }),
  phrase("crops leafs", "叶菜作物", "head", { alias: ["青菜"], tags: ["crop", "vegetable"] }),
  phrase("crops wheat", "小麦作物", "head", { alias: ["麦田"], tags: ["wheat", "crop"] }),
  phrase("crops dirt", "田垄泥地", "head", { alias: ["菜地", "田地"], tags: ["dirt", "farm", "crop"] }),
  phrase("double row", "双行", "post"),
  phrase("stage a", "生长期 A", "post"),
  phrase("stage b", "生长期 B", "post"),
  phrase("stage c", "生长期 C", "post"),
  phrase("stage d", "生长期 D", "post"),
  phrase("fence bend", "弯折栅栏", "head", { tags: ["fence"] }),
  phrase("fence gate", "栅栏门", "head", { alias: ["围栏门"], tags: ["fence", "gate"] }),
  phrase("fence planks", "木板栅栏", "head", { tags: ["fence", "plank"] }),
  phrase("fence simple", "简易栅栏", "head", { tags: ["fence"] }),
  phrase("simple diagonal", "斜撑", "post"),
  phrase("ground grass", "草地地块", "head", { tags: ["grass", "ground", "terrain"] }),
  phrase("ground path", "土路地块", "head", { alias: ["小路", "土路"], tags: ["path", "ground", "terrain"] }),
  phrase("ground river", "河流地块", "head", { alias: ["河道"], tags: ["river", "water", "terrain"] }),
  phrase("bend bank", "弯道堤岸", "post"),
  phrase("end closed", "封闭末端", "post"),
  phrase("side open", "开放边缘", "post"),
  phrase("grass leafs", "阔叶草丛", "head", { tags: ["grass"] }),
  phrase("hanging moss", "垂挂苔藓", "head", { alias: ["苔藓"], tags: ["moss"] }),
  phrase("log stack", "原木堆", "head", { tags: ["log", "wood"] }),
  phrase("mushroom red", "红蘑菇", "head", { alias: ["红菇"], tags: ["mushroom", "fungus"] }),
  phrase("mushroom tan", "褐蘑菇", "head", { alias: ["棕蘑菇"], tags: ["mushroom", "fungus"] }),
  phrase("patch dirt", "泥土地块", "head", { alias: ["泥地"], tags: ["dirt", "patch", "terrain"] }),
  phrase("patch grass", "草皮地块", "head", { alias: ["草地", "草皮"], tags: ["grass", "patch", "terrain"] }),
  phrase("patch sand", "沙地地块", "head", { alias: ["沙地", "沙滩"], tags: ["sand", "patch", "terrain"] }),
  phrase("path stone", "石板小径", "head", { alias: ["石头小路"], tags: ["path", "stone"] }),
  phrase("path wood", "木板小径", "head", { alias: ["木头小路"], tags: ["path", "wood"] }),
  phrase("plant bush", "灌木", "head", { alias: ["灌木丛"], tags: ["bush", "shrub", "plant"] }),
  phrase("large triangle", "大三角形", "post"),
  phrase("platform beach", "沙滩平台", "head", { tags: ["platform", "beach"] }),
  phrase("platform grass", "草地平台", "head", { tags: ["platform", "grass"] }),
  phrase("platform stone", "石砌平台", "head", { tags: ["platform", "stone"] }),
  phrase("rocks high", "高岩石群", "head", { tags: ["rock", "terrain"] }),
  phrase("rocks low", "矮岩石群", "head", { tags: ["rock", "terrain"] }),
  phrase("rocks ramp", "岩石坡道", "head", { tags: ["rock", "ramp", "terrain"] }),
  phrase("statue block", "石雕方块", "head", { alias: ["雕像基块"], tags: ["statue", "ruin"] }),
  phrase("statue column", "雕像石柱", "head", { alias: ["石柱"], tags: ["statue", "column", "ruin"] }),
  phrase("statue head", "石雕头像", "head", { alias: ["雕像头"], tags: ["statue", "ruin"] }),
  phrase("statue obelisk", "方尖碑", "head", { alias: ["石碑"], tags: ["obelisk", "statue", "ruin"] }),
  phrase("statue ring", "石雕圆环", "head", { alias: ["石环"], tags: ["statue", "ring", "ruin"] }),
  phrase("tree blocks", "方块树", "head", { tags: ["tree", "stylized"] }),
  phrase("tree cone", "锥形树", "head", { tags: ["tree", "stylized"] }),
  phrase("tree default", "标准树", "head", { tags: ["tree"] }),
  phrase("tree detailed", "精细树", "head", { tags: ["tree", "detailed"] }),
  phrase("tree fat", "粗壮树", "head", { tags: ["tree"] }),
  phrase("tree high", "高冠树", "head", { tags: ["tree"] }),
  phrase("tree oak", "橡树", "head", { tags: ["tree", "oak"] }),
  phrase("tree palm bend", "弯干棕榈树", "head", { alias: ["椰子树"], tags: ["tree", "palm", "tropical"] }),
  phrase("tree palm", "棕榈树", "head", { alias: ["椰子树"], tags: ["tree", "palm", "tropical"] }),
  phrase("tree pine", "松树", "head", { alias: ["松"], tags: ["tree", "pine", "conifer"] }),
  phrase("tree plateau", "平顶树", "head", { tags: ["tree", "stylized"] }),
  phrase("tree simple", "简易树", "head", { tags: ["tree"] }),
  phrase("tree small", "小树", "head", { tags: ["tree"] }),
  phrase("tree tall", "高树", "head", { tags: ["tree"] }),
  phrase("tree thin", "细瘦树", "head", { tags: ["tree"] }),
  phrase("tree stump", "树桩", "head", { alias: ["树墩"], tags: ["stump"] }),
  phrase("weapon arrow", "箭矢", "head", { alias: ["箭"], tags: ["arrow", "archery"] }),
  phrase("weapon bow", "弓", "head", { alias: ["弓箭"], tags: ["bow", "archery"] }),
  phrase("wood log", "原木", "head", { alias: ["木头", "圆木"], tags: ["log", "wood"] }),
  phrase("bridge center stone round", "石拱桥中段", "head", { tags: ["bridge", "stone"] }),
  phrase("bridge center stone", "石桥中段", "head", { tags: ["bridge", "stone"] }),
  phrase("bridge center wood round", "木拱桥中段", "head", { tags: ["bridge", "wood"] }),
  phrase("bridge center wood", "木桥中段", "head", { tags: ["bridge", "wood"] }),
  phrase("bridge side stone round", "石拱桥边段", "head", { tags: ["bridge", "stone"] }),
  phrase("bridge side stone", "石桥边段", "head", { tags: ["bridge", "stone"] }),
  phrase("bridge side wood round", "木拱桥边段", "head", { tags: ["bridge", "wood"] }),
  phrase("bridge side wood", "木桥边段", "head", { tags: ["bridge", "wood"] }),
  phrase("bridge stone round", "石拱桥", "head", { tags: ["bridge", "stone"] }),
  phrase("bridge stone", "石桥", "head", { tags: ["bridge", "stone"] }),
  phrase("bridge wood round", "木拱桥", "head", { tags: ["bridge", "wood"] }),
  phrase("bridge wood", "木桥", "head", { tags: ["bridge", "wood"] }),
  phrase("cactus flower", "开花仙人掌", "head", { tags: ["cactus", "flower", "desert"] }),
  phrase("cactus flowers", "开花仙人掌", "head", { tags: ["cactus", "flower", "desert"] }),

  // trees pack
  phrase("birch tree", "白桦树", "head", { alias: ["桦树"], tags: ["tree", "birch"] }),
  phrase("common tree", "普通树", "head", { alias: ["阔叶树"], tags: ["tree"] }),
  phrase("palm tree", "棕榈树", "head", { alias: ["椰子树"], tags: ["tree", "palm", "tropical"] }),
  phrase("pine tree", "松树", "head", { alias: ["松"], tags: ["tree", "pine", "conifer"] }),
  phrase("bush berries", "浆果灌木", "head", { alias: ["果丛"], tags: ["bush", "berry"] }),
  phrase("dead snow", "枯死积雪", "post", { tags: ["dead", "snow", "winter"] }),

  // pirate
  phrase("cannon ball", "炮弹", "head", { alias: ["铁球"], tags: ["cannonball", "ammo"] }),
  phrase("castle door", "城堡门", "head", { alias: ["城门"], tags: ["castle", "door"] }),
  phrase("castle gate", "城堡大门", "head", { alias: ["城门"], tags: ["castle", "gate"] }),
  phrase("castle wall", "城堡围墙", "head", { alias: ["城墙"], tags: ["castle", "wall"] }),
  phrase("castle window", "城堡窗户", "head", { alias: ["城堡窗"], tags: ["castle", "window"] }),
  phrase("ship pirate", "海盗船", "head", { alias: ["海贼船"], tags: ["ship", "pirate-ship"] }),
  phrase("ship ghost", "幽灵船", "head", { alias: ["鬼船"], tags: ["ship", "ghost"] }),
  phrase("ship wreck", "沉船残骸", "head", { alias: ["沉船"], tags: ["ship", "wreck"] }),
  phrase("grass patch", "草皮块", "head", { alias: ["草地"], tags: ["grass", "patch"] }),
  phrase("grass plant", "草株", "head", { alias: ["草"], tags: ["grass", "plant"] }),
  phrase("structure fence", "木架围栏", "head", { tags: ["structure", "fence"] }),
  phrase("structure platform dock", "木架码头平台", "head", { alias: ["码头"], tags: ["structure", "platform", "dock"] }),
  phrase("structure platform", "木架平台", "head", { tags: ["structure", "platform"] }),
  phrase("structure roof", "木架顶棚", "head", { tags: ["structure", "roof"] }),
  phrase("platform planks", "木板平台", "head", { tags: ["platform", "plank"] }),
  phrase("tool paddle", "船桨", "head", { alias: ["桨"], tags: ["paddle", "tool"] }),
  phrase("tool shovel", "铁锹", "head", { alias: ["铲子"], tags: ["shovel", "tool"] }),
  phrase("tower base", "塔楼底段", "head", { tags: ["tower"] }),
  phrase("tower complete", "完整塔楼", "head", { tags: ["tower"] }),
  phrase("tower middle", "塔楼中段", "head", { tags: ["tower"] }),
  phrase("tower roof", "塔楼顶盖", "head", { tags: ["tower", "roof"] }),
  phrase("tower top", "塔楼顶段", "head", { tags: ["tower"] }),
  phrase("tower watch", "瞭望塔", "head", { alias: ["哨塔"], tags: ["tower", "watchtower"] }),

  // medievalkit
  phrase("balcony cross", "交叉纹阳台", "head", { tags: ["balcony"] }),
  phrase("balcony simple", "简约阳台", "head", { tags: ["balcony"] }),
  phrase("corner exterior", "外墙转角", "head", { tags: ["corner", "exterior"] }),
  phrase("corner interior", "内墙转角", "head", { tags: ["corner", "interior"] }),
  phrase("top down", "顶部下延", "post"),
  phrase("top only", "仅顶部", "post"),
  phrase("door frame", "门框", "head", { tags: ["door", "frame"] }),
  phrase("wood dark", "深色木面", "post", { tags: ["wood"] }),
  phrase("wood light", "浅色木面", "post", { tags: ["wood"] }),
  phrase("red brick", "红砖面", "post", { tags: ["brick"] }),
  phrase("uneven brick", "不规则砖面", "post", { tags: ["brick"] }),
  phrase("uneven bricks", "不规则砖面", "post", { tags: ["brick"] }),
  phrase("hole cover", "楼板洞口盖板", "head", { alias: ["洞口盖板"], tags: ["floor", "cover"] }),
  phrase("90 angle", "90°转角", "post"),
  phrase("90 half", "90°半盖", "post"),
  phrase("90 stairs", "90°楼梯口", "post"),
  phrase("straight half", "直段半盖", "post"),
  phrase("overhang corner", "悬挑转角", "post"),
  phrase("roof incline", "斜屋面", "post"),
  phrase("exterior border", "外部包边", "head", { tags: ["border", "exterior"] }),
  phrase("metal fence", "金属栅栏", "head", { alias: ["铁艺围栏"], tags: ["fence", "metal"] }),
  phrase("wooden fence", "木栅栏", "head", { alias: ["木围栏"], tags: ["fence", "wood"] }),
  phrase("roof front supports", "屋顶山墙支撑", "head", { tags: ["roof", "support"] }),
  phrase("roof front", "屋顶山墙面", "head", { tags: ["roof", "gable"] }),
  phrase("roof log", "屋脊原木", "head", { alias: ["木梁"], tags: ["roof", "log", "wood"] }),
  phrase("round tile", "圆瓦", "post", { tags: ["tile"] }),
  phrase("round tiles", "圆瓦", "post", { tags: ["tile"] }),
  phrase("roof tower", "塔楼锥顶", "head", { tags: ["roof", "tower"] }),
  phrase("roof support", "屋顶支撑", "head", { tags: ["roof", "support"] }),
  phrase("roof wooden", "木屋顶", "head", { tags: ["roof", "wood"] }),
  phrase("roof modular", "模块化屋顶", "head", { tags: ["roof", "modular"] }),
  phrase("stair interior", "室内楼梯", "head", { tags: ["stairs", "interior"] }),
  phrase("stairs exterior", "室外楼梯", "head", { tags: ["stairs", "exterior"] }),
  phrase("platform 45", "45°平台", "post"),
  phrase("sides 45", "双侧 45°", "post"),
  phrase("platform u", "U 形平台", "post"),
  phrase("sides u", "双侧 U 形", "post"),
  phrase("side platform", "侧接平台", "post"),
  phrase("single side", "单侧", "post"),
  phrase("no first step", "无首级台阶", "post"),
  phrase("straight center", "直跑中段", "post"),
  phrase("wall arch", "拱形墙", "head", { alias: ["拱券"], tags: ["wall", "arch"] }),
  phrase("wall bottom cover", "墙底盖板", "head", { tags: ["wall", "cover"] }),
  phrase("door flat", "平拱门洞", "post", { tags: ["door"] }),
  phrase("door round inset", "圆拱内嵌门洞", "post", { tags: ["door"] }),
  phrase("door round", "圆拱门洞", "post", { tags: ["door"] }),
  phrase("window thin round", "窄圆拱窗", "post", { tags: ["window"] }),
  phrase("window thin flat", "窄平拱窗", "post", { tags: ["window"] }),
  phrase("window thin", "窄窗", "post", { tags: ["window"] }),
  phrase("window wide flat", "宽平拱窗", "post", { tags: ["window"] }),
  phrase("window wide round", "宽圆拱窗", "post", { tags: ["window"] }),
  phrase("wood grid", "木格架", "post", { alias: ["半木结构"], tags: ["wood", "timber-frame"] }),
  phrase("window shutters", "护窗板窗", "head", { alias: ["带窗板的窗", "百叶窗"], tags: ["window", "shutters"] }),
  phrase("bottom cover", "底部盖板", "post"),
  phrase("corner front", "正面转角", "post"),
];

const CATEGORY_PHRASES = {
  nature: [phrase("bed floor", "野营地铺", "head", { alias: ["地铺", "睡垫"], tags: ["camp", "bed"] })],
  furniture: [
    phrase("stairs corner", "转角楼梯", "head", { tags: ["stairs"] }),
    phrase("wall corner", "转角墙", "head", { tags: ["wall"] }),
    phrase("floor corner", "转角地板", "head", { tags: ["floor"] }),
    phrase("desk corner", "转角书桌", "head", { alias: ["L 形书桌"], tags: ["desk", "table"] }),
  ],
  buildings: [phrase("bricks", "砖砌墙块", "head", { tags: ["brick", "wall"] })],
  vehicles: [phrase("door window", "带窗车门", "head", { tags: ["door", "window", "part"] })],
  pirate: [
    phrase("flag pirate high pennant", "高杆海盗三角旗", "head", { alias: ["海盗旗"], tags: ["flag", "pennant"] }),
    phrase("flag pirate pennant", "海盗三角旗", "head", { alias: ["海盗旗"], tags: ["flag", "pennant"] }),
    phrase("flag pirate high", "高杆海盗旗", "head", { alias: ["海盗旗"], tags: ["flag"] }),
    phrase("flag pirate", "海盗旗", "head", { alias: ["骷髅旗"], tags: ["flag"] }),
    phrase("flag high pennant", "高杆三角旗", "head", { tags: ["flag", "pennant"] }),
    phrase("flag pennant", "三角旗", "head", { tags: ["flag", "pennant"] }),
    phrase("flag high", "高杆旗帜", "head", { tags: ["flag"] }),
  ],
  trains: [phrase("open container", "敞口集装箱", "post", { tags: ["container"] })],
};

// ---------------------------------------------------------------------------
// Per-item overrides: full name (and optional aliases/tags) for names whose
// compositional translation would read poorly in Chinese.
// ---------------------------------------------------------------------------
const OVERRIDES = {
  "boats/boat_wsail.glb": { name: "帆船小艇", alias: ["带帆小船", "帆船"], tags: ["boat", "sail", "sailboat"] },

  "buildings/ac_unit.glb": { name: "空调外机", alias: ["空调", "冷气机"], tags: ["air-conditioner", "hvac", "rooftop"] },
  "buildings/ac_unitx4.glb": { name: "空调外机组（×4）", alias: ["空调", "冷气机组"], tags: ["air-conditioner", "hvac", "rooftop"] },
  "buildings/bricks_half.glb": { name: "砖砌墙块（半块）", alias: ["砖墙"], tags: ["brick", "wall"] },
  "buildings/bricks_large.glb": { name: "砖砌墙块（大块）", alias: ["砖墙"], tags: ["brick", "wall"] },
  "buildings/bricks_left_straight.glb": { name: "砖砌墙块（左直段）", alias: ["砖墙"], tags: ["brick", "wall"] },
  "buildings/bricks_right_straight.glb": { name: "砖砌墙块（右直段）", alias: ["砖墙"], tags: ["brick", "wall"] },
  "buildings/bricks_single.glb": { name: "砖砌墙块（单块）", alias: ["砖墙"], tags: ["brick", "wall"] },
  "buildings/bricks_small.glb": { name: "砖砌墙块（小块）", alias: ["砖墙"], tags: ["brick", "wall"] },

  "dungeon/details_x.glb": { name: "X 形装饰件", alias: ["交叉装饰"], tags: ["greeble", "detail"] },
  "dungeon/details_plate_details.glb": { name: "板件装饰件（精细）", alias: ["面板装饰"], tags: ["greeble", "detail", "plate"] },
  "dungeon/props_base.glb": { name: "底座平台", alias: ["圆形底座"], tags: ["prop", "base", "platform"] },

  "furniture/bear.glb": { name: "熊头挂饰", alias: ["熊头墙饰", "动物头装饰"], tags: ["decoration", "trophy", "bear"] },
  "furniture/cabinet_bed_drawer_table.glb": {
    name: "床头柜（带抽屉·桌式）",
    alias: ["床头桌", "床边柜"],
    tags: ["nightstand", "cabinet", "bedroom", "drawer"],
  },

  "nature/bed.glb": { name: "野营床", alias: ["行军床", "露营床"], tags: ["camp", "bed"] },
  "nature/building_platform.glb": { name: "木构平台", alias: ["营地平台"], tags: ["structure", "platform", "camp"] },
  "nature/building_roof.glb": { name: "木构屋顶", alias: ["营地屋顶"], tags: ["structure", "roof", "camp"] },
  "nature/building_structure.glb": { name: "木构架", alias: ["木框架", "营地构架"], tags: ["structure", "camp"] },
  "nature/plant_flat_short.glb": { name: "矮阔叶植物", alias: ["阔叶植物"], tags: ["plant", "foliage"] },
  "nature/plant_flat_tall.glb": { name: "高阔叶植物", alias: ["阔叶植物"], tags: ["plant", "foliage"] },
  "nature/stump_old_tall.glb": { name: "老树桩（高）", alias: ["高树桩"], tags: ["stump"] },
  "nature/rock_small_top_a.glb": { name: "小岩石 A（平顶）", alias: ["平顶岩石"], tags: ["rock", "terrain"] },
  "nature/rock_small_top_b.glb": { name: "小岩石 B（平顶）", alias: ["平顶岩石"], tags: ["rock", "terrain"] },
  "nature/stone_small_top_a.glb": { name: "小石头 A（平顶）", alias: ["平顶石头"], tags: ["stone", "terrain"] },
  "nature/stone_small_top_b.glb": { name: "小石头 B（平顶）", alias: ["平顶石头"], tags: ["stone", "terrain"] },

  "pirate/hole.glb": { name: "沙地坑洞", alias: ["藏宝坑", "挖掘坑"], tags: ["hole", "sand", "treasure"] },

  "vehicles/box.glb": { name: "纸箱", alias: ["箱子", "障碍物"], tags: ["box", "obstacle"] },

  "weapons/smoke.glb": { name: "烟雾团", alias: ["烟雾", "烟雾特效"], tags: ["smoke", "effect"] },
  "weapons/target_detail.glb": { name: "靶子细节部件", alias: ["靶子部件"], tags: ["target", "detail"] },

  "spaceships/bob.glb": { name: "鲍勃号宇宙飞船", alias: ["Bob", "鲍勃号"], tags: ["ship"] },
  "spaceships/challenger.glb": { name: "挑战者号宇宙飞船", alias: ["Challenger", "挑战者号"], tags: ["ship"] },
  "spaceships/dispatcher.glb": { name: "调度者号宇宙飞船", alias: ["Dispatcher", "调度者号"], tags: ["ship"] },
  "spaceships/executioner.glb": { name: "处决者号宇宙飞船", alias: ["Executioner", "处决者号"], tags: ["ship"] },
  "spaceships/imperial.glb": { name: "帝国号宇宙飞船", alias: ["Imperial", "帝国号"], tags: ["ship"] },
  "spaceships/insurgent.glb": { name: "叛乱者号宇宙飞船", alias: ["Insurgent", "叛乱者号"], tags: ["ship"] },
  "spaceships/omen.glb": { name: "预兆号宇宙飞船", alias: ["Omen", "预兆号"], tags: ["ship"] },
  "spaceships/pancake.glb": { name: "薄饼号宇宙飞船", alias: ["Pancake", "薄饼号", "飞碟"], tags: ["ship"] },
  "spaceships/spitfire.glb": { name: "喷火号宇宙飞船", alias: ["Spitfire", "喷火号"], tags: ["ship"] },
  "spaceships/striker.glb": { name: "突击者号宇宙飞船", alias: ["Striker", "突击者号"], tags: ["ship"] },
  "spaceships/zenith.glb": { name: "天顶号宇宙飞船", alias: ["Zenith", "天顶号"], tags: ["ship"] },
};

// ---------------------------------------------------------------------------
// Tokenizer.
// ---------------------------------------------------------------------------
export function tokenizeBaseName(base) {
  const rawParts = base.toLowerCase().split(/[_-]+/).filter(Boolean);
  const tokens = [];
  for (const part of rawParts) {
    if (/^\d+x\d+$/.test(part)) {
      tokens.push(part);
      continue;
    }
    if (part === "unitx4") {
      // buildings/ac_unitx4.glb: "unit x4", not a "unitx" word with suffix 4
      tokens.push(part);
      continue;
    }
    const match = part.match(/^([a-z]+)(\d+)$/);
    if (match) {
      tokens.push(match[1], match[2]);
      continue;
    }
    tokens.push(part);
  }
  return tokens;
}

const isNumberToken = (token) => /^\d+$/.test(token);
const isDimensionToken = (token) => /^\d+x\d+$/.test(token);
const isLetterToken = (token) => /^[a-z]$/.test(token);

// ---------------------------------------------------------------------------
// Composition engine.
// ---------------------------------------------------------------------------
function matchPhrase(tokens, index, category) {
  const candidates = [...(CATEGORY_PHRASES[category] ?? []), ...PHRASES];
  let best = null;
  for (const candidate of candidates) {
    const { seq } = candidate;
    if (seq.length < 2 && !CATEGORY_PHRASES[category]?.includes(candidate)) continue;
    if (index + seq.length > tokens.length) continue;
    let matches = true;
    for (let offset = 0; offset < seq.length; offset += 1) {
      if (tokens[index + offset] !== seq[offset]) {
        matches = false;
        break;
      }
    }
    if (matches && (!best || seq.length > best.seq.length)) best = candidate;
  }
  return best;
}

function lookupWord(token, category) {
  return CATEGORY_WORDS[category]?.[token] ?? WORDS[token] ?? null;
}

function composeName(category, tokens, unknownTokens) {
  const pres = [];
  const heads = [];
  const posts = [];
  const variants = [];
  const tags = [];
  const aliases = [];
  let suffix = "";

  const applyEntry = (entry, index) => {
    if (entry.tags) tags.push(...entry.tags);
    if (entry.alias) aliases.push(...entry.alias);
    switch (entry.role) {
      case "pre":
        pres.push(entry.zh);
        break;
      case "head":
        if (heads.length > 0 && entry.alt) posts.push(entry.alt);
        else heads.push(entry.zh);
        break;
      case "post":
        posts.push(entry.zh);
        break;
      case "variant":
        variants.push(entry.zh);
        break;
      case "marker":
        if (index === 0 && entry.suffix) suffix = entry.suffix;
        else if (entry.alt) posts.push(entry.alt);
        break;
      default:
        throw new Error(`unknown dictionary role: ${entry.role}`);
    }
  };

  let index = 0;
  while (index < tokens.length) {
    const phraseEntry = matchPhrase(tokens, index, category);
    if (phraseEntry) {
      applyEntry(phraseEntry, index);
      index += phraseEntry.seq.length;
      continue;
    }
    const token = tokens[index];
    const wordEntry = lookupWord(token, category);
    if (wordEntry) {
      applyEntry(wordEntry, index);
    } else if (isNumberToken(token)) {
      variants.push(token);
    } else if (isDimensionToken(token)) {
      variants.push(token.replace("x", "×"));
    } else if (isLetterToken(token)) {
      variants.push(token.toUpperCase());
    } else {
      unknownTokens.add(token);
    }
    index += 1;
  }

  let name = pres.join("") + heads.join("") + suffix;
  if (name.length === 0 && posts.length > 0) name = posts.shift();
  if (variants.length > 0) name += ` ${variants.join("-")}`;
  if (posts.length > 0) name += `（${posts.join("·")}）`;
  return { name, tags, aliases };
}

// ---------------------------------------------------------------------------
// Structural validation mirroring flickMetadataOverlaySchema (plain JS; the
// vitest suite re-validates with the actual zod schema).
// ---------------------------------------------------------------------------
const KEY_PATTERN = /^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.glb$/i;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const CJK_PATTERN = /[\u3400-\u9fff]/;

const assertTrimmedString = (value, maximum, label) => {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (value !== value.trim()) throw new Error(`${label} must not have surrounding whitespace: "${value}"`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} chars: "${value}"`);
};

function assertOverlayDocument(document, catalogKeys) {
  if (document.schema_version !== 1) throw new Error("schema_version must be 1");
  assertTrimmedString(document.generator, 200, "generator");
  const keys = Object.keys(document.items);
  if (keys.length !== catalogKeys.size) {
    throw new Error(`item count mismatch: overlay ${keys.length} vs catalog ${catalogKeys.size}`);
  }
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) throw new Error(`invalid overlay key: ${key}`);
    if (!catalogKeys.has(key)) throw new Error(`orphan overlay key not in catalog: ${key}`);
    const entry = document.items[key];
    assertTrimmedString(entry.name_zh, 240, `${key} name_zh`);
    if (!CJK_PATTERN.test(entry.name_zh) && !DESIGNATION_NAME_EXCEPTIONS.includes(key)) {
      throw new Error(`${key} name_zh has no CJK character: "${entry.name_zh}"`);
    }
    if (!Array.isArray(entry.aliases) || entry.aliases.length > 16) {
      throw new Error(`${key} aliases must be an array with at most 16 entries`);
    }
    for (const alias of entry.aliases) assertTrimmedString(alias, 240, `${key} alias`);
    if (!Array.isArray(entry.tags) || entry.tags.length < 1 || entry.tags.length > 12) {
      throw new Error(`${key} tags must have 1..12 entries`);
    }
    for (const tag of entry.tags) {
      assertTrimmedString(tag, 64, `${key} tag`);
      if (!TAG_PATTERN.test(tag)) throw new Error(`${key} tag not a lowercase slug: "${tag}"`);
    }
    const { spatial } = entry;
    if (!spatial || !Array.isArray(spatial.bounds_m) || spatial.bounds_m.length !== 3) {
      throw new Error(`${key} spatial.bounds_m must contain three metric dimensions`);
    }
    if (spatial.bounds_m.some((value) => !Number.isFinite(value) || value < 0) || Math.max(...spatial.bounds_m) <= 0) {
      throw new Error(`${key} spatial.bounds_m must be non-negative, finite, and measurable`);
    }
    if (
      !Array.isArray(spatial.footprint_m) ||
      spatial.footprint_m[0] !== spatial.bounds_m[0] ||
      spatial.footprint_m[1] !== spatial.bounds_m[2] ||
      spatial.height_m !== spatial.bounds_m[1] ||
      !Number.isFinite(spatial.ground_offset_y) ||
      spatial.front_axis !== null
    ) {
      throw new Error(`${key} spatial facts do not match bounds_m`);
    }
  }
  for (const key of catalogKeys) {
    if (!(key in document.items)) throw new Error(`catalog item missing from overlay: ${key}`);
  }
}

// ---------------------------------------------------------------------------
// Generator.
// ---------------------------------------------------------------------------
const dedupe = (values) => [...new Set(values)];

/** Case-insensitive dedupe keeping the first spelling ("Challenger" over "challenger"). */
function dedupeAliases(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const lowered = value.toLowerCase();
    if (seen.has(lowered)) continue;
    seen.add(lowered);
    result.push(value);
  }
  return result;
}

export function generateFlickMetadata() {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
  const unknownTokens = new Set();
  const items = {};

  for (const item of catalog.items) {
    const { category, fileName } = item;
    const key = `${category}/${fileName}`;
    const base = fileName.replace(/\.glb$/i, "");
    const tokens = tokenizeBaseName(base);

    // Dictionary coverage is enforced for every item, including overridden
    // ones, so the fail-loudly mechanism keeps covering the whole catalog.
    const composed = composeName(category, tokens, unknownTokens);

    const override = OVERRIDES[key];
    const name = override?.name ?? composed.name;
    const englishName = base.replace(/[_-]+/g, " ");
    const aliases = dedupeAliases([...(override?.alias ?? []), ...(override ? [] : composed.aliases), englishName]).filter(
      (alias) => alias !== name,
    );
    const tags = dedupe([
      category,
      ...(STANDARD_CATEGORY[category] !== category ? [STANDARD_CATEGORY[category]] : []),
      ...CATEGORY_TAGS[category],
      ...(override?.tags ?? []),
      ...composed.tags,
    ]);

    items[key] = {
      name_zh: name,
      aliases: aliases.slice(0, 16),
      tags: tags.slice(0, 12),
      spatial: metricSpatialFor(category, fileName),
    };
  }

  if (unknownTokens.size > 0) {
    const list = [...unknownTokens].sort().join("\n  ");
    throw new Error(`untranslated tokens (${unknownTokens.size}) — add dictionary entries for:\n  ${list}`);
  }

  const sortedItems = {};
  for (const key of Object.keys(items).sort()) sortedItems[key] = items[key];

  const overlay = { schema_version: 1, generator: GENERATOR_ID, items: sortedItems };
  const catalogKeys = new Set(catalog.items.map((item) => `${item.category}/${item.fileName}`));
  assertOverlayDocument(overlay, catalogKeys);

  return {
    overlay,
    json: `${JSON.stringify(overlay, null, 2)}\n`,
    stats: {
      itemCount: Object.keys(sortedItems).length,
      wordCount: Object.keys(WORDS).length,
      categoryWordCount: Object.values(CATEGORY_WORDS).reduce((total, words) => total + Object.keys(words).length, 0),
      phraseCount: PHRASES.length + Object.values(CATEGORY_PHRASES).reduce((total, list) => total + list.length, 0),
      overrideCount: Object.keys(OVERRIDES).length,
    },
  };
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  const { json, stats } = generateFlickMetadata();
  writeFileSync(OUTPUT_PATH, json);
  console.log(
    `wrote ${path.relative(repoRoot, OUTPUT_PATH)}: ${stats.itemCount} items ` +
      `(dictionary: ${stats.wordCount} words + ${stats.categoryWordCount} category words + ` +
      `${stats.phraseCount} phrases + ${stats.overrideCount} overrides)`,
  );
}
