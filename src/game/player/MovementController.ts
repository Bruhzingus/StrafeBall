import { FreeCamera, TransformNode, Vector3 } from '@babylonjs/core';
import { CONTROL_KEYS } from '../config/controls';
import { TUNING } from '../config/tuning';
import { InputManager } from '../input/InputManager';
import { safeNormalize, DEG2RAD } from '../utils/math';
import { airStrafeWishDirection, movementWishDirection, yawForward } from '../utils/vector';
import { DashController } from './DashController';
import { BackflipController } from './BackflipController';
import { CollisionWorld } from '../map/Collider';

export type FrictionMode = 'air' | 'normal' | 'slide' | 'dashSuppressed';

export interface MovementSnapshot {
  position: Vector3;
  velocity: Vector3;
  grounded: boolean;
  sliding: boolean;
  crouching: boolean;
  wallRunning: boolean;
  wallNormal: Vector3;
  dashingThisFrame: boolean;
  speed: number;
  bhopGraceTimer: number;
  wallRunTimer: number;
  frictionMode: FrictionMode;
}

export class MovementController {
  public velocity = Vector3.Zero();
  public grounded = true;
  public sliding = false;
  public crouching = false;
  public wallRunning = false;
  public dashingThisFrame = false;

  private slideTimer = 0;
  private jumpGraceTimer = 0;
  private wallRunTimer = 0;
  private wallReattachCooldown = 0;
  private doubleJumpAvailable = true;
  private catchBoostTimer = 0;
  // Counts down after a dash; while > 0 ground friction is suppressed so the burst carries.
  private dashActiveTimer = 0;
  // Height of the surface currently under the player's feet (floor = 0, or a bleacher/mat
  // top). Recomputed each tick by collision resolution and used as the "ground" level.
  private groundHeight = 0;
  // Normal (pointing into the court) of the wall currently being run on; drives wall-jump.
  private lastWallNormal = Vector3.Zero();
  private catchRecoilOffset = 0;
  private slideHoldActive = false;

  constructor(
    private readonly root: TransformNode,
    private readonly camera: FreeCamera,
    private readonly dash: DashController,
    private readonly backflip: BackflipController,
    private readonly collision: CollisionWorld
  ) {}

  update(dt: number, input: InputManager, catchStanceActive: boolean): MovementSnapshot {
    this.dashingThisFrame = false;
    this.crouching = input.isKeyDown(CONTROL_KEYS.crouch) || input.isKeyDown(CONTROL_KEYS.crouchAlt);
    this.slideHoldActive = input.isKeyDown(CONTROL_KEYS.slide) || this.crouching;
    this.tickVisualFeedback(dt);

    const moveX = (input.isKeyDown(CONTROL_KEYS.right) ? 1 : 0) - (input.isKeyDown(CONTROL_KEYS.left) ? 1 : 0);
    const moveZ = (input.isKeyDown(CONTROL_KEYS.forward) ? 1 : 0) - (input.isKeyDown(CONTROL_KEYS.backward) ? 1 : 0);
    const wishDir = movementWishDirection(this.root.rotation.y, moveX, moveZ);
    const airWishDir = airStrafeWishDirection(this.root.rotation.y, moveX);

    this.updateGroundState();
    this.updateTimers(dt);
    this.tryStartSlide(input, wishDir);
    this.tryJump(input, wishDir);
    this.tryDash(input, wishDir);
    this.tryBackflip(input);
    this.tryWallRun(dt);

    // Friction first (Quake/Source order), then acceleration toward the wish direction, so
    // friction doesn't immediately eat the speed we just added.
    this.applyFriction(dt);

    const speedMultiplier =
      (catchStanceActive ? TUNING.player.catchStanceSpeedMultiplier : 1) + (this.catchBoostTimer > 0 ? 0.1 : 0);

    if (this.grounded) {
      // Ground: accelerate up to the (possibly slowed) walk speed. Excess speed carried in
      // from bhop/slide isn't removed by accelerate — friction (above) bleeds it on non-jump frames.
      const brakingSlide =
        this.sliding && this.slideHoldActive && this.slideTimer >= TUNING.slide.overholdBrakeDelay;
      const groundWishSpeed = brakingSlide || (this.crouching && !this.sliding)
        ? TUNING.player.crouchWalkSpeed
        : TUNING.player.maxGroundSpeed * speedMultiplier;
      this.accelerate(wishDir, groundWishSpeed, TUNING.player.groundAcceleration, dt);
    } else {
      // CS-style air-strafe: A/D are the air-control keys. W/S preserves momentum but does not add
      // forward/back air acceleration, so speed comes from mouse-turning with side input.
      this.accelerate(airWishDir, TUNING.player.airStrafeMaxSpeed, TUNING.player.airAcceleration, dt);
    }

    this.applyGravity(dt);
    this.applySoftSpeedLimit(dt);
    this.applyCrouchWalkSpeedLimit();

    // Integrate position (scalar to avoid allocating a temp vector every frame).
    this.root.position.x += this.velocity.x * dt;
    this.root.position.y += this.velocity.y * dt;
    this.root.position.z += this.velocity.z * dt;
    this.clampToGymBounds();
    this.resolveCollisions();
    this.applyCameraHeight();

    return this.snapshot();
  }

