import { FreeCamera, Vector3 } from '@babylonjs/core';
import { CONTROL_KEYS, MOUSE_BUTTON } from '../config/controls';
import { TUNING } from '../config/tuning';
import { InputManager } from '../input/InputManager';
import { Ball } from '../ball/Ball';
import { BallManager } from '../ball/BallManager';
import { HandSide } from '../ball/BallState';
import { ThrowSystem } from '../ball/ThrowSystem';
import { cameraForward } from '../utils/vector';
import { MovementSnapshot } from './MovementController';
import { Effects } from '../effects/Effects';

export interface HandState {
  ball: Ball | null;
  // Visual-only online mirror: lets the first-person arms show a server-held ball without
  // borrowing ownership of the authoritative network ball mesh.
  visualHolding: boolean;
  charging: boolean;
  chargeSeconds: number;
  catchStance: boolean;
  // Catch-only cooldown (a missed/used catch). Does NOT gate throwing — throwing a held ball
  // is always immediate so the hands never feel like they're on a throw cooldown.
  cooldown: number;
  // Throw-animation pulse: set to 1 the frame a throw fires, decays to 0. Drives the arm swing.
  throwAnim: number;
  // Fake/cancel pulse: starts from the current windup and eases the hand back to holding.
  fakeAnim: number;
  fakeCharge01: number;
}

function makeHand(): HandState {
  return {
    ball: null,
    visualHolding: false,
    charging: false,
    chargeSeconds: 0,
    catchStance: false,
    cooldown: 0,
    throwAnim: 0,
    fakeAnim: 0,
    fakeCharge01: 0
  };
}

export class HandController {
  public left: HandState = makeHand();
  public right: HandState = makeHand();
  public lastThrowTime = -999;
  public lastAction = 'none';

  private readonly throwSystem = new ThrowSystem();
  private elapsed = 0;

  constructor(
    private readonly camera: FreeCamera,
    private readonly ballManager: BallManager,
    private readonly effects: Effects
  ) {}

  /**
   * @param throwsSuppressed when true, normal charge/throw is disabled (used while a backflip is in
   *   the air and while the landing QTE is pending — the backflip throw is released by the QTE, not
   *   by a normal click). Pickup/drop and catch stance still work.
   */
  update(dt: number, input: InputManager, movement: MovementSnapshot, throwsSuppressed = false): void {
    this.elapsed += dt;
    this.tickCooldowns(dt);
    this.handlePickupDrop(input, movement);
    this.handleHand(input, movement, 'left', MOUSE_BUTTON.leftHand, throwsSuppressed);
    this.handleHand(input, movement, 'right', MOUSE_BUTTON.rightHand, throwsSuppressed);
  }

  hasTwoBalls(): boolean {
    return !!this.left.ball && !!this.right.ball;
  }

  heldBallCount(): number {
    return (this.left.ball ? 1 : 0) + (this.right.ball ? 1 : 0);
  }

  getHand(side: HandSide): HandState {
    return side === 'left' ? this.left : this.right;
  }

  setCooldown(side: HandSide, seconds: number): void {
    this.getHand(side).cooldown = Math.max(this.getHand(side).cooldown, seconds);
  }

  tickVisualAnimations(dt: number): void {
    this.tickHandAnimation(this.left, dt);
    this.tickHandAnimation(this.right, dt);
  }

  forceCatchBall(side: HandSide, ball: Ball): void {
    const hand = this.getHand(side);
    if (hand.ball) return;
    hand.ball = ball;
    hand.visualHolding = true;
    ball.setHeld(side);
    hand.catchStance = false;
    hand.charging = false;
    hand.chargeSeconds = 0;
    hand.throwAnim = 0;
    hand.fakeAnim = 0;
    hand.fakeCharge01 = 0;
    hand.cooldown = TUNING.catch.cooldownSeconds;
    this.lastAction = `catch #${ball.id} (${side})`;
  }

  /** Detaches both hands (used when balls are reset so hands don't point at disposed meshes). */
  clearHands(): void {
    this.left = makeHand();
    this.right = makeHand();
  }

  dropOneBall(position: Vector3): void {
    if (this.right.ball) {
      this.ballManager.dropBall(
        this.right.ball,
        position.add(new Vector3(0.35, 1.0, 0)),
        dropReleaseVelocity(Vector3.Zero())
      );
      this.right.ball = null;
      this.right.visualHolding = false;
      return;
    }
    if (this.left.ball) {
      this.ballManager.dropBall(
        this.left.ball,
        position.add(new Vector3(-0.35, 1.0, 0)),
        dropReleaseVelocity(Vector3.Zero())
      );
      this.left.ball = null;
      this.left.visualHolding = false;
    }
  }

