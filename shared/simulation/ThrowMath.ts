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