  addCatchBoost(): void {
    const forward = yawForward(this.root.rotation.y);
    this.velocity.addInPlace(forward.scale(TUNING.catch.catchBoostSpeed));
    this.catchBoostTimer = TUNING.catch.catchBoostDuration;
  }

  addCatchRecoil(incomingVelocity: Vector3): void {
    const horizontalSpeed = Math.hypot(incomingVelocity.x, incomingVelocity.z);
    if (horizontalSpeed < TUNING.catch.momentumRecoilMinSpeed) return;
    const range = Math.max(0.001, TUNING.catch.momentumRecoilMaxSpeed - TUNING.catch.momentumRecoilMinSpeed);
    const strength = Math.max(0, Math.min(1, (horizontalSpeed - TUNING.catch.momentumRecoilMinSpeed) / range));
    const distance =
      TUNING.catch.momentumRecoilMinDistance +
      (TUNING.catch.momentumRecoilMaxDistance - TUNING.catch.momentumRecoilMinDistance) * strength;
    this.catchRecoilOffset = Math.max(this.catchRecoilOffset, distance);
  }

  tickVisualFeedback(dt: number): void {
    if (this.catchRecoilOffset > 0) {
      const decay = Math.exp(-dt / TUNING.catch.momentumRecoilDuration);
      this.catchRecoilOffset *= decay;
      if (this.catchRecoilOffset < 0.002) this.catchRecoilOffset = 0;
    }
    this.camera.position.z = -this.catchRecoilOffset;
  }

  private updateTimers(dt: number): void {
    this.dash.update(dt);
    this.backflip.update(dt);

    if (this.jumpGraceTimer > 0) this.jumpGraceTimer = Math.max(0, this.jumpGraceTimer - dt);
    if (this.wallReattachCooldown > 0) this.wallReattachCooldown = Math.max(0, this.wallReattachCooldown - dt);
    if (this.catchBoostTimer > 0) this.catchBoostTimer = Math.max(0, this.catchBoostTimer - dt);
    if (this.dashActiveTimer > 0) this.dashActiveTimer = Math.max(0, this.dashActiveTimer - dt);
    if (this.sliding) {
      this.slideTimer += dt;
      const speed = this.horizontalSpeed();
      const tooSlow = speed < TUNING.slide.minStartSpeed * 0.55;
      const overholdingSlide = this.slideHoldActive && this.slideTimer >= TUNING.slide.overholdBrakeDelay;
      // Honor slide.minDuration before the speed-based cancel so a slide into a ramp/wall (which
      // bleeds speed fast) doesn't flicker out a frame or two after it starts. The hard cap
      // (maxDuration) always ends it.
      if (
        (overholdingSlide && speed <= TUNING.player.crouchWalkSpeed) ||
        (!this.slideHoldActive && (this.slideTimer > TUNING.slide.maxDuration || (tooSlow && this.slideTimer >= TUNING.slide.minDuration)))
      ) {
        this.sliding = false;
      }
    }
  }