  syncVisualState(side: HandSide, holding: boolean, charging: boolean, chargeSeconds: number): void {
    const hand = this.getHand(side);
    if (!hand.ball) hand.visualHolding = holding;
    hand.catchStance = false;

    if (holding && charging) {
      hand.charging = true;
      hand.chargeSeconds = Math.min(TUNING.ball.maxChargeSeconds, Math.max(0, chargeSeconds));
      return;
    }

    if (!hand.ball || !hand.charging) {
      hand.charging = false;
      hand.chargeSeconds = 0;
    }
  }

  playThrowAnimation(side: HandSide): void {
    const hand = this.getHand(side);
    hand.throwAnim = 1;
    hand.fakeAnim = 0;
    hand.fakeCharge01 = 0;
    if (!hand.ball) hand.visualHolding = false;
  }

  playFakeThrowAnimation(side: HandSide, charge01?: number): void {
    const hand = this.getHand(side);
    const fromCharge = charge01 ?? hand.chargeSeconds / TUNING.ball.maxChargeSeconds;
    hand.fakeAnim = 1;
    hand.fakeCharge01 = Math.max(0.2, Math.min(1, fromCharge));
    hand.throwAnim = 0;
  }

  private tickCooldowns(dt: number): void {
    this.tickHand(this.left, dt);
    this.tickHand(this.right, dt);
  }

  private tickHand(hand: HandState, dt: number): void {
    hand.cooldown = Math.max(0, hand.cooldown - dt);
    this.tickHandAnimation(hand, dt);
    if (hand.charging) {
      hand.chargeSeconds = Math.min(TUNING.ball.maxChargeSeconds, hand.chargeSeconds + dt);
    }
  }

  private tickHandAnimation(hand: HandState, dt: number): void {
    if (hand.throwAnim > 0) hand.throwAnim = Math.max(0, hand.throwAnim - dt / TUNING.arms.throwAnimSeconds);
    if (hand.fakeAnim > 0) {
      hand.fakeAnim = Math.max(0, hand.fakeAnim - dt / TUNING.arms.fakeAnimSeconds);
      if (hand.fakeAnim <= 0) hand.fakeCharge01 = 0;
    }
  }

  private handlePickupDrop(input: InputManager, movement: MovementSnapshot): void {
    if (input.wasKeyPressed(CONTROL_KEYS.drop)) {
      if (this.right.ball) {
        this.lastAction = `drop #${this.right.ball.id} (right)`;
        this.ballManager.dropBall(
          this.right.ball,
          movement.position.add(new Vector3(0.4, 1, 0)),
          dropReleaseVelocity(movement.velocity)
        );
        this.right.ball = null;
        this.right.visualHolding = false;
      } else if (this.left.ball) {
        this.lastAction = `drop #${this.left.ball.id} (left)`;
        this.ballManager.dropBall(
          this.left.ball,
          movement.position.add(new Vector3(-0.4, 1, 0)),
          dropReleaseVelocity(movement.velocity)
        );
        this.left.ball = null;
        this.left.visualHolding = false;
      }
    }

    // Hold E to pick up: grabs the nearest valid ball the moment one is in range (no single-
    // frame timing to fumble). Allowed on the ground or just barely off it (not mid-air).
    if (!input.isKeyDown(CONTROL_KEYS.interact)) return;
    if (!movement.grounded && movement.position.y > 0.6) return;
    if (this.left.ball && this.right.ball) return;

    const candidate = this.ballManager.findPickupCandidate(movement.position.add(new Vector3(0, 0.8, 0)));
    if (!candidate) return;

    // First pickup goes to the left (dominant) hand, otherwise the empty hand.
    const side: HandSide = !this.left.ball ? 'left' : 'right';
    const hand = this.getHand(side);
    // Put the ball in hand immediately and make the hand cleanly "holding": cancel any catch
    // stance, clear any catch cooldown, and start with no charge. No throw cooldown is set, so
    // a fresh M1/M2 press throws right away. (A button already held from before pickup won't
    // auto-throw because charging only starts on a new press edge.)
    hand.ball = candidate;
    hand.visualHolding = true;
    hand.catchStance = false;
    hand.charging = false;
    hand.chargeSeconds = 0;
    hand.throwAnim = 0;
    hand.fakeAnim = 0;
    hand.fakeCharge01 = 0;
    hand.cooldown = 0;
    this.lastAction = `pickup #${candidate.id} (${side})`;
    this.ballManager.attachHeldBall(candidate, side, candidate.mesh.position); // sets ball.state = Held
  }

