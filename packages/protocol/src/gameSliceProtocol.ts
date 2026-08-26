import { z } from "zod";

/**
 * Game Slice IR — the durable document a Director agent authors instead of a
 * markdown plan plus generated engine source.
 *
 * GameFactory-3A routes a coding agent through prose skills that shell out to
 * Python pipelines and dump engine-native C#/Blueprint/GDScript. Director's
 * harness advantage is a typed slice bound to a live Stage revision: roles
 * point at real object ids, the core loop maps onto the existing player
 * session, and playability evidence is a scripted input tape plus structured
 * issues — not "it compiled" or "watch this video".
 *
 * Canonical vocabulary for operations lives on `director_game` capabilities /
 * describe. This module is the data contract those operations read and write.
 */

/** Protocol contract identifier for a Director game slice. */
export const GAME_SLICE_CONTRACT = "director-game-slice-v1" as const;

/** Durable identifier; `game-` prefix partitions the id space from film runs. */
export const gameSliceIdSchema = z.string().regex(/^game-[a-z0-9-]{8,64}$/i);

const nonEmptyText = (maximum: number) => z.string().trim().min(1).max(maximum);
const boundedText = (maximum: number) => z.string().trim().max(maximum);
const finite = z.number().finite();
const objectId = nonEmptyText(200);

/** Genres that have a Stage player mapping and GameFactory demo counterparts. */
export const GAME_SLICE_GENRES = ["exploration", "fps", "racing", "fighting", "rpg"] as const;
export const gameSliceGenreSchema = z.enum(GAME_SLICE_GENRES);
export type GameSliceGenre = (typeof GAME_SLICE_GENRES)[number];

/** Camera perspectives the live Stage player already supports or can emulate. */
export const GAME_SLICE_PERSPECTIVES = ["first", "third", "top_down"] as const;
export const gameSlicePerspectiveSchema = z.enum(GAME_SLICE_PERSPECTIVES);
export type GameSlicePerspective = (typeof GAME_SLICE_PERSPECTIVES)[number];

/**
 * Where the slice is expected to run. `stage` is the first playable runtime
 * (Director's live player). Engine ids are export targets via `director_dcc`,
 * never a replacement for a Stage playtest receipt.
 */
export const GAME_SLICE_ENGINE_TARGETS = ["stage", "godot", "unity", "unreal"] as const;
export const gameSliceEngineTargetSchema = z.enum(GAME_SLICE_ENGINE_TARGETS);
export type GameSliceEngineTarget = (typeof GAME_SLICE_ENGINE_TARGETS)[number];

/** Player verbs that map onto Stage player input / session actions. */
export const GAME_SLICE_VERBS = [
  "move",
  "look",
  "jump",
  "sprint",
  "dash",
  "crouch",
  "interact",
  "attack",
  "fire",
  "reload",
  "enter_vehicle",
  "exit_vehicle",
  "pause",
] as const;
export const gameSliceVerbSchema = z.enum(GAME_SLICE_VERBS);
export type GameSliceVerb = (typeof GAME_SLICE_VERBS)[number];

/** How a scene object participates in the slice. */
export const GAME_SLICE_ROLE_KINDS = [
  "player",
  "enemy",
  "npc",
  "prop",
  "vehicle",
  "spawn",
  "objective",
  "hazard",
] as const;
export const gameSliceRoleKindSchema = z.enum(GAME_SLICE_ROLE_KINDS);
export type GameSliceRoleKind = (typeof GAME_SLICE_ROLE_KINDS)[number];

/** Typed HUD widgets. CSS/engine UXML dumps are not a Director HUD. */
export const GAME_SLICE_HUD_WIDGETS = [
  "health",
  "ammo",
  "score",
  "prompt",
  "minimap",
  "crosshair",
  "speedometer",
  "dialogue",
  "timer",
] as const;
export const gameSliceHudWidgetKindSchema = z.enum(GAME_SLICE_HUD_WIDGETS);
export type GameSliceHudWidgetKind = (typeof GAME_SLICE_HUD_WIDGETS)[number];

