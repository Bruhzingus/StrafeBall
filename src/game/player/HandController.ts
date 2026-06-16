import { FreeCamera, Vector3 } from '@babylonjs/core';
import { CONTROL_KEYS, MOUSE_BUTTON } from '../config/controls';
import { TUNING } from '../config/tuning';
import { InputManager } from '../input/InputManager';
import { Ball } from '../ball/Ball';
import { BallManager } from '../ball/BallManager';
import { HandSide } from '../ball/BallState';
import { ThrowSystem } from '../ball/ThrowSystem';
import { cameraForward } from '../utils/vector';
import { safeNormalize } from '../utils/math';
import { MovementSnapshot } from './MovementController';
import { BackflipController } from './BackflipController';

export interface HandState {
  ball: Ball | null;
  charging: boolean;
  chargeSeconds: number;
  catchStance: boolean;
  // Catch-only cooldown (a missed/used catch). Does NOT gate throwing — throwing a held ball
  // is always immediate so the hands never feel like they're on a throw cooldown.
  cooldown: number;
}

function makeHand(): HandState {
  return { ball: null, charging: false, chargeSeconds: 0, catchStance: false, cooldown: 0 };
}

export class HandController {
  public left: HandState = makeHand();
  public right: HandState = makeHand();
  public lastThrowTime = -999;

  private readonly throwSystem = new ThrowSystem();
  private elapsed = 0;

  constructor(private readonly camera: FreeCamera, private readonly ballManager: BallManager, private readonly backflip: BackflipController) {}

  update(dt: number, input: InputManager, movement: MovementSnapshot): void {
    this.elapsed += dt;
    this.tickCooldowns(dt);
    this.handlePickupDrop(input, movement);
    this.handleHand(input, movement, 'left', MOUSE_BUTTON.leftHand);
    this.handleHand(input, movement, 'right', MOUSE_BUTTON.rightHand);
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

  forceCatchBall(side: HandSide, ball: Ball): void {
    const hand = this.getHand(side);
    if (hand.ball) return;
    hand.ball = ball;
    ball.setHeld(side);
    hand.catchStance = false;
    hand.charging = false;
    hand.chargeSeconds = 0;
    hand.cooldown = TUNING.catch.cooldownSeconds;
  }

  /** Detaches both hands (used when balls are reset so hands don't point at disposed meshes). */
  clearHands(): void {
    this.left = makeHand();
    this.right = makeHand();
  }

  dropOneBall(position: Vector3): void {
    if (this.right.ball) {
      this.ballManager.dropBall(this.right.ball, position.add(new Vector3(0.35, 1.0, 0)));
      this.right.ball = null;
      return;
    }
    if (this.left.ball) {
      this.ballManager.dropBall(this.left.ball, position.add(new Vector3(-0.35, 1.0, 0)));
      this.left.ball = null;
    }
  }

  /**
   * Positions held balls in the player's actual left/right hands, low on screen, in CAMERA
   * space (so left really stays left as you turn). Visual only — throws still originate from
   * the camera center so the offset can't break aim. Called per render frame for smoothness.
   */
  updateHeldVisuals(): void {
    if (!this.left.ball && !this.right.ball) return;
    // Camera matrix was already refreshed this frame by PlayerController before this call.
    const forward = cameraForward(this.camera);
    const flat = safeNormalize(new Vector3(forward.x, 0, forward.z), forward);
    const right = safeNormalize(Vector3.Cross(Vector3.Up(), flat));
    const base = this.camera.globalPosition.add(flat.scale(TUNING.hands.holdForward)).add(new Vector3(0, TUNING.hands.holdDrop, 0));

    if (this.left.ball) this.left.ball.mesh.position.copyFrom(base.subtract(right.scale(TUNING.hands.holdSide)));
    if (this.right.ball) this.right.ball.mesh.position.copyFrom(base.add(right.scale(TUNING.hands.holdSide)));
  }

  private tickCooldowns(dt: number): void {
    this.tickHand(this.left, dt);
    this.tickHand(this.right, dt);
  }

  private tickHand(hand: HandState, dt: number): void {
    hand.cooldown = Math.max(0, hand.cooldown - dt);
    if (hand.charging) {
      hand.chargeSeconds = Math.min(TUNING.ball.maxChargeSeconds, hand.chargeSeconds + dt);
    }
  }

  private handlePickupDrop(input: InputManager, movement: MovementSnapshot): void {
    if (input.wasKeyPressed(CONTROL_KEYS.drop)) {
      if (this.right.ball) {
        this.ballManager.dropBall(this.right.ball, movement.position.add(new Vector3(0.4, 1, 0)));
        this.right.ball = null;
      } else if (this.left.ball) {
        this.ballManager.dropBall(this.left.ball, movement.position.add(new Vector3(-0.4, 1, 0)));
        this.left.ball = null;
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
    hand.catchStance = false;
    hand.charging = false;
    hand.chargeSeconds = 0;
    hand.cooldown = 0;
    this.ballManager.attachHeldBall(candidate, side, candidate.mesh.position); // sets ball.state = Held
  }

  /**
   * Throw model (deliberately simple/responsive):
   *   - Empty hand: hold the button for catch stance.
   *   - Ball in hand: press starts a charge, release throws. A quick tap = ~no charge = quick
   *     throw; holding = charged throw. F cancels a charge. No throw cooldown.
   * The second of a rapid double throw is flagged "rushed" so it comes out slightly slower.
   */
  private handleHand(input: InputManager, movement: MovementSnapshot, side: HandSide, button: number): void {
    const hand = this.getHand(side);

    // Ignore mouse hand actions until the cursor is locked, so the click that engages pointer
    // lock doesn't accidentally start a throw/catch.
    if (!input.pointerLocked) {
      hand.catchStance = false;
      hand.charging = false;
      hand.chargeSeconds = 0;
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
      hand.charging = false;
      hand.chargeSeconds = 0;
      return;
    }

    if (hand.charging && mouseReleased) {
      this.throwFromHand(side, movement);
    }
  }

  private throwFromHand(side: HandSide, movement: MovementSnapshot): void {
    const hand = this.getHand(side);
    if (!hand.ball) return;

    // Dashing allows quick throws only.
    const charge01 = movement.dashingThisFrame ? 0 : Math.min(1, hand.chargeSeconds / TUNING.ball.maxChargeSeconds);
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
      isBackflipSuper: this.backflip.isSuperThrowWindow(),
      fastDoubleThrowPenalty: rushed
    });

    const origin = this.camera.globalPosition.add(forward.scale(0.8));
    this.ballManager.throwBall(hand.ball, origin, throwResult.velocity, throwResult.velocity.length(), 'player', throwResult.isSuper, throwResult.dropScale, throwResult.curveAccel);

    hand.ball = null;
    hand.charging = false;
    hand.chargeSeconds = 0;
    this.lastThrowTime = this.elapsed;
  }
}
