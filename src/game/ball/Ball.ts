import { Mesh, Vector3 } from '@babylonjs/core';
import { BallOwner, BallState, HandSide } from './BallState';
import { TUNING } from '../config/tuning';
import { CollisionWorld } from '../map/Collider';
import { BLEACHER_LAYOUT } from '../../../shared/simulation/MapGeometry';
import { GAME_CONSTANTS } from '../../../shared/constants';
import { curveRampFactor } from '../../../shared/simulation/BallSim';

let nextBallId = 1;
const IMPACT_SQUASH_MIN_SPEED = 8;
const IMPACT_SQUASH_SPEED_RANGE = 22;

/**
 * Optional world override for the OFFLINE ball only (the Creator sandbox / Movement Course yard uses
 * it). It replaces the default GYM world: the simple bounds bounce uses these XZ bounds, floor and
 * ceiling, and `collision` replaces the gym's ball collision boxes.
 *
 * Without it, a ball in the yard is unplayable: the yard sits at x≈800 (SANDBOX_CENTER) while the
 * default bounds are the gym's own halfWidth 13 / halfLength 18 / wallHeight 8.5, so a ball spawned
 * from a Creator `ball_spawn` marker was clamped ~787m back into the gym on its very first frame —
 * registering a bounce, going Dead→Loose, and coming to rest inside the gym bleachers, silently.
 *
 * This mirrors MovementController's MovementWorld exactly, including the isolation guarantee: when
 * null (normal gym practice, the debug launcher, bots, tests) every path is byte-for-byte unchanged,
 * and no online path can reach it — online balls run shared/simulation/BallSim on the server.
 */
export interface BallWorld {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Bounce ceiling (world Y). */
  ceilingY: number;
  /** Walkable floor height. The gym's is 0; a Creator course's is layout.ground.bounds.y. */
  floorY: number;
  /** Boxes the ball resolves against — the course's own colliders, not the gym's. */
  collision: CollisionWorld;
}

export class Ball {
  public readonly id = nextBallId++;
  public state = BallState.Loose;
  public velocity = Vector3.Zero();
  public owner: BallOwner = null;
  public heldHand: HandSide | null = null;
  public bounceCount = 0;
  public isSuper = false;
  // Gravity multiplier applied during the first flight (Live, pre-bounce). Set per throw:
  // ~0 = flies straight (charged/super), higher = projectile drop (quick throw). After a
  // bounce the ball uses full gravity regardless so it settles into a loose ball.
  public dropScale = 1;
  // Sustained sideways acceleration (world space) for crouch curve throws; applied only
  // during the first live flight. Zero for straight throws.
  public curveAccel = Vector3.Zero();
  // Meters traveled since this throw's first live flight began; gates the curve start/ramp.
  public curveDistance = 0;
  // Visual-only state updated by BallManager. These never feed back into gameplay physics.
  public visualTrailTimer = 0;
  public impactPulse = 0;
  // Offline-only world override (Creator sandbox / yard). Null = the default gym world, unchanged.
  private world: BallWorld | null = null;

  // The mesh is the ball's VISUAL, created by the ModelLoader and injected here. Gameplay
  // (state machine, physics, collision radius) is independent of it.
  constructor(
    public readonly mesh: Mesh,
    position: Vector3,
    private readonly onImpact?: (speed: number, bounceCount: number, position: Vector3) => void
  ) {
    this.mesh.position.copyFrom(position);
  }

  /** Offline only: install (or clear with null) a world override for the Creator sandbox / yard. */
  setWorld(world: BallWorld | null): void {
    this.world = world;
  }

  /** Height of the surface a resting ball settles on — the world's floor, or the gym's y=0. */
  private floorY(): number {
    return this.world?.floorY ?? 0;
  }

  /**
   * Put the ball back at `position`, at rest and fully re-armed (Loose, no velocity, no bounce
   * history, not super, no curve). Used to return Creator balls to their spawn markers when a
   * playtest or timed run restarts, so every attempt begins identically.
   */
  reset(position: Vector3): void {
    this.state = BallState.Loose;
    this.owner = null;
    this.heldHand = null;
    this.mesh.position.copyFrom(position);
    this.velocity.setAll(0);
    this.bounceCount = 0;
    this.isSuper = false;
    this.dropScale = 1;
    this.curveDistance = 0;
    this.curveAccel.setAll(0);
    this.impactPulse = 0;
    this.visualTrailTimer = 0;
  }

  setHeld(hand: HandSide): void {
    this.state = BallState.Held;
    this.owner = 'player';
    this.heldHand = hand;
    this.velocity.setAll(0);
    this.bounceCount = 0;
    this.isSuper = false;
    this.dropScale = 1;
  }

