import { FreeCamera, TransformNode, Vector3 } from '@babylonjs/core';
import { CONTROL_KEYS } from '../config/controls';
import { TUNING } from '../config/tuning';
import { InputManager } from '../input/InputManager';
import { safeNormalize, DEG2RAD } from '../utils/math';
import { airStrafeWishDirection, movementWishDirection, yawForward } from '../utils/vector';
import { DashController } from './DashController';
import { BackflipController } from './BackflipController';
import { CollisionWorld, type RampCollider } from '../map/Collider';

export type FrictionMode = 'air' | 'normal' | 'slide' | 'dashSuppressed';

/**
 * Optional world override for the OFFLINE controller only (the local Movement Sandbox uses it). When
 * set it replaces the default gym world: the position clamp uses these XZ bounds + ceiling, and
 * wall-run/wall-jump detection queries `wallNormalAt` while wall-bounce can query
 * `wallBounceNormalAt` instead of the four gym perimeter walls. When null (normal practice + every
 * online path, which uses shared/simulation/MovementSim anyway) behaviour is byte-for-byte unchanged.
 */
export interface MovementWorld {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  ceilingY: number;
  /** Outward (into open space) unit XZ normal of the nearest wall-run surface in range, else null. */
  wallNormalAt(x: number, z: number, y: number): Vector3 | null;
  /** Optional wall-bounce surface query. Defaults to wallNormalAt when omitted. */
  wallBounceNormalAt?(x: number, z: number, y: number): Vector3 | null;
}

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
  private slideBufferTimer = 0;
  private jumpGraceTimer = 0;
  private wallRunTimer = 0;
  // True on ticks where the player is wall-running AND holding W (so A/D steer height). Gates the
  // vertical control in applyGravity. Mirrors MovementSim's wallRunClimbing.
  private wallRunClimbing = false;
  // Signed climb amount [-1, 1] for this tick: +1 = steering into the wall (climb), -1 = away
  // (descend), 0 = straight (W only). Mirrors MovementSim's wallRunVerticalInput.
  private wallRunVerticalInput = 0;
  private wallReattachCooldown = 0;
  private doubleJumpAvailable = true;
  private catchBoostTimer = 0;
  // Counts down after a dash; while > 0 ground friction is suppressed so the burst carries.
  private dashActiveTimer = 0;
  // Height of the surface currently under the player's feet (floor = 0, or a bleacher/mat
  // top). Recomputed each tick by collision resolution and used as the "ground" level.
  private groundHeight = 0;
  private readonly groundNormal = new Vector3(0, 1, 0);
  private groundIsSlope = false;
  // Normal (pointing into the court) of the wall currently being run on; drives wall-jump.
  private lastWallNormal = Vector3.Zero();
  private catchRecoilOffset = 0;
  private slideHoldActive = false;
  // Offline-only world override (Movement Sandbox). Null = default gym world (unchanged behaviour).
  private world: MovementWorld | null = null;

  constructor(
    private readonly root: TransformNode,
    private readonly camera: FreeCamera,
    private readonly dash: DashController,
    private readonly backflip: BackflipController,
    private readonly collision: CollisionWorld
  ) {}

  /** Offline only: install (or clear with null) a world override for the Movement Sandbox. */
  setWorld(world: MovementWorld | null): void {
    this.world = world;
    this.endWallRun();
  }

  resetKinematics(): void {
    this.velocity.setAll(0);
    this.grounded = true;
    this.sliding = false;
    this.crouching = false;
    this.wallRunning = false;
    this.dashingThisFrame = false;
    this.slideTimer = 0;
    this.slideBufferTimer = 0;
    this.jumpGraceTimer = 0;
    this.wallRunTimer = 0;
    this.wallRunClimbing = false;
    this.wallRunVerticalInput = 0;
    this.wallReattachCooldown = 0;
    this.doubleJumpAvailable = true;
    this.catchBoostTimer = 0;
    this.dashActiveTimer = 0;
    this.groundHeight = 0;
    this.groundNormal.set(0, 1, 0);
    this.groundIsSlope = false;
    this.lastWallNormal.setAll(0);
    this.catchRecoilOffset = 0;
    this.slideHoldActive = false;
    this.camera.position.z = 0;
    this.applyCameraHeight();
  }

  update(dt: number, input: InputManager, catchStanceActive: boolean): MovementSnapshot {
    this.dashingThisFrame = false;
    // Crouch only takes physical effect on the ground (body height, speed cap). Holding crouch in
    // the air must NOT shrink the hitbox/body height — that perturbs air-strafe momentum and feels
    // sluggish when prepping a slide — but it still arms the instant slide-on-landing via
    // slideHoldActive. Mirrors MovementSim.ts (the authoritative online sim).
    this.crouching = this.grounded && (input.isKeyDown(CONTROL_KEYS.crouch) || input.isKeyDown(CONTROL_KEYS.crouchAlt));
    this.slideHoldActive =
      input.isKeyDown(CONTROL_KEYS.slide) || input.isKeyDown(CONTROL_KEYS.crouch) || input.isKeyDown(CONTROL_KEYS.crouchAlt);
    this.tickVisualFeedback(dt);

    const moveX = (input.isKeyDown(CONTROL_KEYS.right) ? 1 : 0) - (input.isKeyDown(CONTROL_KEYS.left) ? 1 : 0);
    const moveZ = (input.isKeyDown(CONTROL_KEYS.forward) ? 1 : 0) - (input.isKeyDown(CONTROL_KEYS.backward) ? 1 : 0);
    const wishDir = movementWishDirection(this.root.rotation.y, moveX, moveZ);
    const airWishDir = airStrafeWishDirection(this.root.rotation.y, moveX);

    if (!this.grounded && this.slideHoldActive) {
      this.slideBufferTimer = TUNING.slide.airBufferSeconds;
    }
    this.updateGroundState();
    this.updateTimers(dt);
    this.tryStartSlide(input, wishDir);
    this.tryJump(input, wishDir);
    this.tryDash(input, wishDir);
    this.tryBackflip(input);
    this.tryWallRun(dt, moveZ > 0, moveX);

    // Friction first (Quake/Source order), then acceleration toward the wish direction, so
    // friction doesn't immediately eat the speed we just added.
    this.applyFriction(dt);

    const speedMultiplier =
      (catchStanceActive ? TUNING.player.catchStanceSpeedMultiplier : 1) + (this.catchBoostTimer > 0 ? 0.1 : 0);

    if (this.grounded && !this.sliding) {
      // Ground (NOT sliding): accelerate up to the (possibly slowed) walk speed. Excess speed carried
      // in from bhop isn't removed by accelerate — friction (above) bleeds it on non-jump frames.
      // A slide is a committed slide: no ground acceleration at all, so you can't strafe/steer or add
      // speed on the ground while sliding — it just carries momentum (bled by slide friction above).
      const groundWishSpeed = this.crouching
        ? TUNING.player.crouchWalkSpeed
        : TUNING.player.maxGroundSpeed * speedMultiplier;
      this.accelerate(wishDir, groundWishSpeed, TUNING.player.groundAcceleration, dt);
    } else if (!this.grounded && !this.wallRunClimbing) {
      // CS-style air-strafe: A/D are the air-control keys. W/S preserves momentum but does not add
      // forward/back air acceleration, so speed comes from mouse-turning with side input. Suppressed
      // while wall-run climbing: there A/D are repurposed to VERTICAL height control, so they must
      // not also push you laterally off the wall. Matches MovementSim.
      this.accelerate(airWishDir, TUNING.player.airStrafeMaxSpeed, TUNING.player.airAcceleration, dt);
    }

    this.applyGravity(dt);
    this.applySlopeForces(dt);
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
    if (!this.grounded && this.slideHoldActive) {
      this.slideBufferTimer = TUNING.slide.airBufferSeconds;
    } else if (this.slideBufferTimer > 0) {
      this.slideBufferTimer = Math.max(0, this.slideBufferTimer - dt);
    }
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
    const bufferedSlide = this.grounded && this.slideHoldActive && this.slideBufferTimer > 0;
    const slidePressed = input.wasKeyPressed(CONTROL_KEYS.slide);
    const wantsSlide = slidePressed || bufferedSlide || (crouchPressed && speed > TUNING.player.crouchWalkSpeed);
    const canSlideFromSpeed = slidePressed || bufferedSlide
      ? speed > 0.001 || wishDir.lengthSquared() > 0.001
      : speed > TUNING.player.crouchWalkSpeed;
    if (!this.grounded || this.sliding || !wantsSlide || !canSlideFromSpeed) return;

    this.sliding = true;
    this.slideTimer = 0;
    this.slideBufferTimer = 0;
    const slideDir = wishDir.lengthSquared() > 0.001 ? wishDir : safeNormalize(new Vector3(this.velocity.x, 0, this.velocity.z), yawForward(this.root.rotation.y));
    if (speed < TUNING.slide.minStartBoostSpeed) {
      this.velocity.x = slideDir.x * TUNING.slide.minStartBoostSpeed;
      this.velocity.z = slideDir.z * TUNING.slide.minStartBoostSpeed;
    }
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
      this.doubleJumpAvailable = true;
      return;
    }

    if (this.tryWallBounce()) return;

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

  /**
   * Wall-bounce: hit a wall too head-on to wall-run (steeper than runTriggerAngleDegrees) while
   * airborne, then press jump near/touching the wall to bounce off like a spring — the faster you're
   * moving INTO the wall, the farther out and higher you launch. Reflects the into-wall velocity
   * (keeping along-wall momentum) and sets a fresh upward kick, both scaling with the approach speed.
   * Doesn't require an active wall-run and costs no stamina/dash charge; still sets the reattach
   * cooldown so you can't immediately wall-run/bounce the same wall again. Mirrors MovementSim exactly.
   */
  private tryWallBounce(): boolean {
    if (this.grounded) return false;
    const normal = this.detectWallBounceSurface();
    if (!normal) return false;

    const horizSpeed = this.horizontalSpeed();
    if (horizSpeed < TUNING.wall.minEntrySpeed) return false;

    const intoWall = -(this.velocity.x * normal.x + this.velocity.z * normal.z) / horizSpeed;
    const maxInto = Math.sin(TUNING.wall.runTriggerAngleDegrees * DEG2RAD);
    if (intoWall <= maxInto) return false; // shallow enough to wall-run instead

    const vn = this.velocity.x * normal.x + this.velocity.z * normal.z; // along outward normal (neg = into wall)
    const approach = Math.min(TUNING.wall.bounceMaxApproachSpeed, Math.max(0, -vn));
    const tx = this.velocity.x - vn * normal.x; // along-wall component, preserved
    const tz = this.velocity.z - vn * normal.z;
    const outward = TUNING.wall.bounceBaseAwaySpeed + approach * TUNING.wall.bounceAwayGain;
    const up = TUNING.wall.bounceBaseUpSpeed + approach * TUNING.wall.bounceUpGain;
    this.velocity.x = tx + normal.x * outward;
    this.velocity.z = tz + normal.z * outward;
    this.velocity.y = Math.max(this.velocity.y, up);
    this.wallReattachCooldown = TUNING.wall.reattachCooldownSeconds;
    return true;
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
  private tryWallRun(dt: number, forwardHeld: boolean, moveX: number): void {
    this.wallRunClimbing = false;
    this.wallRunVerticalInput = 0;
    if (this.grounded || this.wallReattachCooldown > 0) {
      this.endWallRun();
      return;
    }
    if (this.root.position.y >= this.maxPlayerY() - TUNING.wall.ceilingDetachDistance) {
      // Reached the top of the runnable wall: detach and nudge downward so the head unsticks from
      // the roof instead of pinning fully vertical (and getting stuck in a corner).
      this.endWallRun();
      this.wallReattachCooldown = Math.max(this.wallReattachCooldown, TUNING.wall.reattachCooldownSeconds);
      if (this.velocity.y > -TUNING.wall.ceilingDetachPushDown) {
        this.velocity.y = -TUNING.wall.ceilingDetachPushDown;
      }
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
      // A little upward kick on attach so you start climbing rather than just slide along.
      if (this.velocity.y < TUNING.wall.runStartUpBoost) {
        this.velocity.y = TUNING.wall.runStartUpBoost;
      }
    }
    this.lastWallNormal = normal;
    this.wallRunTimer += dt;
    if (this.wallRunTimer > TUNING.wall.runMaxSeconds) {
      this.endWallRun();
      this.wallReattachCooldown = Math.max(this.wallReattachCooldown, TUNING.wall.reattachCooldownSeconds);
    } else if (forwardHeld) {
      // W is the engage key: while holding forward you run STRAIGHT (hold height), and A/D adjust
      // height. Steering INTO the wall climbs, AWAY descends — side-relative to facing. Matches
      // MovementSim: input = -(moveX) * (right · normal), 0 with no strafe key. A/D WITHOUT W = nothing.
      const yaw = this.root.rotation.y;
      const rightX = Math.cos(yaw);
      const rightZ = -Math.sin(yaw);
      const rxn = rightX * normal.x + rightZ * normal.z;
      const verticalInput = Math.max(-1, Math.min(1, -moveX * rxn));
      // Past the gravity-delay threshold, gravity takes over: climbing (steering up) AND holding
      // height (no strafe) are disabled — only actively steering away (descend) still uses the
      // eased climb control. Matches MovementSim.
      const pastGravityDelay = this.wallRunTimer >= TUNING.wall.runGravityDelaySeconds;
      if (pastGravityDelay && verticalInput >= 0) {
        this.wallRunClimbing = false;
        this.wallRunVerticalInput = 0;
      } else {
        this.wallRunClimbing = true;
        this.wallRunVerticalInput = verticalInput;
      }
    }
  }

  private endWallRun(): void {
    this.wallRunning = false;
    this.wallRunTimer = 0;
    this.wallRunClimbing = false;
    this.wallRunVerticalInput = 0;
  }

  /**
   * Returns the inward-facing normal of a wall the player is hugging, or null. Checks the
   * four gym-bound walls; the side walls are only reachable above/around the bleachers.
   */
  private detectWall(): Vector3 | null {
    const p = this.root.position;
    if (this.world) return this.world.wallNormalAt(p.x, p.z, p.y);
    const margin = 0.9;
    if (TUNING.map.halfWidth - Math.abs(p.x) < margin) {
      return new Vector3(-Math.sign(p.x), 0, 0);
    }
    if (TUNING.map.halfLength - Math.abs(p.z) < margin) {
      return new Vector3(0, 0, -Math.sign(p.z));
    }
    return null;
  }

  private detectWallBounceSurface(): Vector3 | null {
    const p = this.root.position;
    if (this.world) return this.world.wallBounceNormalAt?.(p.x, p.z, p.y) ?? this.world.wallNormalAt(p.x, p.z, p.y);
    return this.detectWall();
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
    const slopeMultiplier = this.groundIsSlope ? TUNING.slope.frictionMultiplier : 1;
    const friction = TUNING.player.friction * (this.sliding ? slideFrictionMultiplier : 1) * slopeMultiplier;
    // Exponential decay = exactly frame-rate independent (v(t) = v0 * e^(-friction*t)).
    const decay = Math.exp(-friction * dt);
    this.velocity.x *= decay;
    this.velocity.z *= decay;
  }

  private applyGravity(dt: number): void {
    if (this.grounded) return;
    if (this.wallRunClimbing) {
      // A/D-while-W climb: the signed steer-into-wall input sets the target vertical speed (into the
      // wall = climb, away = descend, straight = hold), eased so it reads as a smooth arc. Matches
      // MovementSim.
      const targetVy = this.wallRunVerticalInput * TUNING.wall.runClimbSpeed;
      const alpha = 1 - Math.exp(-TUNING.wall.runClimbSmoothing * dt);
      this.velocity.y += (targetVy - this.velocity.y) * alpha;
      return;
    }
    if (this.wallRunning) {
      // Not steering (W released): residual wall gravity peels you off the arc and down the wall.
      // Past the gravity-delay threshold this ramps up to runLateGravityScale so the run can't be
      // sustained forever.
      const lateGravity = this.wallRunTimer >= TUNING.wall.runGravityDelaySeconds;
      this.velocity.y -= TUNING.player.gravity * (lateGravity ? TUNING.wall.runLateGravityScale : TUNING.wall.runGravityScale) * dt;
      return;
    }
    // Snappier (non-floaty) jumps: gravity is stronger on the way down than the way up.
    const fallScale = this.velocity.y < 0 ? TUNING.player.fallGravityMultiplier : 1;
    this.velocity.y -= TUNING.player.gravity * fallScale * dt;
  }

  private applySlopeForces(dt: number): void {
    if (!this.grounded || !this.groundIsSlope) return;
    const n = this.groundNormal;
    const gravity = TUNING.player.gravity * (this.sliding ? TUNING.slope.slideGravityScale : TUNING.slope.gravityScale);
    // Gravity projected onto the ramp plane. The horizontal part accelerates downhill and slows uphill
    // movement; the projection below keeps carried velocity tangent to the sloped top.
    this.velocity.x += gravity * n.y * n.x * dt;
    this.velocity.z += gravity * n.y * n.z * dt;
    this.projectVelocityOntoGroundPlane();
  }

  private projectVelocityOntoGroundPlane(): void {
    if (!this.groundIsSlope) return;
    const n = this.groundNormal;
    const dot = this.velocity.x * n.x + this.velocity.y * n.y + this.velocity.z * n.z;
    this.velocity.x -= n.x * dot;
    this.velocity.y -= n.y * dot;
    this.velocity.z -= n.z * dot;
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
      if (this.groundIsSlope) this.projectVelocityOntoGroundPlane();
      else this.velocity.y = Math.max(0, this.velocity.y);
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
      this.groundNormal.set(0, 1, 0);
      this.groundIsSlope = false;
      return;
    }

    const r = TUNING.player.radius;
    const bodyHeight = this.currentBodyHeight();
    const stepTolerance = TUNING.player.stepHeight;
    const p = this.root.position;

    // Pass 1: ground support (skip boxes whose top is too high to stand on from here).
    let support = 0;
    let supportNormalX = 0;
    let supportNormalY = 1;
    let supportNormalZ = 0;
    let supportIsSlope = false;
    for (const b of boxes) {
      if (b.ramp) {
        const hit = this.rampSupportAt(b.ramp, p.x, p.z, r);
        if (!hit) continue;
        if (hit.y <= p.y + stepTolerance && hit.y > support) {
          support = hit.y;
          supportNormalX = b.ramp.normalX;
          supportNormalY = b.ramp.normalY;
          supportNormalZ = b.ramp.normalZ;
          supportIsSlope = true;
        }
        continue;
      }
      if (b.ry !== undefined) {
        // Oriented box: test the footprint in the box's local frame (exact).
        const cos = Math.cos(b.ry);
        const sin = Math.sin(b.ry);
        const dwx = p.x - (b.cx as number);
        const dwz = p.z - (b.cz as number);
        const lx = cos * dwx - sin * dwz;
        const lz = sin * dwx + cos * dwz;
        if (Math.abs(lx) >= (b.hx as number) + r || Math.abs(lz) >= (b.hz as number) + r) continue;
      } else {
        if (p.x + r <= b.minX || p.x - r >= b.maxX) continue;
        if (p.z + r <= b.minZ || p.z - r >= b.maxZ) continue;
      }
      if (b.maxY <= p.y + stepTolerance && b.maxY > support) support = b.maxY;
    }
    this.groundHeight = support;
    this.groundNormal.set(supportNormalX, supportNormalY, supportNormalZ);
    this.groundIsSlope = supportIsSlope;
    if (this.grounded && support <= p.y + stepTolerance && p.y - support <= TUNING.slope.groundSnapDistance) {
      p.y = support;
      if (this.groundIsSlope) this.projectVelocityOntoGroundPlane();
      else this.velocity.y = Math.max(0, this.velocity.y);
    }

    // Pass 2: horizontal push-out for boxes acting as walls (rising above the support).
    for (const b of boxes) {
      if (b.ramp) {
        this.resolveRampWalls(b.ramp, p, r, bodyHeight, support);
        continue;
      }
      if (b.maxY <= support + 1e-3) continue; // it's the surface we stand on, not a wall
      const bodyMinY = Math.max(p.y, support);
      const bodyMaxY = p.y + bodyHeight;
      if (bodyMaxY <= b.minY || bodyMinY >= b.maxY) continue; // no vertical overlap

      if (b.ry !== undefined) {
        // Oriented push-out: resolve in the box's local frame, then rotate the correction back to
        // world. Only the inward velocity component is removed, so sliding ALONG the wall stays smooth.
        const cos = Math.cos(b.ry);
        const sin = Math.sin(b.ry);
        const dwx = p.x - (b.cx as number);
        const dwz = p.z - (b.cz as number);
        const lx = cos * dwx - sin * dwz;
        const lz = sin * dwx + cos * dwz;
        const ox = (b.hx as number) + r - Math.abs(lx);
        const oz = (b.hz as number) + r - Math.abs(lz);
        if (ox <= 0 || oz <= 0) continue;
        let clx = 0;
        let clz = 0;
        if (ox < oz) clx = lx < 0 ? -ox : ox;
        else clz = lz < 0 ? -oz : oz;
        const cwx = cos * clx + sin * clz; // local → world
        const cwz = -sin * clx + cos * clz;
        p.x += cwx;
        p.z += cwz;
        const len = Math.hypot(cwx, cwz);
        if (len > 1e-6) {
          const nx = cwx / len;
          const nz = cwz / len;
          const vn = this.velocity.x * nx + this.velocity.z * nz;
          if (vn < 0) {
            this.velocity.x -= vn * nx;
            this.velocity.z -= vn * nz;
          }
        }
        continue;
      }

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

  private rampSupportAt(ramp: RampCollider, x: number, z: number, radius: number): { y: number } | null {
    const local = this.rampLocal(ramp, x, z);
    const hw = ramp.width / 2;
    const hd = ramp.depth / 2;
    if (local.x < -hw - radius || local.x > hw + radius) return null;
    if (Math.abs(local.z) > hd + radius) return null;
    const lx = Math.max(-hw, Math.min(hw, local.x));
    return { y: this.rampHeightAtLocalX(ramp, lx) };
  }

  private resolveRampWalls(ramp: RampCollider, p: Vector3, radius: number, bodyHeight: number, support: number): void {
    const local = this.rampLocal(ramp, p.x, p.z);
    const hw = ramp.width / 2;
    const hd = ramp.depth / 2;
    const bodyMinY = Math.max(p.y, support);
    const bodyMaxY = p.y + bodyHeight;
    let bestPen = Infinity;
    let bestClx = 0;
    let bestClz = 0;
    const consider = (clx: number, clz: number): void => {
      const pen = Math.hypot(clx, clz);
      if (pen > 0 && pen < bestPen) {
        bestPen = pen;
        bestClx = clx;
        bestClz = clz;
      }
    };

    // High vertical back face of the wedge. Bounded to the wedge's own DEPTH (+radius) in Z — without
    // this, the back-face push applied at ANY local.z, so it read as an infinite invisible wall
    // spanning all Z beyond the high end (the "massive invisible hitbox"), not a wall the width of the ramp.
    if (local.x > hw && local.x < hw + radius && Math.abs(local.z) < hd + radius && bodyMaxY > ramp.baseY && bodyMinY < ramp.baseY + ramp.height) {
      consider(hw + radius - local.x, 0);
    }

    // Triangular side faces. The solid height at the current X decides whether the body overlaps the
    // side wall or is above the sloped top.
    if (local.x >= -hw - radius && local.x <= hw + radius) {
      const lx = Math.max(-hw, Math.min(hw, local.x));
      const topY = this.rampHeightAtLocalX(ramp, lx);
      if (bodyMaxY > ramp.baseY && bodyMinY < topY) {
        if (local.z > hd && local.z < hd + radius) consider(0, hd + radius - local.z);
        else if (local.z < -hd && local.z > -hd - radius) consider(0, -hd - radius - local.z);
      }
    }

    if (!Number.isFinite(bestPen)) return;
    const cos = Math.cos(ramp.ry);
    const sin = Math.sin(ramp.ry);
    const cwx = cos * bestClx + sin * bestClz;
    const cwz = -sin * bestClx + cos * bestClz;
    p.x += cwx;
    p.z += cwz;
    const len = Math.hypot(cwx, cwz);
    if (len <= 1e-6) return;
    const nx = cwx / len;
    const nz = cwz / len;
    const vn = this.velocity.x * nx + this.velocity.z * nz;
    if (vn < 0) {
      this.velocity.x -= vn * nx;
      this.velocity.z -= vn * nz;
    }
  }

  private rampLocal(ramp: RampCollider, x: number, z: number): { x: number; z: number } {
    const cos = Math.cos(ramp.ry);
    const sin = Math.sin(ramp.ry);
    const dwx = x - ramp.centerX;
    const dwz = z - ramp.centerZ;
    return {
      x: cos * dwx - sin * dwz,
      z: sin * dwx + cos * dwz
    };
  }

  private rampHeightAtLocalX(ramp: RampCollider, localX: number): number {
    const hw = ramp.width / 2;
    const t = (localX + hw) / Math.max(0.0001, ramp.width);
    return ramp.baseY + Math.max(0, Math.min(1, t)) * ramp.height;
  }

  private currentBodyHeight(): number {
    if (this.sliding) return TUNING.player.height * TUNING.slide.heightScale;
    return this.crouching ? TUNING.player.height * TUNING.player.crouchHeightMultiplier : TUNING.player.height;
  }

  private clampToGymBounds(): void {
    const r = TUNING.player.radius;
    const minX = (this.world ? this.world.minX : -TUNING.map.halfWidth) + r;
    const maxX = (this.world ? this.world.maxX : TUNING.map.halfWidth) - r;
    const minZ = (this.world ? this.world.minZ : -TUNING.map.halfLength) + r;
    const maxZ = (this.world ? this.world.maxZ : TUNING.map.halfLength) - r;
    this.root.position.x = Math.max(minX, Math.min(maxX, this.root.position.x));
    this.root.position.z = Math.max(minZ, Math.min(maxZ, this.root.position.z));
    const maxY = this.maxPlayerY();
    if (this.root.position.y > maxY) {
      this.root.position.y = maxY;
      if (this.velocity.y > 0) this.velocity.y = 0;
      this.endWallRun();
      this.wallReattachCooldown = Math.max(this.wallReattachCooldown, TUNING.wall.reattachCooldownSeconds);
    }
  }

  private maxPlayerY(): number {
    const ceiling = this.world ? this.world.ceilingY : TUNING.map.wallHeight;
    return Math.max(0, ceiling - this.currentBodyHeight() - TUNING.player.ceilingClearance);
  }

  private applyCameraHeight(): void {
    const height = this.sliding
      ? TUNING.player.eyeHeight * TUNING.slide.heightScale
      : this.crouching
        ? TUNING.player.eyeHeight * TUNING.player.crouchHeightMultiplier
        : TUNING.player.eyeHeight;
    this.camera.position.y = height;
  }

  private horizontalSpeed(): number {
    return Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z);
  }

  private wallJumpAwayDirection(): Vector3 {
    const p = this.root.position;
    if (this.world) {
      return this.world.wallNormalAt(p.x, p.z, p.y) ?? yawForward(this.root.rotation.y).scale(-1);
    }
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