  /**
   * Throw model (deliberately simple/responsive):
   *   - Empty hand: hold the button for catch stance.
   *   - Ball in hand: press starts a charge, release throws. A quick tap = ~no charge = quick
   *     throw; holding = charged throw. F cancels a charge. No throw cooldown.
   * The second of a rapid double throw is flagged "rushed" so it comes out slightly slower.
   */
  private handleHand(input: InputManager, movement: MovementSnapshot, side: HandSide, button: number, throwsSuppressed: boolean): void {
    const hand = this.getHand(side);

    // While a backflip is airborne or the landing QTE is pending, the normal throw is disabled — the
    // backflip throw is released by the QTE click instead. Keep the hand idle (no charge build-up).
    if (throwsSuppressed && hand.ball) {
      hand.catchStance = false;
      hand.charging = false;
      hand.chargeSeconds = 0;
      return;
    }

    // Ignore mouse hand actions until the cursor is locked, so the click that engages pointer
    // lock doesn't accidentally start a throw/catch.
    if (!input.pointerLocked) {
      hand.catchStance = false;
      hand.charging = false;
      hand.chargeSeconds = 0;
      hand.fakeAnim = 0;
      hand.fakeCharge01 = 0;
      return;
    }

    const mouseDown = input.isMouseDown(button);
    const mousePressed = input.wasMousePressed(button);
    const mouseReleased = input.wasMouseReleased(button);

    if (!hand.ball) {
      // Empty hand: catch stance while the button is held (unless on catch cooldown).
      hand.catchStance = mouseDown && hand.cooldown <= 0;
      hand.charging = false;
      hand.chargeSeconds = 0;
      return;
    }

    hand.catchStance = false;

    if (mousePressed) {
      hand.charging = true;
      hand.chargeSeconds = 0;
    }

    if (hand.charging && input.wasKeyPressed(CONTROL_KEYS.fakeThrow)) {
      this.playFakeThrowAnimation(side);
      hand.charging = false;
      hand.chargeSeconds = 0;
      return;
    }

    if (hand.charging && mouseReleased) {
      this.throwFromHand(side, movement);
    }
  }

  /**
   * Backflip landing throw: fire the given hand at a QTE success tier (1..5), bypassing the normal
   * charge model. The tier sets the speed and marks the ball golden (super). Returns true if a ball
   * was thrown. Called by the QTE flow on a successful click; a miss never calls this.
   */
  throwBackflipQte(side: HandSide, movement: MovementSnapshot, tier: number): boolean {
    const hand = this.getHand(side);
    if (!hand.ball) return false;
    this.fireThrow(side, movement, 0, tier);
    return true;
  }

  /** Pick the hand to use for a backflip throw (prefer left/dominant, else right). Null if empty. */
  backflipThrowHand(): HandSide | null {
    if (this.left.ball) return 'left';
    if (this.right.ball) return 'right';
    return null;
  }

  private throwFromHand(side: HandSide, movement: MovementSnapshot): void {
    const hand = this.getHand(side);
    if (!hand.ball) return;
    // Dashing allows quick throws only.
    const charge01 = movement.dashingThisFrame ? 0 : Math.min(1, hand.chargeSeconds / TUNING.ball.maxChargeSeconds);
    this.fireThrow(side, movement, charge01, 0);
  }

  private fireThrow(side: HandSide, movement: MovementSnapshot, charge01: number, backflipTier: number): void {
    const hand = this.getHand(side);
    if (!hand.ball) return;

    const rushed = this.lastThrowTime > -900 && this.elapsed - this.lastThrowTime < TUNING.ball.secondThrowDelaySeconds;

    const forward = cameraForward(this.camera);
    const throwResult = this.throwSystem.calculateThrow({
      hand: side,
      cameraForward: forward,
      playerVelocity: movement.velocity,
      charge01,
      isCrouching: movement.crouching,
      isSliding: movement.sliding,
      isWallRunning: movement.wallRunning,
      isDashing: movement.dashingThisFrame,
      backflipTier,
      fastDoubleThrowPenalty: rushed
    });

    const origin = this.camera.globalPosition.add(forward.scale(0.8));
    this.ballManager.throwBall(hand.ball, origin, throwResult.velocity, throwResult.velocity.length(), 'player', throwResult.isSuper, throwResult.dropScale, throwResult.curveAccel);

    const throwLabel = backflipTier >= 1
      ? `backflip T${backflipTier}`
      : charge01 >= 0.25 ? `charged ${Math.round(charge01 * 100)}%` : 'quick';
    this.lastAction = `${throwLabel} throw #${hand.ball.id} (${side})`;
    hand.ball = null;
    hand.visualHolding = false;
    hand.charging = false;
    hand.chargeSeconds = 0;
    this.playThrowAnimation(side);
    this.lastThrowTime = this.elapsed;
    this.effects.playerThrow();
  }
}

function dropReleaseVelocity(playerVelocity: Vector3): Vector3 {
  return new Vector3(
    playerVelocity.x,
    Math.min(playerVelocity.y, 0) - 1.4,
    playerVelocity.z
  );
}
