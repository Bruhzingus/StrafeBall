import { GAME_CONSTANTS } from './constants';
import type {
  MatchFormat,
  MatchPresetId,
  MatchSettings,
  MatchStatus,
  RoomLifecyclePhase,
  RoomSettings
} from './types';

/**
 * Authoritative host-settings model for the unified private-match system.
 *
 * This module is the single home for the room-configuration CONTRACT and its logic: the recommended
 * presets, the validated numeric ranges, the canonicalizer, the host-update validator, and the
 * RoomSettings → MatchSettings resolver. Both the server (authoritative) and the client UI read from
 * here, so the UI can never become the only place a limit is enforced.
 *
 * Extensibility: every "how many teams / how big" decision flows through `format` + FORMAT_TEAM_SHAPE.
 * Enabling a larger format later is adding a row there and to ALLOWED_FORMATS — no shape rewrite.
 * Larger-than-2v2 is deliberately disabled now (ALLOWED_FORMATS / MAX_ENABLED_TEAM_SIZE).
 */

/** Formats players may actually create/select right now. The model supports more; this gate does not. */
export const ALLOWED_FORMATS: readonly MatchFormat[] = ['1v1', '2v2'];

/** Hard cap on team size while larger formats are disabled. Validation rejects anything above this. */
export const MAX_ENABLED_TEAM_SIZE = 2;

/** Mat layout presets: the number of standing cover mats allowed (0, 2, or 4). 4 = current map. */
export const ALLOWED_MAT_PRESETS: readonly number[] = [0, 2, 4];

export interface TeamShape {
  teamSize: number;
  teamCount: number;
  maxPlayers: number;
}

/**
 * Team geometry per format. The extensibility seam: a future '3v3' is exactly one row here. Every
 * derivation of playersPerTeam / maxPlayers goes through this map instead of hardcoded 1/2 literals.
 */
export const FORMAT_TEAM_SHAPE: Record<MatchFormat, TeamShape> = {
  '1v1': { teamSize: 1, teamCount: 2, maxPlayers: 2 },
  '2v2': { teamSize: 2, teamCount: 2, maxPlayers: 4 }
};

export interface NumericLimit {
  min: number;
  max: number;
}

/**
 * Validated, inclusive ranges for every numeric host setting. The match-settings menu and the server
 * validator both read these. Chosen as clean, sensible bounds around current effective play:
 *   - lives 1..6           (per product spec)
 *   - dodgeballs 1..12     (current 2v2 uses 10; 12 ≈ center-court spawn headroom)
 *   - bounces 0..5         (current live-ball rule is 1; 0 = dies on first contact)
 *   - rounds 1..9          (current game is a single round; odd-friendly best-of headroom)
 *   - halfCourtTimer 0..300 seconds (current drop is 120; 0 = full court immediately)
 */
export const ROOM_SETTINGS_LIMITS = {
  lives: { min: 1, max: 6 },
  dodgeballs: { min: 1, max: 12 },
  bounces: { min: 0, max: 5 },
  rounds: { min: 1, max: 9 },
  halfCourtTimer: { min: 0, max: 300 }
} as const satisfies Record<string, NumericLimit>;

export function isAllowedFormat(format: unknown): format is MatchFormat {
  return typeof format === 'string' && (ALLOWED_FORMATS as readonly string[]).includes(format);
}

export function teamShapeForFormat(format: MatchFormat): TeamShape {
  return FORMAT_TEAM_SHAPE[format] ?? FORMAT_TEAM_SHAPE['1v1'];
}

/**
 * Recommended preset for a format, derived from the game's CURRENT effective behavior so
 * "recommended" literally means "how the game plays today". 1v1 mirrors the score-race tuning
 * (6 balls), 2v2 mirrors the elimination tuning (3 lives, 10 balls). Both keep the live 120s
 * half-court drop, the 1-bounce live-ball rule, and the current 4-mat layout. These are DEFAULTS the
 * host can freely override; doing so flips `preset` to 'custom' (see detectPresetId).
 */
export function recommendedRoomSettings(format: MatchFormat): RoomSettings {
  const shared = {
    matPreset: 4, // current map ships 4 standing mats (MAT_SPECS.length)
    maxLiveBallBounces: GAME_CONSTANTS.ball.deadAfterBounces, // 1
    halfCourtTimerSeconds: GAME_CONSTANTS.match.noBoundariesSeconds, // 120
    roundCount: 1 // current game is effectively a single round
  };
  if (format === '2v2') {
    return {
      preset: '2v2-recommended',
      format: '2v2',
      livesPerPlayer: GAME_CONSTANTS.match.playerLives, // 3
      dodgeballCount: GAME_CONSTANTS.match.twoVTwoBallCount, // 10
      ...shared
    };
  }
  return {
    preset: '1v1-recommended',
    format: '1v1',
    // 1v1 is a score race today (no lives); seed the new unified lives knob with the standard 3 so
    // later stages can switch 1v1 onto the lives/round model without a surprising default.
    livesPerPlayer: GAME_CONSTANTS.match.playerLives, // 3
    dodgeballCount: GAME_CONSTANTS.map.ballCount, // 6
    ...shared
  };
}

