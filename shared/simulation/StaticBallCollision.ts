import { GAME_CONSTANTS } from '../constants';
import type { BallState } from '../types';
import { applyBallBounce, applyCannonBounce, applyMatBounce, markBallDead, type BounceRule } from './BallSim';
import { BLEACHER_LAYOUT, type AABB } from './MapGeometry';
/**
 * Resolve a ball against the arena bounds.
 *
 * Step 7 — the direct side walls (±X) and the ceiling (+Y) let a live/deflected ball SURVIVE one
 * bounce (for variety: you can play a ball off the wall once). The ball dies on its SECOND such
 * wall/ceiling bounce. Every OTHER surface keeps the original behavior of killing on the first
 * bounce: the floor (−Y) must NOT keep the ball alive, and the back walls (±Z) and static objects
 * (bleachers/mats, handled in resolveBallStaticBoxes) are unchanged. Dead/loose balls just reflect.
 */
export function resolveBallBounds(ball: BallState, bounceRule?: BounceRule): BallState {
  const r = GAME_CONSTANTS.ball.radius * (ball.kind === 'cannon' && ball.phase !== 'held' ? GAME_CONSTANTS.powerup.cannonFlightScale : 1);
  const e = GAME_CONSTANTS.ball.bounceRestitution;
  const minX = -GAME_CONSTANTS.map.halfWidth + r;
  const maxX = GAME_CONSTANTS.map.halfWidth - r;
  const minZ = -GAME_CONSTANTS.map.halfLength + r;
  const maxZ = GAME_CONSTANTS.map.halfLength - r;
  const maxY = GAME_CONSTANTS.map.wallHeight - r;
  const position = { ...ball.position };
  const velocity = { ...ball.velocity };
  // Side walls (±X) + ceiling (+Y): the ball may survive ONE of these bounces.
  let hitWallOrCeiling = false;
  // Floor (−Y) + back walls (±Z): kill on first bounce, exactly as before.
  let hitKillNow = false;

  if (position.y < r) {
    position.y = r;
    velocity.y = Math.abs(velocity.y) * e;
    hitKillNow = true;
  }
  if (position.y > maxY) {
    position.y = maxY;
    velocity.y = -Math.abs(velocity.y) * e;
    hitWallOrCeiling = true;
  }
  if (position.x < minX) {
    position.x = minX;
    velocity.x = Math.abs(velocity.x) * e;
    hitWallOrCeiling = true;
  } else if (position.x > maxX) {
    position.x = maxX;
    velocity.x = -Math.abs(velocity.x) * e;
    hitWallOrCeiling = true;
  }
  if (position.z < minZ) {
    position.z = minZ;
    velocity.z = Math.abs(velocity.z) * e;
    hitWallOrCeiling = true;
  } else if (position.z > maxZ) {
    position.z = maxZ;
    velocity.z = -Math.abs(velocity.z) * e;
    hitWallOrCeiling = true;
  }

  if (!hitWallOrCeiling && !hitKillNow) return ball;

  const resolved = { ...ball, position, velocity };
  // A floor / back-wall contact always wins (kills now). Otherwise it was a side-wall/ceiling-only
  // contact: let the ball survive its first such bounce, die on the second.
  if (hitKillNow) return applySurfaceKillingBounce(resolved, bounceRule);
  return applyWallCeilingBounce(resolved, bounceRule);
}

function applySurfaceKillingBounce(ball: BallState, bounceRule?: BounceRule): BallState {
  if (ball.phase !== 'live' && ball.phase !== 'deflected') {
    return { ...ball, bounceCount: ball.bounceCount + 1 };
  }
  // Cannonballs always die on floor contact, even when Frenzy gives ordinary balls infinite life.
  if (ball.kind === 'cannon') return { ...markBallDead(ball), bounceCount: ball.bounceCount + 1 };
  // Frenzy's unlimited rule keeps ordinary balls live even off the floor/back wall.
  if ((bounceRule?.deadAfterBounces ?? 0) >= Number.MAX_SAFE_INTEGER) return { ...ball, bounceCount: ball.bounceCount + 1 };
  return { ...markBallDead(ball), bounceCount: ball.bounceCount + 1 };
}

/**
 * Side-wall / ceiling bounce: a live/deflected ball survives its FIRST such bounce and dies on the
 * SECOND. Implemented by counting wall/ceiling bounces in bounceCount and only killing once the
 * count exceeds 1. Non-live phases just advance the count (mirrors applyBallBounce's tail).
 */
function applyWallCeilingBounce(ball: BallState, bounceRule?: BounceRule): BallState {
  if (ball.phase !== 'live' && ball.phase !== 'deflected') {
    return { ...ball, bounceCount: ball.bounceCount + 1 };
  }
  if (ball.kind === 'cannon') return applyCannonBounce(ball);
  const bounceCount = ball.bounceCount + 1;
  const deadAfterBounces = ball.phase === 'deflected'
    ? bounceRule?.deflectedDeadAfterBounces ?? GAME_CONSTANTS.ball.deflectedDeadAfterBounces
    : bounceRule?.deadAfterBounces ?? GAME_CONSTANTS.ball.deadAfterBounces;
  if (bounceCount > deadAfterBounces) {
    return { ...markBallDead(ball), bounceCount };
  }
  return { ...ball, bounceCount };
}