/** Structured playability checks. A screenshot or compile log is never one of these. */
export const GAME_SLICE_PLAYABILITY_CHECKS = [
  "on_ground",
  "facing_matches_move",
  "no_camera_clip",
  "verb_exercised",
  "interaction_in_range",
  "hud_bound",
  "objective_reachable",
  "no_stuck",
] as const;
export const gameSlicePlayabilityCheckSchema = z.enum(GAME_SLICE_PLAYABILITY_CHECKS);
export type GameSlicePlayabilityCheck = (typeof GAME_SLICE_PLAYABILITY_CHECKS)[number];

export const GAME_SLICE_STATUSES = ["draft", "bound", "playtested", "playable", "exported"] as const;
export const gameSliceStatusSchema = z.enum(GAME_SLICE_STATUSES);
export type GameSliceStatus = (typeof GAME_SLICE_STATUSES)[number];

export const gameSliceIssueSeveritySchema = z.enum(["error", "warning", "info"]);
export type GameSliceIssueSeverity = z.infer<typeof gameSliceIssueSeveritySchema>;

/**
 * Natural-language brief. Missing engine/perspective/style are filled with
 * explicit defaults on `plan` (Stage, genre-driven camera, reported in notes)
 * rather than blocking the agent the way GameFactory's overview skill does.
 */
export const gameSliceBriefSchema = z.strictObject({
  requirement: nonEmptyText(8_000),
  genre: gameSliceGenreSchema,
  perspective: gameSlicePerspectiveSchema.optional(),
  engine_target: gameSliceEngineTargetSchema.optional(),
  platform: boundedText(120).optional(),
  style: boundedText(240).optional(),
  references: z.array(nonEmptyText(500)).max(16).optional(),
});
export type GameSliceBrief = z.infer<typeof gameSliceBriefSchema>;
export type GameSliceBriefInput = z.input<typeof gameSliceBriefSchema>;

/** Core loop: verbs, win/lose, respawn. Independent of any engine's API docs. */
export const gameSliceLoopSchema = z.strictObject({
  summary: nonEmptyText(2_000),
  verbs: z.array(gameSliceVerbSchema).min(1).max(GAME_SLICE_VERBS.length),
  win: nonEmptyText(1_000),
  lose: boundedText(1_000).optional(),
  respawn: z.boolean().default(true),
});
export type GameSliceLoop = z.infer<typeof gameSliceLoopSchema>;
export type GameSliceLoopInput = z.input<typeof gameSliceLoopSchema>;

/**
 * Control mapping. `scheme` is a label for humans; verbs are the contract.
 * Camera mode must match the Stage player (`first` / `third`) or declare
 * `top_down` as a planned overlay — never a free-orbit director camera.
 */
export const gameSliceControlsSchema = z.strictObject({
  scheme: z.enum(["wasd_mouse", "gamepad", "twin_stick"]).default("wasd_mouse"),
  camera: gameSlicePerspectiveSchema,
  verbs: z.array(gameSliceVerbSchema).min(1).max(GAME_SLICE_VERBS.length),
});
export type GameSliceControls = z.infer<typeof gameSliceControlsSchema>;
export type GameSliceControlsInput = z.input<typeof gameSliceControlsSchema>;

/**
 * A named role. `object_id` is bound later; a draft slice may list unbound
 * roles. Exactly one `player` role is required once the slice is `bound`.
 */
export const gameSliceRoleSchema = z.strictObject({
  id: nonEmptyText(80),
  kind: gameSliceRoleKindSchema,
  purpose: nonEmptyText(500),
  object_id: objectId.optional(),
  asset_id: nonEmptyText(200).optional(),
});
export type GameSliceRole = z.infer<typeof gameSliceRoleSchema>;
export type GameSliceRoleInput = z.input<typeof gameSliceRoleSchema>;