/** Map a recommended preset id back to its format, or null for 'custom'/unknown. */
export function formatForPreset(preset: MatchPresetId): MatchFormat | null {
  if (preset === '1v1-recommended') return '1v1';
  if (preset === '2v2-recommended') return '2v2';
  return null;
}

function clampToLimit(value: number, limit: NumericLimit): number {
  return Math.min(limit.max, Math.max(limit.min, value));
}

function clampIntField(value: unknown, limit: NumericLimit, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
  return clampToLimit(n, limit);
}

/** Snap a mat preset to the nearest allowed value (0/2/4). Used by the lenient canonicalizer only. */
function snapMatPreset(value: unknown, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  let best = ALLOWED_MAT_PRESETS[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const preset of ALLOWED_MAT_PRESETS) {
    const dist = Math.abs(preset - n);
    if (dist < bestDist) {
      best = preset;
      bestDist = dist;
    }
  }
  return best;
}

/** True when two settings describe the same configuration (ignoring the derived `preset` tag). */
export function roomSettingsEqual(a: RoomSettings, b: RoomSettings): boolean {
  return (
    a.format === b.format &&
    a.livesPerPlayer === b.livesPerPlayer &&
    a.dodgeballCount === b.dodgeballCount &&
    a.maxLiveBallBounces === b.maxLiveBallBounces &&
    a.matPreset === b.matPreset &&
    a.roundCount === b.roundCount &&
    a.halfCourtTimerSeconds === b.halfCourtTimerSeconds
  );
}

/** Tag a settings object with the recommended preset it matches, or 'custom' if it matches none. */
export function detectPresetId(settings: RoomSettings): MatchPresetId {
  for (const format of ALLOWED_FORMATS) {
    if (roomSettingsEqual(settings, recommendedRoomSettings(format))) {
      return recommendedRoomSettings(format).preset;
    }
  }
  return 'custom';
}

/**
 * Lenient normalizer: take arbitrary/partial input and return a fully-valid RoomSettings by clamping
 * every field into range and snapping the mat preset. Used for INITIAL room creation, where we want a
 * robust default rather than a hard failure. Host-driven updates use the strict validator instead.
 */
export function canonicalizeRoomSettings(input: Partial<RoomSettings> | undefined): RoomSettings {
  const format = isAllowedFormat(input?.format) ? input.format : '1v1';
  const fallback = recommendedRoomSettings(format);
  const settings: RoomSettings = {
    preset: 'custom',
    format,
    livesPerPlayer: clampIntField(input?.livesPerPlayer, ROOM_SETTINGS_LIMITS.lives, fallback.livesPerPlayer),
    dodgeballCount: clampIntField(input?.dodgeballCount, ROOM_SETTINGS_LIMITS.dodgeballs, fallback.dodgeballCount),
    maxLiveBallBounces: clampIntField(input?.maxLiveBallBounces, ROOM_SETTINGS_LIMITS.bounces, fallback.maxLiveBallBounces),
    matPreset: snapMatPreset(input?.matPreset, fallback.matPreset),
    roundCount: clampIntField(input?.roundCount, ROOM_SETTINGS_LIMITS.rounds, fallback.roundCount),
    halfCourtTimerSeconds: clampIntField(input?.halfCourtTimerSeconds, ROOM_SETTINGS_LIMITS.halfCourtTimer, fallback.halfCourtTimerSeconds)
  };
  return { ...settings, preset: detectPresetId(settings) };
}

/** Default settings for a freshly created room of the given format (defaults to the 1v1 preset). */
export function defaultRoomSettings(format: MatchFormat = '1v1'): RoomSettings {
  return canonicalizeRoomSettings(recommendedRoomSettings(isAllowedFormat(format) ? format : '1v1'));
}

/**
 * Resolve host INTENT (RoomSettings) into the canonical RESOLVED engine parameters (MatchSettings):
 * the team geometry the loop builds slots/maxPlayers from, plus the per-round rule values. Derived
 * fields (team shape, legacy 1v1 scoreLimit) are computed here so the rest of the codebase has one
 * authoritative place to read them.
 */
export function resolveMatchSettings(settings: RoomSettings): MatchSettings {
  const shape = teamShapeForFormat(settings.format);
  return {
    format: settings.format,
    teamSize: shape.teamSize,
    teamCount: shape.teamCount,
    maxPlayers: shape.maxPlayers,
    livesPerPlayer: settings.livesPerPlayer,
    dodgeballCount: settings.dodgeballCount,
    maxLiveBallBounces: settings.maxLiveBallBounces,
    matPreset: settings.matPreset,
    roundCount: settings.roundCount,
    halfCourtTimerSeconds: settings.halfCourtTimerSeconds,
    scoreLimit: GAME_CONSTANTS.match.scoreLimit
  };
}

