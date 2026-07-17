/**
 * Wall-bounce — the ONE implementation of the head-on spring jump off a wall.
 *
 * Both movement paths call this, so the rule can never drift between them again:
 *   - online / authoritative: shared/simulation/MovementSim.ts (server + client prediction);
 *   - offline: src/game/player/MovementController.ts (gym practice + the Creator sandbox/yard).
 *
 * Only the SURFACE QUERY differs between the two. Online bounces off the four gym perimeter planes;
 * the offline Creator world bounces off the course's authored wall faces. Everything downstream of
 * "here is the outward normal of the wall you're near" — the entry gate and the impulse — lives here.
 *
 * ## The approach-velocity contract (this is why the rule used to be unreliable offline)
 *
 * Both the gate and the impulse magnitude read the velocity moving INTO the wall. Online that is
 * simply the live velocity: the gym perimeter is a POSITION clamp (MovementSim clamps px/pz and
 * never touches vx/vz), so a player pinned against a wall still carries their full into-wall speed
 * and the bounce fires for as long as they're in range.
 *
 * Offline, course walls are collision boxes, and push-out ZEROES the into-wall velocity component
 * (MovementController.resolveCollisions). Feeding that post-collision velocity in here made the gate
 * read `intoWall ≈ 0` and refuse — so a bounce only fired in the 1–2 frame window between entering
 * the detect margin and actually touching the wall, which played as "wall bounce works sometimes".
 *
 * So callers MUST pass the velocity as it was BEFORE this frame's collision push-out. Online that is
 * the live velocity (nothing removed it); offline it is the value captured ahead of resolveCollisions.
 * Passing a post-push-out velocity is the bug this contract exists to prevent.
 */

export interface WallBounceConstants {
  runTriggerAngleDegrees: number;
  minEntrySpeed: number;
  bounceBaseAwaySpeed: number;
  bounceAwayGain: number;
  bounceBaseUpSpeed: number;
  bounceUpGain: number;
  bounceMaxApproachSpeed: number;
}

const DEG2RAD = Math.PI / 180;

/**
 * Is the approach into a wall of outward normal (nx,nz) steep and fast enough to bounce?
 *
 * The angle split is the whole rule: a shallow approach belongs to the WALL-RUN (which owns the jump
 * key there), and only an approach steeper than `runTriggerAngleDegrees` off parallel bounces. There
 * is deliberately ONE threshold — a surface-dependent threshold is what made bounces feel arbitrary.
 *
 * `vx`/`vz` must satisfy the approach-velocity contract in the file header.
 */
export function wallBounceAllowed(
  vx: number,
  vz: number,
  nx: number,
  nz: number,
  c: WallBounceConstants
): boolean {
  const horizSpeed = Math.hypot(vx, vz);
  if (horizSpeed < c.minEntrySpeed) return false;
  // intoWall: 1 = straight at the wall, 0 = parallel, negative = moving away.
  const intoWall = -(vx * nx + vz * nz) / horizSpeed;
  return intoWall > Math.sin(c.runTriggerAngleDegrees * DEG2RAD);
}

/**
 * The post-bounce velocity: reflect the into-wall component away from the wall and set a fresh
 * upward kick, both = base + approachSpeed * gain, so the harder you come in the farther and higher
 * you leave. Along-wall (tangential) momentum is preserved. `approach` is clamped by
 * `bounceMaxApproachSpeed` so a hard dash-in can't fling you absurdly.
 *
 * `speedScale` scales only the BASE terms (the room's movement scale); the gain terms already scale
 * with the approach speed. Offline passes 1.
 *
 * `vx`/`vz` must satisfy the approach-velocity contract in the file header — the tangential component
 * that survives into the result is taken from them.
 */
export function wallBounceVelocity(
  vx: number,
  vy: number,
  vz: number,
  nx: number,
  nz: number,
  c: WallBounceConstants,
  speedScale = 1
): { x: number; y: number; z: number } {
  const vn = vx * nx + vz * nz; // along the outward normal; negative = into the wall
  const approach = Math.min(c.bounceMaxApproachSpeed, Math.max(0, -vn));
  const tx = vx - vn * nx; // along-wall component, preserved
  const tz = vz - vn * nz;
  const outward = c.bounceBaseAwaySpeed * speedScale + approach * c.bounceAwayGain;
  const up = c.bounceBaseUpSpeed * speedScale + approach * c.bounceUpGain;
  return {
    x: tx + nx * outward,
    y: Math.max(vy, up),
    z: tz + nz * outward
  };
}