/** One HUD widget bound to a slice channel or role. */
export const gameSliceHudWidgetSchema = z.strictObject({
  id: nonEmptyText(80),
  kind: gameSliceHudWidgetKindSchema,
  label: nonEmptyText(80),
  role_id: nonEmptyText(80).optional(),
  channel: boundedText(80).optional(),
});
export type GameSliceHudWidget = z.infer<typeof gameSliceHudWidgetSchema>;

export const gameSliceHudSchema = z.strictObject({
  widgets: z.array(gameSliceHudWidgetSchema).max(16).default([]),
});
export type GameSliceHud = z.infer<typeof gameSliceHudSchema>;
export type GameSliceHudInput = z.input<typeof gameSliceHudSchema>;

/** Provenance for one bound or planned asset. Generation is one route, not the default. */
export const GAME_SLICE_ASSET_SOURCES = ["catalog", "project", "generated_3d", "blender_native", "licensed"] as const;
export const gameSliceAssetSourceSchema = z.enum(GAME_SLICE_ASSET_SOURCES);

export const gameSliceAssetBindingSchema = z.strictObject({
  role_id: nonEmptyText(80),
  source: gameSliceAssetSourceSchema,
  asset_id: nonEmptyText(240).optional(),
  object_id: objectId.optional(),
  license: boundedText(160).optional(),
  notes: boundedText(500).optional(),
});
export type GameSliceAssetBinding = z.infer<typeof gameSliceAssetBindingSchema>;

export const gameSliceAcceptanceSchema = z.strictObject({
  operations: z.array(gameSliceVerbSchema).min(1).max(GAME_SLICE_VERBS.length),
  playability_checks: z.array(gameSlicePlayabilityCheckSchema).min(1).max(GAME_SLICE_PLAYABILITY_CHECKS.length),
  style: boundedText(240).optional(),
});
export type GameSliceAcceptance = z.infer<typeof gameSliceAcceptanceSchema>;
export type GameSliceAcceptanceInput = z.input<typeof gameSliceAcceptanceSchema>;

/**
 * One held-input sample. Axes are -1..1 with +forward / +right. Digital flags
 * match the Stage `PlayerInput` contract so a tape can drive the live player
 * or a host-free locomotion replay without translation.
 */
export const gamePlaytestInputSchema = z.strictObject({
  forward: z.boolean().default(false),
  backward: z.boolean().default(false),
  left: z.boolean().default(false),
  right: z.boolean().default(false),
  sprint: z.boolean().default(false),
  jump: z.boolean().default(false),
  descend: z.boolean().default(false),
  dash: z.boolean().default(false),
  crouch: z.boolean().default(false),
  interact: z.boolean().default(false),
  fire: z.boolean().default(false),
  pause: z.boolean().default(false),
  enter_vehicle: z.boolean().default(false),
  exit_vehicle: z.boolean().default(false),
  look_left: z.boolean().default(false),
  look_right: z.boolean().default(false),
  look_up: z.boolean().default(false),
  look_down: z.boolean().default(false),
  move_forward_axis: finite.min(-1).max(1).optional(),
  move_right_axis: finite.min(-1).max(1).optional(),
});
export type GamePlaytestInput = z.infer<typeof gamePlaytestInputSchema>;
export type GamePlaytestInputWire = z.input<typeof gamePlaytestInputSchema>;

/** Optional assertion evaluated against the last sample of a tape step. */
export const gamePlaytestExpectSchema = z.strictObject({
  on_ground: z.boolean().optional(),
  min_speed_mps: finite.min(0).max(200).optional(),
  max_speed_mps: finite.min(0).max(200).optional(),
  reached_object_id: objectId.optional(),
  reached_radius_m: finite.min(0.05).max(50).optional(),
  verb: gameSliceVerbSchema.optional(),
});
export type GamePlaytestExpect = z.infer<typeof gamePlaytestExpectSchema>;