  private tryStartSlide(input: InputManager, wishDir: Vector3): void {
    // Edge-triggered: a slide starts on the slide key OR a fresh crouch press while moving fast.
    // Using the crouch PRESS (not the held state) stops a held-crouch from re-applying the slide
    // impulse every frame the instant a previous slide ends.
    const crouchPressed = input.wasKeyPressed(CONTROL_KEYS.crouch) || input.wasKeyPressed(CONTROL_KEYS.crouchAlt);
    const speed = this.horizontalSpeed();
    const wantsSlide = input.wasKeyPressed(CONTROL_KEYS.slide) || (crouchPressed && speed > TUNING.player.crouchWalkSpeed);
    const canSlideFromSpeed = input.wasKeyPressed(CONTROL_KEYS.slide)
      ? speed >= TUNING.slide.minStartSpeed
      : speed > TUNING.player.crouchWalkSpeed;
    if (!this.grounded || this.sliding || !wantsSlide || !canSlideFromSpeed) return;

    this.sliding = true;
    this.slideTimer = 0;
    const slideDir = wishDir.lengthSquared() > 0.001 ? wishDir : safeNormalize(new Vector3(this.velocity.x, 0, this.velocity.z), yawForward(this.root.rotation.y));
    this.velocity.addInPlace(slideDir.scale(TUNING.slide.impulse));
  }

  /**
   * Jump is press-based (not auto/held): you must re-press to hop, so bhop stays a timing
   * skill rather than something you hold. There is no cooldown — you can jump the instant you
   * land, and a landing inside the bhop grace window keeps/builds speed. A jump while
   * wall-running becomes a wall-jump.
   */
  private tryJump(input: InputManager, wishDir: Vector3): void {
    if (!input.wasKeyPressed(CONTROL_KEYS.jump)) return;

    if (this.wallRunning) {
      const away = this.lastWallNormal.lengthSquared() > 0.001 ? this.lastWallNormal : this.wallJumpAwayDirection();
      this.velocity = this.velocity.add(away.scale(TUNING.wall.jumpAwaySpeed));
      this.velocity.y = TUNING.wall.jumpUpSpeed;
      this.endWallRun();
      this.wallReattachCooldown = TUNING.wall.reattachCooldownSeconds;
      return;
    }

    if (!this.grounded && this.jumpGraceTimer <= 0) {
      if (!this.doubleJumpAvailable) return;
      const result = this.dash.tryUpwardDash(this.velocity);
      if (!result) return;
      this.velocity = result;
      this.doubleJumpAvailable = false;
      this.dashingThisFrame = true;
      this.dashActiveTimer = TUNING.dash.activeSeconds;
      return;
    }

    if (this.sliding) {
      this.velocity.x *= TUNING.slide.jumpBonus;
      this.velocity.z *= TUNING.slide.jumpBonus;
      this.sliding = false;
    }

    const bhopBonus = this.jumpGraceTimer > 0 ? TUNING.player.bhopSpeedBonus : 1;
    this.velocity.x *= bhopBonus;
    this.velocity.z *= bhopBonus;
    this.velocity.y = TUNING.player.jumpSpeed;
    this.grounded = false;
    this.doubleJumpAvailable = true;
    this.jumpGraceTimer = 0;

    if (wishDir.lengthSquared() > 0.001) {
      this.velocity.addInPlace(wishDir.scale(0.45));
    }
  }

  private tryDash(input: InputManager, wishDir: Vector3): void {
    if (!input.wasKeyPressed(CONTROL_KEYS.dash)) return;
    const dashDir = wishDir.lengthSquared() > 0.001 ? wishDir : yawForward(this.root.rotation.y);
    const result = this.dash.tryDash(this.velocity, dashDir);
    if (!result) return;
    this.velocity = result;
    this.dashingThisFrame = true;
    // Suppress friction briefly so the dash is actually felt rather than instantly bled.
    this.dashActiveTimer = TUNING.dash.activeSeconds;
  }

