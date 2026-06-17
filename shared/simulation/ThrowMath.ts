import { GAME_CONSTANTS, type GameConstants } from '../constants';
import type { HandSide, Vec3 } from '../types';
import { cross, normalize, scale, vec3 } from './CollisionMath';

/**
 * Deterministic curve acceleration for a crouch throw (Phase 6). A crouch throw curves SIDEWAYS
 * relative to the thrower's aim — not relative to world X/Z — so the curve is consistent from every
 * spawn side and facing direction. The curve direction is the horizontal vector perpendicular to
 * the aim forward, signed so the ball bends to the side OPPOSITE the throwing hand (a left-hand
 * crouch throw curves to the thrower's right, and vice-versa). Magnitude is `ball.curveStrength`.
 *
 * Both the server (authoritative throw) and the client (visual prediction) call this with the same
 * inputs, so the predicted path matches the simulated one. Returns a zero vector when not crouched.
 */
export function curveAccelForThrow(
  forward: Vec3,
  hand: HandSide,
  crouching: boolean,
  constants: GameConstants = GAME_CONSTANTS
): Vec3 {
  if (!crouching) return vec3();
  // Horizontal right vector relative to aim: right = up x forward (normalized, flattened to XZ).
  const right = normalize(cross(vec3(0, 1, 0), forward), vec3(1, 0, 0));
  const flatRight = normalize(vec3(right.x, 0, right.z), vec3(1, 0, 0));
  // Curve toward the side opposite the throwing hand: left hand → +right, right hand → −right.
  const sign = hand === 'left' ? 1 : -1;
  return scale(flatRight, sign * constants.ball.curveStrength);
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