/** One contiguous hold of the same input, lasting `frames` simulation ticks. */
export const gamePlaytestStepSchema = z.strictObject({
  frames: z.number().int().min(1).max(10_000),
  input: gamePlaytestInputSchema,
  expect: gamePlaytestExpectSchema.optional(),
});
export type GamePlaytestStep = z.infer<typeof gamePlaytestStepSchema>;
export type GamePlaytestStepInput = z.input<typeof gamePlaytestStepSchema>;

/**
 * Scripted playtest tape. `dt` is the simulation timestep in seconds (default
 * 1/30 to match the living-world tick). A compile is not a playtest.
 */
export const gamePlaytestScriptSchema = z.strictObject({
  dt: finite.min(1 / 240).max(1 / 10).default(1 / 30),
  steps: z.array(gamePlaytestStepSchema).min(1).max(256),
});
export type GamePlaytestScript = z.infer<typeof gamePlaytestScriptSchema>;
export type GamePlaytestScriptInput = z.input<typeof gamePlaytestScriptSchema>;

/** One recorded pose/sample from a live Stage player or a host-free replay. */
export const gamePlaytestSampleSchema = z.strictObject({
  frame: z.number().int().nonnegative().max(1_048_576),
  time_s: finite.min(0),
  position: z.tuple([finite, finite, finite]),
  yaw: finite,
  pitch: finite.optional(),
  velocity: z.tuple([finite, finite, finite]).optional(),
  on_ground: z.boolean(),
  flying: z.boolean().default(false),
  verb: gameSliceVerbSchema.optional(),
  interaction_object_id: objectId.optional(),
  camera_clip: z.boolean().default(false),
  stuck: z.boolean().default(false),
});
export type GamePlaytestSample = z.infer<typeof gamePlaytestSampleSchema>;
export type GamePlaytestSampleInput = z.input<typeof gamePlaytestSampleSchema>;

export const gamePlaytestTraceSchema = z.strictObject({
  contract: z.literal("director-game-playtest-trace-v1"),
  slice_id: gameSliceIdSchema,
  project_revision: nonEmptyText(240).optional(),
  dt: finite.min(1 / 240).max(1 / 10),
  samples: z.array(gamePlaytestSampleSchema).min(1).max(1_048_576),
  verbs_exercised: z.array(gameSliceVerbSchema).max(GAME_SLICE_VERBS.length).default([]),
});
export type GamePlaytestTrace = z.infer<typeof gamePlaytestTraceSchema>;
export type GamePlaytestTraceInput = z.input<typeof gamePlaytestTraceSchema>;

export const gameSliceIssueSchema = z.strictObject({
  code: z.enum([
    "fell_through_floor",
    "facing_mismatch",
    "camera_clip",
    "stuck",
    "verb_not_exercised",
    "interaction_out_of_range",
    "vehicle_sequence_invalid",
    "hud_unbound",
    "player_unbound",
    "objective_unreachable",
    "expect_failed",
    "style_unverified",
    "engine_not_ready",
  ]),
  severity: gameSliceIssueSeveritySchema,
  check: gameSlicePlayabilityCheckSchema.optional(),
  message: nonEmptyText(500),
  sample_frame: z.number().int().nonnegative().optional(),
  role_id: nonEmptyText(80).optional(),
  object_id: objectId.optional(),
  corrective_call: z.unknown().optional(),
});
export type GameSliceIssue = z.infer<typeof gameSliceIssueSchema>;

export const gameEvaluationReportSchema = z.strictObject({
  contract: z.literal("director-game-evaluation-v1"),
  slice_id: gameSliceIdSchema,
  playable: z.boolean(),
  verbs_exercised: z.array(gameSliceVerbSchema).max(GAME_SLICE_VERBS.length),
  checks: z.array(
    z.strictObject({
      check: gameSlicePlayabilityCheckSchema,
      passed: z.boolean(),
    }),
  ),
  issues: z.array(gameSliceIssueSchema).max(128),
  notes: z.array(nonEmptyText(500)).max(32).default([]),
});
export type GameEvaluationReport = z.infer<typeof gameEvaluationReportSchema>;

