import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { HandSide, Vec3 } from '../types';
import { add, cross, lerp, normalize, scale, vec3 } from './CollisionMath';

export interface ThrowCalculationRequest {
  hand: HandSide;
  forward: Vec3;
  playerVelocity: Vec3;
  charge01: number;
  crouching: boolean;
  backflipTier?: number;
  fastDoubleThrowPenalty?: boolean;
}

export interface ThrowCalculationResult {
  velocity: Vec3;
  curveAccel: Vec3;
  dropScale: number;
  isSuper: boolean;
  charge01: number;
  speed: number;
}

/**
 * Deterministic curve acceleration for a crouch throw (Phase 6). A crouch throw curves SIDEWAYS
 * relative to the thrower's aim — not relative to world X/Z — so the curve is consistent from every
 * spawn side and facing direction. The curve direction is the horizontal vector perpendicular to
 * the aim forward, signed so the ball bends to the side OPPOSITE the throwing hand (a left-hand
 * crouch throw curves to the thrower's right, and vice-versa).
 *
 * Magnitude scales with charge so a quick crouch throw barely curves and a fully-charged one curves
 * hard: curveStrength = baseCurveStrength + maxCurveStrength * charge01^curveExponent (exponential,
 * not linear, so the curve stays subtle until charge is well past halfway). Backflip/super throws
 * never curve, regardless of crouch state.
 *
 * Both the server (authoritative throw) and the client (visual prediction) call this with the same
 * inputs, so the predicted path matches the simulated one. Returns a zero vector when not crouched
 * or when this is a super throw.
 */
export function curveAccelForThrow(
  forward: Vec3,
  hand: HandSide,
  crouching: boolean,
  charge01: number,
  isSuper: boolean,
  constants: GameConstants = GAME_CONSTANTS
): Vec3 {
  if (!crouching || isSuper) return vec3();
  // Horizontal right vector relative to aim: right = up x forward (normalized, flattened to XZ).
  const right = normalize(cross(vec3(0, 1, 0), forward), vec3(1, 0, 0));
  const flatRight = normalize(vec3(right.x, 0, right.z), vec3(1, 0, 0));
  // Curve toward the side opposite the throwing hand: left hand → +right, right hand → −right.
  const sign = hand === 'left' ? 1 : -1;
  const { baseCurveStrength, maxCurveStrength, curveExponent } = constants.ball;
  const normalizedCharge = Math.max(0, Math.min(1, charge01));
  const curveStrength = baseCurveStrength + maxCurveStrength * Math.pow(normalizedCharge, curveExponent);
  return scale(flatRight, sign * curveStrength);
}

/**
 * Shared throw calculation for offline practice, client prediction, and the authoritative server.
 * Keep every gameplay-affecting throw value here so a "charged/crouch/backflip throw" means the
 * same thing everywhere.
 */
export function calculateThrow(
  request: ThrowCalculationRequest,
  constants: GameConstants = GAME_CONSTANTS
): ThrowCalculationResult {
  const forward = normalize(request.forward, vec3(0, 0, 1));
  const charge01 = Math.max(0, Math.min(1, request.charge01));
  const backflipTier = Math.max(0, Math.trunc(request.backflipTier ?? 0));
  const isSuper = backflipTier >= 1;

  let speed = charge01 <= 0.05
    ? constants.ball.quickThrowSpeed
    : lerp(constants.ball.quickThrowSpeed, constants.ball.chargedThrowSpeed, charge01);

  if (request.fastDoubleThrowPenalty) {
    speed *= constants.ball.fastDoubleThrowPenalty;
  }

  if (isSuper) {
    speed = backflipQteSpeed(backflipTier, constants);
  }

  const velocity = add(
    scale(forward, speed),
    scale(request.playerVelocity, constants.ball.movementThrowScale)
  );
  const curveAccel = curveAccelForThrow(forward, request.hand, request.crouching, charge01, isSuper, constants);
  const dropScale = isSuper
    ? constants.ball.chargedDropScale
    : lerp(constants.ball.quickDropScale, constants.ball.chargedDropScale, charge01);

  return {
    velocity,
    curveAccel,
    dropScale,
    isSuper,
    charge01,
    speed
  };
}

/** True if `curveAccel` is non-trivial (used to tag throw events as curve throws for the client). */
export function isCurveThrow(curveAccel: Vec3): boolean {
  return curveAccel.x * curveAccel.x + curveAccel.y * curveAccel.y + curveAccel.z * curveAccel.z > 1e-6;
}

/**
 * Backflip landing quick-time event scoring (shared so client UI and server validation agree).
 *
 * `offset` is the click position along the timing bar as a signed fraction in [-1, 1], where 0 is
 * dead center and ±1 are the bar ends. Returns a success TIER from 1..tierCount (1 = slowest, near
 * the edge of the hit zone; tierCount = fastest, dead center), or 0 for a MISS (the click landed
 * outside the hit half-width, or the bar lapsed with no click). Tiers are concentric bands whose
 * widths come from `tierBandEdges` (non-uniform: a small center band, wider outer bands).
 */
export function backflipQteTier(offset: number, constants: GameConstants = GAME_CONSTANTS): number {
  const { hitHalfWidth, tierCount, tierBandEdges } = constants.backflip.qte;
  const mag = Math.abs(offset);
  if (mag > hitHalfWidth) return 0; // outside the hit zone → miss → no throw
  // Normalize the click into the hit zone [0, 1], then find the first band edge it falls within.
  // edge[0] bounds the top tier (center), the last edge is 1.0 (zone boundary).
  const norm = mag / hitHalfWidth;
  for (let i = 0; i < tierCount; i++) {
    if (norm <= tierBandEdges[i]) return tierCount - i; // band 0 (center) → top tier
  }
  return 1; // numerical guard: a click at the very edge → slowest tier
}

/**
 * Throw speed for a successful backflip QTE tier (1..tierCount). Tier 1 = a regular quick throw;
 * the top tier = the fastest backflip throw (10% above the legacy super). Returns quickThrowSpeed
 * for an out-of-range/zero tier as a safe floor.
 */
export function backflipQteSpeed(tier: number, constants: GameConstants = GAME_CONSTANTS): number {
  const mults = constants.backflip.qte.tierSpeedMultipliers;
  const idx = Math.max(1, Math.min(mults.length, Math.round(tier))) - 1;
  return constants.ball.quickThrowSpeed * mults[idx];
}

/** True if a QTE tier represents a successful (throwable) backflip throw. */
export function isBackflipQteHit(tier: number): boolean {
  return tier >= 1;
}