  private tryBackflip(input: InputManager): void {
    if (!input.wasKeyPressed(CONTROL_KEYS.backflip)) return;
    const backward = yawForward(this.root.rotation.y).scale(-1);
    const impulse = this.backflip.start(backward);
    if (!impulse) return;
    this.velocity.addInPlace(impulse);
    this.grounded = false;
  }

  /**
   * Wall-run triggers automatically while airborne and moving roughly ALONG a nearby wall
   * (angled into it no steeper than runTriggerAngleDegrees). Running straight at a wall
   * (too head-on) or away from it does not attach. Lasts runMaxSeconds, then drops off and
   * needs a reattach cooldown so you can't ride the same wall forever.
   */
  private tryWallRun(dt: number): void {
    if (this.grounded || this.wallReattachCooldown > 0) {
      this.endWallRun();
      return;
    }

    const normal = this.detectWall();
    if (!normal) {
      this.endWallRun();
      return;
    }

    const horizSpeed = this.horizontalSpeed();
    if (horizSpeed < TUNING.wall.minEntrySpeed) {
      this.endWallRun();
      return;
    }

    // Attach as long as we're not moving meaningfully AWAY from the wall and our travel isn't
    // wildly head-on. intoWall: 1 = straight at wall, 0 = parallel, negative = away from it.
    const intoWall = -(this.velocity.x * normal.x + this.velocity.z * normal.z) / horizSpeed;
    const maxInto = Math.sin(TUNING.wall.runTriggerAngleDegrees * DEG2RAD);
    if (intoWall < -0.25 || intoWall > maxInto) {
      this.endWallRun();
      return;
    }

    if (!this.wallRunning) {
      this.wallRunning = true;
      this.wallRunTimer = 0;
      // A little upward kick on attach so you climb the wall rather than just slide along it.
      if (this.velocity.y < TUNING.wall.runStartUpBoost) {
        this.velocity.y = TUNING.wall.runStartUpBoost;
      }
    }
    this.lastWallNormal = normal;
    this.wallRunTimer += dt;
    if (this.wallRunTimer > TUNING.wall.runMaxSeconds) {
      this.endWallRun();
    }
  }

  private endWallRun(): void {
    this.wallRunning = false;
    this.wallRunTimer = 0;
  }

  /**
   * Returns the inward-facing normal of a wall the player is hugging, or null. Checks the
   * four gym-bound walls; the side walls are only reachable above/around the bleachers.
   */
  private detectWall(): Vector3 | null {
    const p = this.root.position;
    const margin = 0.9;
    if (TUNING.map.halfWidth - Math.abs(p.x) < margin) {
      return new Vector3(-Math.sign(p.x), 0, 0);
    }
    if (TUNING.map.halfLength - Math.abs(p.z) < margin) {
      return new Vector3(0, 0, -Math.sign(p.z));
    }
    return null;
  }

  /**
   * Quake/Source-style acceleration. Only the component of wished speed NOT already present
   * along wishDir is added, capped per tick by `accel * wishSpeed * dt`. On the ground this
   * cleanly caps walk speed; in the air, the small wishSpeed cap is what produces air-strafe
   * speed gain when you steer perpendicular to your current velocity.
   */
  private accelerate(wishDir: Vector3, wishSpeed: number, accel: number, dt: number): void {
    if (wishSpeed <= 0 || wishDir.lengthSquared() <= 0.001) return;
    const currentSpeed = this.velocity.x * wishDir.x + this.velocity.z * wishDir.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
    this.velocity.x += wishDir.x * accelSpeed;
    this.velocity.z += wishDir.z * accelSpeed;
  }

  private applyFriction(dt: number): void {
    if (!this.grounded) return;
    // While dashing, skip friction so the burst carries (the dash should be felt).
    if (this.dashActiveTimer > 0 && !this.sliding) return;
    const slideFrictionMultiplier =
      this.sliding && this.slideHoldActive && this.slideTimer >= TUNING.slide.overholdBrakeDelay
        ? TUNING.slide.overholdFrictionMultiplier
        : TUNING.slide.frictionMultiplier;
    const friction = TUNING.player.friction * (this.sliding ? slideFrictionMultiplier : 1);
    // Exponential decay = exactly frame-rate independent (v(t) = v0 * e^(-friction*t)).
    const decay = Math.exp(-friction * dt);
    this.velocity.x *= decay;
    this.velocity.z *= decay;
  }