/** Map the legacy match status onto the unified lifecycle phase. */
export function roomPhaseFromMatchStatus(status: MatchStatus): RoomLifecyclePhase {
  switch (status) {
    case 'warmup':
      return 'lobby';
    case 'countdown':
      return 'countdown';
    case 'playing':
      return 'live';
    case 'intermission':
      return 'round-end';
    case 'complete':
      return 'match-end';
    default:
      return 'lobby';
  }
}

/** Fraction of connected players a lobby vote must reach to pass. */
export const VOTE_PASS_FRACTION = 0.7;

/**
 * Votes needed to pass: a 70% supermajority of the connected players (rounded up, min 1). For 2
 * players this is 2 (both); for 4 it is 3-of-4; for 0 connected it is 0 (a vote can never pass).
 */
export function votesRequiredForPass(connectedCount: number): number {
  if (connectedCount <= 0) return 0;
  return Math.max(1, Math.ceil(connectedCount * VOTE_PASS_FRACTION));
}

// --- Host-update validation -------------------------------------------------------------------

/**
 * Partial, host-supplied settings change. Only the fields a host can actually edit appear here; the
 * derived team shape is never sent (it follows `format`). `preset` lets the client request "apply the
 * recommended preset" in one message; any explicit field in the same patch overrides the preset.
 */
export interface RoomSettingsPatch {
  preset?: MatchPresetId;
  format?: MatchFormat;
  livesPerPlayer?: number;
  dodgeballCount?: number;
  maxLiveBallBounces?: number;
  matPreset?: number;
  roundCount?: number;
  halfCourtTimerSeconds?: number;
}

export type RoomSettingsRejectReason =
  | 'empty-patch'
  | 'invalid-preset'
  | 'invalid-format'
  | 'unsupported-team-size'
  | 'invalid-field';

export type RoomSettingsValidation =
  | { ok: true; settings: RoomSettings }
  | { ok: false; reason: RoomSettingsRejectReason };

const NUMERIC_PATCH_FIELDS = {
  livesPerPlayer: ROOM_SETTINGS_LIMITS.lives,
  dodgeballCount: ROOM_SETTINGS_LIMITS.dodgeballs,
  maxLiveBallBounces: ROOM_SETTINGS_LIMITS.bounces,
  roundCount: ROOM_SETTINGS_LIMITS.rounds,
  halfCourtTimerSeconds: ROOM_SETTINGS_LIMITS.halfCourtTimer
} as const satisfies Record<string, NumericLimit>;

function isStrictlyValidInt(value: unknown, limit: NumericLimit): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= limit.min &&
    value <= limit.max
  );
}

/**
 * STRICT validation of a host-supplied patch against the current settings. Unlike the canonicalizer,
 * this REJECTS out-of-range / malformed input instead of silently clamping it, so a bad request is a
 * clean, debuggable failure (and a buggy/hostile client can't smuggle a nonsense value through). On
 * success it returns the fully-resolved next RoomSettings (preset re-tagged via detectPresetId).
 *
 * Authority and phase gating (host check, "only between games") are enforced by the caller; this is
 * pure value validation so it can be unit-tested without a running room.
 */
export function validateRoomSettingsPatch(current: RoomSettings, patch: RoomSettingsPatch | undefined): RoomSettingsValidation {
  if (!patch || typeof patch !== 'object') return { ok: false, reason: 'empty-patch' };

  const keys = Object.keys(patch).filter((key) => patch[key as keyof RoomSettingsPatch] !== undefined);
  if (keys.length === 0) return { ok: false, reason: 'empty-patch' };

  let next: RoomSettings = { ...current };

  // A `preset` request rebases the whole config onto that recommended preset before other fields are
  // overlaid, so "apply 2v2 recommended" works in a single message.
  if (patch.preset !== undefined) {
    const presetFormat = formatForPreset(patch.preset);
    if (!presetFormat) return { ok: false, reason: 'invalid-preset' };
    next = recommendedRoomSettings(presetFormat);
  }

  if (patch.format !== undefined) {
    if (!isAllowedFormat(patch.format)) return { ok: false, reason: 'invalid-format' };
    if (teamShapeForFormat(patch.format).teamSize > MAX_ENABLED_TEAM_SIZE) {
      return { ok: false, reason: 'unsupported-team-size' };
    }
    next = { ...next, format: patch.format };
  }

  for (const field of Object.keys(NUMERIC_PATCH_FIELDS) as Array<keyof typeof NUMERIC_PATCH_FIELDS>) {
    const value = patch[field];
    if (value === undefined) continue;
    if (!isStrictlyValidInt(value, NUMERIC_PATCH_FIELDS[field])) return { ok: false, reason: 'invalid-field' };
    next = { ...next, [field]: value };
  }

  if (patch.matPreset !== undefined) {
    if (typeof patch.matPreset !== 'number' || !(ALLOWED_MAT_PRESETS as readonly number[]).includes(patch.matPreset)) {
      return { ok: false, reason: 'invalid-field' };
    }
    next = { ...next, matPreset: patch.matPreset };
  }

  return { ok: true, settings: { ...next, preset: detectPresetId(next) } };
}