  throw(owner: BallOwner, velocity: Vector3, isSuper: boolean, dropScale = 1, curveAccel?: Vector3): void {
    this.state = BallState.Live;
    this.owner = owner;
    this.heldHand = null;
    this.velocity.copyFrom(velocity);
    this.bounceCount = 0;
    this.isSuper = isSuper;
    this.dropScale = dropScale;
    this.curveDistance = 0;
    if (curveAccel) this.curveAccel.copyFrom(curveAccel);
    else this.curveAccel.setAll(0);
  }

  drop(position: Vector3, velocity = new Vector3(0, -1.4, 0)): void {
    this.state = BallState.Dead;
    this.owner = null;
    this.heldHand = null;
    this.isSuper = false;
    this.bounceCount = 1;
    this.velocity.copyFrom(velocity);
    this.mesh.position.copyFrom(position);
  }

  makeDead(): void {
    this.state = BallState.Dead;
    this.owner = null;
    this.heldHand = null;
    this.isSuper = false;
  }

  update(dt: number, collision?: CollisionWorld): void {
    if (this.state !== BallState.Live && this.state !== BallState.Dead && this.state !== BallState.Loose) return;

    const firstFlight = this.state === BallState.Live && this.bounceCount === 0;
    const gravityScale = firstFlight ? this.dropScale : 1;
    this.velocity.y -= TUNING.ball.gravity * gravityScale * dt;
    // Crouch curve: sideways accel only bends the live ball's first flight, ramped in by
    // curveRampFactor (flat zero until curveStartDistance, smoothstep up to full strength).
    if (firstFlight) {
      const rampFactor = curveRampFactor(this.curveDistance, GAME_CONSTANTS);
      this.velocity.x += this.curveAccel.x * rampFactor * dt;
      this.velocity.z += this.curveAccel.z * rampFactor * dt;
    }
    if ((this.state === BallState.Dead || this.state === BallState.Loose)
      && this.mesh.position.y <= this.floorY() + TUNING.ball.radius + 0.05) {
      const frictionFactor = Math.max(0, 1 - TUNING.ball.looseFriction * dt);
      this.velocity.x *= frictionFactor;
      this.velocity.z *= frictionFactor;
    }
    // Scalar integrate (no temp Vector3 from .scale) — runs for every ball every frame.
    this.mesh.position.x += this.velocity.x * dt;
    this.mesh.position.y += this.velocity.y * dt;
    this.mesh.position.z += this.velocity.z * dt;
    if (firstFlight) {
      this.curveDistance += Math.sqrt(
        this.velocity.x * this.velocity.x + this.velocity.y * this.velocity.y + this.velocity.z * this.velocity.z
      ) * dt;
    }

    this.resolveSimpleBounds();
    // The override's boxes REPLACE the gym's: a Creator ball must resolve against the course's own
    // floors/walls (the caller passes the gym's ball-collision world, which holds none of them).
    const boxes = this.world?.collision ?? collision;
    if (boxes) this.resolveBoxCollisions(boxes);

    if (this.state === BallState.Dead && this.velocity.length() < 0.2) {
      this.state = BallState.Loose;
      this.velocity.setAll(0);
    }
  }

  private resolveSimpleBounds(): void {
    const p = this.mesh.position;
    const r = TUNING.ball.radius;
    // The world override (Creator yard) or the gym. Getting this wrong is not a subtle bug: the yard
    // is ~800m from the gym, so the gym's bounds don't merely misbehave there, they teleport the ball.
    const w = this.world;
    const minX = (w ? w.minX : -TUNING.map.halfWidth) + r;
    const maxX = (w ? w.maxX : TUNING.map.halfWidth) - r;
    const minZ = (w ? w.minZ : -TUNING.map.halfLength) + r;
    const maxZ = (w ? w.maxZ : TUNING.map.halfLength) - r;
    const maxY = (w ? w.ceilingY : TUNING.map.wallHeight) - r;
    const floor = this.floorY();

    if (p.y < floor + r) {
      const normalImpactSpeed = Math.abs(this.velocity.y);
      p.y = floor + r;
      this.velocity.y = Math.abs(this.velocity.y) * TUNING.ball.bounceRestitution;
      this.onBounce(normalImpactSpeed);
    }

    if (p.y > maxY) {
      const normalImpactSpeed = Math.abs(this.velocity.y);
      p.y = maxY;
      this.velocity.y = -Math.abs(this.velocity.y) * TUNING.ball.bounceRestitution;
      this.onWallCeilingBounce(normalImpactSpeed);
    }

    if (p.x < minX || p.x > maxX) {
      const normalImpactSpeed = Math.abs(this.velocity.x);
      p.x = Math.max(minX, Math.min(maxX, p.x));
      this.velocity.x *= -TUNING.ball.bounceRestitution;
      this.onWallCeilingBounce(normalImpactSpeed);
    }

    if (p.z < minZ || p.z > maxZ) {
      const normalImpactSpeed = Math.abs(this.velocity.z);
      p.z = Math.max(minZ, Math.min(maxZ, p.z));
      this.velocity.z *= -TUNING.ball.bounceRestitution;
      this.onWallCeilingBounce(normalImpactSpeed);
    }
  }

