import { Mesh, Vector3 } from '@babylonjs/core';
import { BallOwner, BallState, HandSide } from './BallState';
import { TUNING } from '../config/tuning';
import { CollisionWorld } from '../map/Collider';
import { BLEACHER_LAYOUT } from '../../../shared/simulation/MapGeometry';

let nextBallId = 1;

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

  // The mesh is the ball's VISUAL, created by the ModelLoader and injected here. Gameplay
  // (state machine, physics, collision radius) is independent of it.
  constructor(public readonly mesh: Mesh, position: Vector3, private readonly onImpact?: (speed: number) => void) {
    this.mesh.position.copyFrom(position);
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
    // Crouch curve: sideways accel only bends the live ball's first flight.
    if (firstFlight) {
      this.velocity.x += this.curveAccel.x * dt;
      this.velocity.z += this.curveAccel.z * dt;
    }
    // Scalar integrate (no temp Vector3 from .scale) — runs for every ball every frame.
    this.mesh.position.x += this.velocity.x * dt;
    this.mesh.position.y += this.velocity.y * dt;
    this.mesh.position.z += this.velocity.z * dt;

    this.resolveSimpleBounds();
    if (collision) this.resolveBoxCollisions(collision);

    if (this.state === BallState.Dead && this.velocity.length() < 0.2) {
      this.state = BallState.Loose;
      this.velocity.setAll(0);
    }
  }

  private resolveSimpleBounds(): void {
    const p = this.mesh.position;
    const r = TUNING.ball.radius;
    const minX = -TUNING.map.halfWidth + r;
    const maxX = TUNING.map.halfWidth - r;
    const minZ = -TUNING.map.halfLength + r;
    const maxZ = TUNING.map.halfLength - r;
    const maxY = TUNING.map.wallHeight - r;

    if (p.y < r) {
      const normalImpactSpeed = Math.abs(this.velocity.y);
      p.y = r;
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
      if (hitAxis === 'x' && b.kind === 'bleacher') {
        p.x = sideBleacherCourtFaceX(b);
        this.onWallCeilingBounce(normalImpactSpeed);
        break;
      }
      this.onBounce(normalImpactSpeed);
    }
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

    this.emitImpact(normalImpactSpeed);
    this.bounceCount += 1;
    if (this.bounceCount > 1) {
      this.makeDead();
    }
  }

  private emitImpact(normalImpactSpeed: number): void {
    if (!this.onImpact || normalImpactSpeed <= 0) return;
    const reboundSpeed = normalImpactSpeed * TUNING.ball.bounceRestitution;
    const reboundHeight = (reboundSpeed * reboundSpeed) / (2 * TUNING.ball.gravity);
    if (reboundHeight < TUNING.ball.impactSoundMinBounceHeight) return;
    this.onImpact(Math.max(4, normalImpactSpeed));
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