export function resolveBallStaticBoxes(ball: BallState, boxes: AABB[], logger?: (message: string) => void, bounceRule?: BounceRule): BallState {
  const r = GAME_CONSTANTS.ball.radius * (ball.kind === 'cannon' && ball.phase !== 'held' ? GAME_CONSTANTS.powerup.cannonFlightScale : 1);
  const e = GAME_CONSTANTS.ball.bounceRestitution;
  const position = { ...ball.position };
  const velocity = { ...ball.velocity };
  let bounced = false;
  let hitBox: AABB | null = null;
  let hitAxis: 'x' | 'y' | 'z' | null = null;

  for (const box of boxes) {
    if (position.x < box.minX - r || position.x > box.maxX + r) continue;
    if (position.y < box.minY - r || position.y > box.maxY + r) continue;
    if (position.z < box.minZ - r || position.z > box.maxZ + r) continue;

    // The side bleachers form the low side-wall lane. For a horizontal BANK SHOT (|vx| ≥ |vy|) model
    // the stepped tiers as a single FLAT vertical side wall: reflect in X back toward the court and
    // survive one bounce, whether the discrete step grazed a tier front face (X) or a step top (Y).
    // Without this, a low bank shot that clips a (taller) step top reflects upward and dies on the
    // first bounce instead of banking — see isSideWallLikeStaticBounce / the side-wall one-bounce
    // rule. Vertical drops onto the bleachers (|vy| > |vx|) fall through to the normal per-axis bounce.
    if (box.kind === 'bleacher' && box.id?.startsWith('bleacher_tier_') === true && Math.abs(velocity.x) >= Math.abs(velocity.y)) {
      position.x = sideBleacherCourtFaceX(box);
      velocity.x = ((box.minX + box.maxX) * 0.5 >= 0 ? -1 : 1) * Math.abs(velocity.x) * e;
      hitAxis = 'x';
      bounced = true;
      hitBox = box;
      break;
    }

    const penX = Math.min(position.x - (box.minX - r), (box.maxX + r) - position.x);
    const penY = Math.min(position.y - (box.minY - r), (box.maxY + r) - position.y);
    const penZ = Math.min(position.z - (box.minZ - r), (box.maxZ + r) - position.z);

    if (penX <= penY && penX <= penZ) {
      position.x = position.x < (box.minX + box.maxX) * 0.5 ? box.minX - r : box.maxX + r;
      velocity.x = (position.x < (box.minX + box.maxX) * 0.5 ? -1 : 1) * Math.abs(velocity.x) * e;
      hitAxis = 'x';
    } else if (penY <= penZ) {
      position.y = position.y < (box.minY + box.maxY) * 0.5 ? box.minY - r : box.maxY + r;
      velocity.y = (position.y < (box.minY + box.maxY) * 0.5 ? -1 : 1) * Math.abs(velocity.y) * e;
      hitAxis = 'y';
    } else {
      position.z = position.z < (box.minZ + box.maxZ) * 0.5 ? box.minZ - r : box.maxZ + r;
      velocity.z = (position.z < (box.minZ + box.maxZ) * 0.5 ? -1 : 1) * Math.abs(velocity.z) * e;
      hitAxis = 'z';
    }

    bounced = true;
    hitBox = box;
    if (isSideWallLikeStaticBounce(hitBox, hitAxis)) {
      position.x = sideBleacherCourtFaceX(hitBox);
      break;
    }
  }

  if (!bounced) return ball;
  const resolvedBall = { ...ball, position, velocity };
  // A mat (standing cover OR a fallen mat lying flat) reflects the ball but keeps it live; the side
  // bleachers act like a side wall (survive one); everything else dies on first bounce as before.
  const resolved = ball.kind === 'cannon'
    ? applyCannonBounce(resolvedBall)
    : isSideWallLikeStaticBounce(hitBox, hitAxis)
      ? applyWallCeilingBounce(resolvedBall, bounceRule)
      : hitBox?.kind === 'mat'
        ? applyMatBounce(resolvedBall)
        : applyBallBounce(resolvedBall, bounceRule);
  if (hitBox?.kind === 'bleacher') {
    logger?.(
      `bleacher collision ball=${ball.id} box=${hitBox.id ?? 'unknown'}` +
      ` axis=${hitAxis ?? 'unknown'}` +
      ` pos=(${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)})` +
      ` vel=(${velocity.x.toFixed(2)},${velocity.y.toFixed(2)},${velocity.z.toFixed(2)})`
    );
  }
  return resolved;
}

function isSideWallLikeStaticBounce(box: AABB | null, axis: 'x' | 'y' | 'z' | null): boolean {
  // In the actual gym, the side bleachers occupy the low side-wall lane. A low bank shot hits
  // those X faces before it can reach the arena bounds, so classify that impact like a side wall.
  return axis === 'x' && box?.kind === 'bleacher' && box.id?.startsWith('bleacher_tier_') === true;
}

const SIDE_BLEACHER_COURT_FACE_X =
  GAME_CONSTANTS.map.halfWidth -
  BLEACHER_LAYOUT.wallInset -
  BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRun -
  GAME_CONSTANTS.ball.radius;

function sideBleacherCourtFaceX(box: AABB): number {
  const centerX = (box.minX + box.maxX) * 0.5;
  return centerX >= 0 ? SIDE_BLEACHER_COURT_FACE_X : -SIDE_BLEACHER_COURT_FACE_X;
}