  private applyGravity(dt: number): void {
    if (this.grounded) return;
    // Snappier (non-floaty) jumps: gravity is stronger on the way down than the way up.
    const fallScale = this.velocity.y < 0 ? TUNING.player.fallGravityMultiplier : 1;
    const wallScale = this.wallRunning ? TUNING.wall.runGravityScale : 1;
    this.velocity.y -= TUNING.player.gravity * fallScale * wallScale * dt;
    // Wall-run: hold a gentle, controlled descent rather than free-falling.
    if (this.wallRunning && this.velocity.y < TUNING.wall.runMaxFallSpeed) {
      this.velocity.y = TUNING.wall.runMaxFallSpeed;
    }
  }

  private applySoftSpeedLimit(dt: number): void {
    // Allocation-free: operate on scalar components instead of a temp Vector3.
    const vx = this.velocity.x;
    const vz = this.velocity.z;
    if (!this.grounded && !this.wallRunning) return;
    const speedSq = vx * vx + vz * vz;
    const limit = TUNING.player.softSpeedLimit;
    if (speedSq <= limit * limit) return;
    const speed = Math.sqrt(speedSq);
    // dt-scaled bleed so the limit behaves the same at any frame rate.
    const bleed = (speed - limit) * Math.min(1, TUNING.player.softLimitBleedRate * dt);
    const newSpeed = speed - bleed;
    const k = newSpeed / speed;
    this.velocity.x = vx * k;
    this.velocity.z = vz * k;
  }

  private applyCrouchWalkSpeedLimit(): void {
    if (!this.grounded || !this.crouching || this.sliding) return;
    const speedSq = this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z;
    const limit = TUNING.player.crouchWalkSpeed;
    if (speedSq <= limit * limit) return;
    const speed = Math.sqrt(speedSq);
    const k = limit / speed;
    this.velocity.x *= k;
    this.velocity.z *= k;
  }

  private updateGroundState(): void {
    // groundHeight is the surface under the player from last tick's collision pass.
    if (this.root.position.y <= this.groundHeight + 1e-3) {
      if (!this.grounded) {
        this.jumpGraceTimer = TUNING.player.bhopGraceSeconds;
      }
      this.root.position.y = this.groundHeight;
      this.velocity.y = Math.max(0, this.velocity.y);
      this.grounded = true;
      this.doubleJumpAvailable = true;
      this.wallRunning = false;
      return;
    }

    this.grounded = false;
  }

  /**
   * Resolve the player (approximated as a square-footprint box of half-extent = radius)
   * against static map AABBs. Two passes:
   *   1) Ground support — the highest box top under the footprint within step range
   *      becomes groundHeight, so the player stands on / steps onto bleachers.
   *   2) Walls — boxes that rise above that support get a minimum-translation push-out on
   *      the shallower horizontal axis, zeroing velocity into the wall.
   * The floor (y=0) is the baseline support and outer walls are handled by the bounds clamp.
   */
  private resolveCollisions(): void {
    const boxes = this.collision.boxes;
    if (boxes.length === 0) {
      this.groundHeight = 0;
      return;
    }

    const r = TUNING.player.radius;
    const bodyHeight = this.currentBodyHeight();
    const stepTolerance = TUNING.player.stepHeight;
    const p = this.root.position;

    // Pass 1: ground support (skip boxes whose top is too high to stand on from here).
    let support = 0;
    for (const b of boxes) {
      if (p.x + r <= b.minX || p.x - r >= b.maxX) continue;
      if (p.z + r <= b.minZ || p.z - r >= b.maxZ) continue;
      if (b.maxY <= p.y + stepTolerance && b.maxY > support) support = b.maxY;
    }
    this.groundHeight = support;

    // Pass 2: horizontal push-out for boxes acting as walls (rising above the support).
    for (const b of boxes) {
      if (b.maxY <= support + 1e-3) continue; // it's the surface we stand on, not a wall
      const bodyMinY = Math.max(p.y, support);
      const bodyMaxY = p.y + bodyHeight;
      if (bodyMaxY <= b.minY || bodyMinY >= b.maxY) continue; // no vertical overlap

      const overlapX = Math.min(p.x + r, b.maxX) - Math.max(p.x - r, b.minX);
      const overlapZ = Math.min(p.z + r, b.maxZ) - Math.max(p.z - r, b.minZ);
      if (overlapX <= 0 || overlapZ <= 0) continue;

      if (overlapX < overlapZ) {
        p.x += p.x < (b.minX + b.maxX) * 0.5 ? -overlapX : overlapX;
        this.velocity.x = 0;
      } else {
        p.z += p.z < (b.minZ + b.maxZ) * 0.5 ? -overlapZ : overlapZ;
        this.velocity.z = 0;
      }
    }
  }