/** The durable game-slice document persisted by the Gateway. */
export const gameSliceSchema = z.strictObject({
  contract: z.literal(GAME_SLICE_CONTRACT),
  id: gameSliceIdSchema,
  title: nonEmptyText(160),
  status: gameSliceStatusSchema,
  brief: gameSliceBriefSchema,
  loop: gameSliceLoopSchema,
  controls: gameSliceControlsSchema,
  roles: z.array(gameSliceRoleSchema).min(1).max(64),
  hud: gameSliceHudSchema,
  assets: z.array(gameSliceAssetBindingSchema).max(64).default([]),
  acceptance: gameSliceAcceptanceSchema,
  project_revision: nonEmptyText(240).optional(),
  last_playtest_id: nonEmptyText(80).optional(),
  last_evaluation: gameEvaluationReportSchema.optional(),
  export: z
    .strictObject({
      provider: z.enum(["godot", "unity", "unreal"]),
      package_dir: nonEmptyText(2_048).optional(),
      notes: z.array(nonEmptyText(500)).max(16).default([]),
    })
    .optional(),
  notes: z.array(nonEmptyText(500)).max(32).default([]),
  created_at: z.string().min(1).max(40),
  updated_at: z.string().min(1).max(40),
});
export type GameSlice = z.infer<typeof gameSliceSchema>;
export type GameSliceInput = z.input<typeof gameSliceSchema>;

const DEFAULT_VERBS_BY_GENRE: Record<GameSliceGenre, GameSliceVerb[]> = {
  exploration: ["move", "look", "jump", "interact"],
  fps: ["move", "look", "jump", "sprint", "fire", "reload"],
  racing: ["move", "look", "enter_vehicle", "exit_vehicle"],
  fighting: ["move", "look", "jump", "attack", "dash"],
  rpg: ["move", "look", "jump", "interact", "attack"],
};

const DEFAULT_HUD_BY_GENRE: Record<GameSliceGenre, GameSliceHudWidgetKind[]> = {
  exploration: ["prompt"],
  fps: ["health", "ammo", "crosshair"],
  racing: ["speedometer"],
  fighting: ["health", "timer"],
  rpg: ["health", "prompt", "dialogue"],
};

const DEFAULT_CHECKS: GameSlicePlayabilityCheck[] = [
  "on_ground",
  "facing_matches_move",
  "verb_exercised",
  "no_stuck",
];

/**
 * Genres whose default roles include an objective also accept on interaction
 * evidence: the tape must interact in range and reach the objective object.
 */
const EXTRA_CHECKS_BY_GENRE: Record<GameSliceGenre, GameSlicePlayabilityCheck[]> = {
  exploration: ["interaction_in_range", "objective_reachable"],
  fps: [],
  racing: [],
  fighting: [],
  rpg: ["interaction_in_range", "objective_reachable"],
};

function defaultPerspective(genre: GameSliceGenre, requested?: GameSlicePerspective): GameSlicePerspective {
  if (requested) return requested;
  if (genre === "fps") return "first";
  if (genre === "exploration" || genre === "rpg") return "third";
  return "third";
}

function defaultTitle(requirement: string, genre: GameSliceGenre): string {
  const firstLine = requirement.split(/\r?\n/, 1)[0]?.trim() ?? genre;
  return firstLine.slice(0, 80) || genre;
}

/**
 * Build a draft slice from a brief. Unspecified engine/perspective/style are
 * filled with explicit defaults and recorded in `notes` so the agent never
 * silently substitutes a different game.
 */