  // Bounce the ball off solid map AABBs (mats act as cover, bleachers as obstacles).
  // The ball is treated as a point against each box expanded by its radius, resolving on
  // the shallowest axis. A hit counts as a bounce, so a blocked live ball goes dead/loose.
  private resolveBoxCollisions(collision: CollisionWorld): void {
    const r = TUNING.ball.radius;
    const p = this.mesh.position;
    const e = TUNING.ball.bounceRestitution;

    for (const b of collision.boxes) {
      if (b.enabled === false) continue; // trigger-disabled: intangible this frame
      if (p.x < b.minX - r || p.x > b.maxX + r) continue;
      if (p.y < b.minY - r || p.y > b.maxY + r) continue;
      if (p.z < b.minZ - r || p.z > b.maxZ + r) continue;
      const penX = Math.min(p.x - (b.minX - r), (b.maxX + r) - p.x);
      const penY = Math.min(p.y - (b.minY - r), (b.maxY + r) - p.y);
      const penZ = Math.min(p.z - (b.minZ - r), (b.maxZ + r) - p.z);
      let normalImpactSpeed = 0;
      let hitAxis: 'x' | 'y' | 'z';

      if (penX <= penY && penX <= penZ) {
        normalImpactSpeed = Math.abs(this.velocity.x);
        p.x = p.x < (b.minX + b.maxX) * 0.5 ? b.minX - r : b.maxX + r;
        this.velocity.x *= -e;
        hitAxis = 'x';
      } else if (penY <= penZ) {
        normalImpactSpeed = Math.abs(this.velocity.y);
        p.y = p.y < (b.minY + b.maxY) * 0.5 ? b.minY - r : b.maxY + r;
        this.velocity.y *= -e;
        hitAxis = 'y';
      } else {
        normalImpactSpeed = Math.abs(this.velocity.z);
        p.z = p.z < (b.minZ + b.maxZ) * 0.5 ? b.minZ - r : b.maxZ + r;
        this.velocity.z *= -e;
        hitAxis = 'z';
      }
      if (hitAxis === 'x' && b.kind === 'bleacher' && b.id?.startsWith('bleacher_tier_') === true) {
        p.x = sideBleacherCourtFaceX(b);
        this.onWallCeilingBounce(normalImpactSpeed);
        break;
      }
      if (b.kind === 'mat') {
        // A mat (standing cover OR a fallen mat on the floor) reflects the ball but never kills it:
        // a Live ball stays Live. Mirrors the server's applyMatBounce so practice matches online.
        this.onMatBounce(normalImpactSpeed);
        continue;
      }
      this.onBounce(normalImpactSpeed);
    }
  }

  private onMatBounce(normalImpactSpeed: number): void {
    this.bounceCount += 1;
    this.emitImpact(normalImpactSpeed);
  }

  private onBounce(normalImpactSpeed: number): void {
    this.bounceCount += 1;
    this.emitImpact(normalImpactSpeed);
    if (this.bounceCount >= TUNING.ball.deadAfterBounces) {
      this.makeDead();
    }
  }

  private onWallCeilingBounce(normalImpactSpeed: number): void {
    if (this.state !== BallState.Live) {
      this.onBounce(normalImpactSpeed);
      return;
    }

    this.bounceCount += 1;
    this.emitImpact(normalImpactSpeed);
    if (this.bounceCount > 1) {
      this.makeDead();
    }
  }

  private emitImpact(normalImpactSpeed: number): void {
    if (normalImpactSpeed <= 0) return;
    if (normalImpactSpeed >= IMPACT_SQUASH_MIN_SPEED) {
      const pulse = Math.min(0.55, (normalImpactSpeed - IMPACT_SQUASH_MIN_SPEED) / IMPACT_SQUASH_SPEED_RANGE);
      this.impactPulse = Math.max(this.impactPulse, pulse);
    }
    if (!this.onImpact) return;
    const reboundSpeed = normalImpactSpeed * TUNING.ball.bounceRestitution;
    const reboundHeight = (reboundSpeed * reboundSpeed) / (2 * TUNING.ball.gravity);
    if (reboundHeight < TUNING.ball.impactSoundMinBounceHeight) return;
    this.onImpact(Math.max(4, normalImpactSpeed), this.bounceCount, this.mesh.position);
  }
}

const SIDE_BLEACHER_COURT_FACE_X =
  TUNING.map.halfWidth -
  BLEACHER_LAYOUT.wallInset -
  BLEACHER_LAYOUT.tierCount * BLEACHER_LAYOUT.tierRun -
  TUNING.ball.radius;

function sideBleacherCourtFaceX(box: { minX: number; maxX: number }): number {
  const centerX = (box.minX + box.maxX) * 0.5;
  return centerX >= 0 ? SIDE_BLEACHER_COURT_FACE_X : -SIDE_BLEACHER_COURT_FACE_X;
}