  private currentBodyHeight(): number {
    return this.crouching || this.sliding
      ? TUNING.player.height * TUNING.player.crouchHeightMultiplier
      : TUNING.player.height;
  }

  private clampToGymBounds(): void {
    this.root.position.x = Math.max(-TUNING.map.halfWidth + TUNING.player.radius, Math.min(TUNING.map.halfWidth - TUNING.player.radius, this.root.position.x));
    this.root.position.z = Math.max(-TUNING.map.halfLength + TUNING.player.radius, Math.min(TUNING.map.halfLength - TUNING.player.radius, this.root.position.z));
    const maxY = Math.max(0, TUNING.map.wallHeight - this.currentBodyHeight() - TUNING.player.ceilingClearance);
    if (this.root.position.y > maxY) {
      this.root.position.y = maxY;
      if (this.velocity.y > 0) this.velocity.y = 0;
      this.wallRunning = false;
    }
  }

  private applyCameraHeight(): void {
    const height = this.crouching || this.sliding ? TUNING.player.eyeHeight * TUNING.player.crouchHeightMultiplier : TUNING.player.eyeHeight;
    this.camera.position.y = height;
  }

  private horizontalSpeed(): number {
    return Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
  }

  private wallJumpAwayDirection(): Vector3 {
    const p = this.root.position;
    if (Math.abs(Math.abs(p.x) - TUNING.map.halfWidth) < 0.8) {
      return new Vector3(-Math.sign(p.x), 0, 0);
    }
    if (Math.abs(Math.abs(p.z) - TUNING.map.halfLength) < 0.8) {
      return new Vector3(0, 0, -Math.sign(p.z));
    }
    return yawForward(this.root.rotation.y).scale(-1);
  }

  // One reusable snapshot, refreshed in place each tick. Consumers (hands, catch, HUD) only
  // read it within the same frame it's produced, so we avoid allocating an object + two cloned
  // vectors every frame. The position/velocity vectors are owned by the snapshot (copied from
  // the live state) so writing them can't mutate the controller's real state.
  private readonly _snapshot: MovementSnapshot = {
    position: Vector3.Zero(),
    velocity: Vector3.Zero(),
    grounded: true,
    sliding: false,
    crouching: false,
    wallRunning: false,
    wallNormal: Vector3.Zero(),
    dashingThisFrame: false,
    speed: 0,
    bhopGraceTimer: 0,
    wallRunTimer: 0,
    frictionMode: 'normal'
  };

  snapshot(): MovementSnapshot {
    const s = this._snapshot;
    s.position.copyFrom(this.root.position);
    s.velocity.copyFrom(this.velocity);
    s.grounded = this.grounded;
    s.sliding = this.sliding;
    s.crouching = this.crouching;
    s.wallRunning = this.wallRunning;
    s.wallNormal.copyFrom(this.wallRunning ? this.lastWallNormal : Vector3.Zero());
    s.dashingThisFrame = this.dashingThisFrame;
    s.speed = this.horizontalSpeed();
    s.bhopGraceTimer = this.jumpGraceTimer;
    s.wallRunTimer = this.wallRunTimer;
    s.frictionMode = !this.grounded ? 'air'
      : (this.dashActiveTimer > 0 && !this.sliding) ? 'dashSuppressed'
      : this.sliding ? 'slide'
      : 'normal';
    return s;
  }
}