export function createGameSliceFromBrief(input: {
  id: string;
  brief: GameSliceBriefInput;
  now: string;
  title?: string;
}): GameSlice {
  const brief = gameSliceBriefSchema.parse(input.brief);
  const perspective = defaultPerspective(brief.genre, brief.perspective);
  const engineTarget = brief.engine_target ?? "stage";
  const verbs = DEFAULT_VERBS_BY_GENRE[brief.genre];
  const notes: string[] = [];
  if (!brief.perspective) {
    notes.push(`Defaulted perspective to "${perspective}" for genre "${brief.genre}".`);
  }
  if (!brief.engine_target) {
    notes.push('Defaulted engine_target to "stage". The live Director player is the first playable runtime.');
  }
  if (!brief.style) {
    notes.push("No visual style was specified; Stage white-box (metric clay silhouettes) is the acceptance look.");
  }

  const roles: GameSliceRole[] = [
    { id: "player", kind: "player", purpose: "Controllable actor for the live Stage player session." },
  ];
  if (brief.genre === "racing") {
    roles.push({ id: "vehicle", kind: "vehicle", purpose: "Drivable vehicle the player enters." });
  }
  if (brief.genre === "fps" || brief.genre === "fighting" || brief.genre === "rpg") {
    roles.push({ id: "enemy-1", kind: "enemy", purpose: "Primary opposing actor or target dummy." });
  }
  roles.push({ id: "spawn", kind: "spawn", purpose: "Player spawn / respawn marker." });
  if (brief.genre === "exploration" || brief.genre === "rpg") {
    roles.push({ id: "objective-1", kind: "objective", purpose: "Reachable interactable that completes the loop." });
  }

  const hud: GameSliceHud = {
    widgets: DEFAULT_HUD_BY_GENRE[brief.genre].map((kind) => ({
      id: kind,
      kind,
      label: kind,
      role_id: kind === "prompt" || kind === "dialogue" ? "objective-1" : "player",
    })),
  };

  return gameSliceSchema.parse({
    contract: GAME_SLICE_CONTRACT,
    id: input.id,
    title: input.title?.trim() || defaultTitle(brief.requirement, brief.genre),
    status: "draft",
    brief: { ...brief, perspective, engine_target: engineTarget },
    loop: {
      summary: brief.requirement.slice(0, 500),
      verbs,
      win: "Complete the authored objective without failing playability checks.",
      lose: brief.genre === "exploration" ? undefined : "Player health reaches zero or the fail state triggers.",
      respawn: true,
    },
    controls: {
      scheme: "wasd_mouse",
      camera: perspective,
      verbs,
    },
    roles,
    hud,
    assets: [],
    acceptance: {
      operations: verbs,
      playability_checks: [...DEFAULT_CHECKS, ...EXTRA_CHECKS_BY_GENRE[brief.genre]],
      style: brief.style,
    },
    notes,
    created_at: input.now,
    updated_at: input.now,
  });
}

/** True when every role has an `object_id` and exactly one player role exists. */
export function gameSliceBindComplete(slice: GameSlice): boolean {
  const players = slice.roles.filter((role) => role.kind === "player");
  if (players.length !== 1) return false;
  return slice.roles.every((role) => typeof role.object_id === "string" && role.object_id.length > 0);
}

export function playerRole(slice: GameSlice): GameSliceRole | undefined {
  return slice.roles.find((role) => role.kind === "player");
}

/** Issue used when `playtest` is called before the player role has an object id. */
export function playerUnboundIssue(slice: GameSlice): GameSliceIssue {
  return {
    code: "player_unbound",
    severity: "error",
    check: "verb_exercised",
    message: `Slice ${slice.id} has no bound player object_id. Bind the player role before playtest.`,
    role_id: "player",
    corrective_call: {
      op: "bind",
      slice_id: slice.id,
      bindings: [{ role_id: "player", object_id: "<stage character object id from observe/catalog>" }],
    },
  };
}

export const gameSliceBindPatchSchema = z.strictObject({
  role_id: nonEmptyText(80),
  object_id: objectId.optional(),
  asset_id: nonEmptyText(200).optional(),
  source: gameSliceAssetSourceSchema.optional(),
  license: boundedText(160).optional(),
});
export type GameSliceBindPatch = z.infer<typeof gameSliceBindPatchSchema>;
