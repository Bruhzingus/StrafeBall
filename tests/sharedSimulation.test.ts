import { describe, it, expect } from 'vitest';
import { GAME_CONSTANTS } from '../shared/constants';
import type { PlayerHandsState } from '../shared/types';
import { applyBallBounce, createBallState, settleBallIfSlow } from '../shared/simulation/BallSim';
import {
  autoParryBall,
  catchBallInHand,
  dropBallFromHand,
  heldBallCount,
  throwBallFromHand,
  tryPickupBall
} from '../shared/simulation/HandSim';
import { createRoomState, registerPlayerHit } from '../shared/simulation/MatchSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import { stepMovement } from '../shared/simulation/MovementSim';
import {
  createBleacherCollisionBoxes,
  createBleacherPanelSpecs,
  createBleacherTierSpecs,
  type AABB
} from '../shared/simulation/MapGeometry';
import { playerBodyHeight } from '../shared/simulation/PlayerHitbox';
import { advanceNoBoundariesTimer, applyHalfCourtRule, applyScore, createMatchState } from '../shared/simulation/RuleSim';
import { vec3 } from '../shared/simulation/CollisionMath';
import { backflipQteTier, backflipQteSpeed } from '../shared/simulation/ThrowMath';
import type { PlayerInput } from '../shared/types';

function ok<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error((result as unknown as { ok: false; reason: string }).reason);
  return result as Extract<T, { ok: true }>;
}

function pickUpTwoBalls(): { hands: PlayerHandsState } {
  const player = createPlayerState('p1', 'blue');
  const first = ok(tryPickupBall(player, player.hands, createBallState('b1', vec3())));
  const second = ok(tryPickupBall(player, first.hands, createBallState('b2', vec3(0.1, 0, 0))));
  return { hands: second.hands };
}

function neutralInput(): PlayerInput {
  return {
    sequence: 0,
    clientTimeMs: 0,
    moveX: 0,
    moveZ: 0,
    dashDirection: vec3(),
    lookYawRadians: 0,
    lookPitchRadians: 0,
    jumpPressed: false,
    jumpHeld: false,
    dashPressed: false,
    crouchPressed: false,
    crouchHeld: false,
    slidePressed: false,
    slideHeld: false,
    backflipPressed: false,
    pickupPressed: false,
    dropPressed: false,
    fakeThrowPressed: false,
    fakeThrowHeld: false,
    leftHandPressed: false,
    leftHandHeld: false,
    rightHandPressed: false,
    rightHandHeld: false,
    leftHandReleased: false,
    rightHandReleased: false,
    leftCatchAttemptId: 0,
    rightCatchAttemptId: 0,
    backflipThrowTier: 0,
    resetSerial: 0,
    interactHeld: false
  };
}

function containsPoint(box: AABB, x: number, y: number, z: number): boolean {
  return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ;
}

describe('shared hand and pickup simulation', () => {
  it('first pickup goes to the left hand', () => {
    const player = createPlayerState('p1', 'blue');
    const ball = createBallState('b1', vec3());

    const result = ok(tryPickupBall(player, player.hands, ball));

    expect(result.hand).toBe('left');
    expect(result.hands.left.heldBallId).toBe('b1');
    expect(result.ball.phase).toBe('held');
    expect(result.ball.heldHand).toBe('left');
  });

  it('allows at most two held balls', () => {
    const player = createPlayerState('p1', 'blue');
    const first = ok(tryPickupBall(player, player.hands, createBallState('b1', vec3())));
    const second = ok(tryPickupBall(player, first.hands, createBallState('b2', vec3(0.1, 0, 0))));

    expect(second.hand).toBe('right');
    expect(heldBallCount(second.hands)).toBe(2);
  });

  it('pickup fails when both hands are full', () => {
    const player = createPlayerState('p1', 'blue');
    const { hands } = pickUpTwoBalls();

    const result = tryPickupBall(player, hands, createBallState('b3', vec3(0.2, 0, 0)));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('hands-full');
  });
});

describe('shared movement simulation', () => {
  it('conserves airborne momentum when only W is held', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 1, 0);
    player.movement.velocity = vec3(0, 0, 10);
    player.movement.grounded = false;

    const input = { ...neutralInput(), moveZ: 1 };
    const next = stepMovement(player.movement, player.movementInternal, player.dash, input, neutralInput(), 1 / 72, [], false);

    expect(next.movement.velocity.x).toBeCloseTo(0, 6);
    expect(next.movement.velocity.z).toBeCloseTo(10, 6);
  });

  it('uses A/D for airborne strafe acceleration', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 1, 0);
    player.movement.velocity = vec3(0, 0, 10);
    player.movement.grounded = false;

    const input = { ...neutralInput(), moveX: 1 };
    const next = stepMovement(player.movement, player.movementInternal, player.dash, input, neutralInput(), 1 / 72, [], false);

    expect(next.movement.velocity.x).toBeGreaterThan(0);
    expect(next.movement.velocity.z).toBeCloseTo(10, 6);
  });

  it('gains meaningful speed from sustained air-strafing while turning', () => {
    let player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 3, 0);
    player.movement.velocity = vec3(8, 0, 0);
    player.movement.grounded = false;

    let movement = player.movement;
    let internal = player.movementInternal;
    let dash = player.dash;
    let prev = neutralInput();
    const dt = 1 / 72;

    for (let i = 0; i < 36; i += 1) {
      const yaw = Math.atan2(movement.velocity.x, movement.velocity.z);
      const input = { ...neutralInput(), moveX: 1, lookYawRadians: yaw };
      const next = stepMovement(movement, internal, dash, input, prev, dt, [], false);
      movement = next.movement;
      internal = next.internal;
      dash = next.dash;
      prev = input;
    }

    expect(movement.speed).toBeGreaterThan(8.5);
  });

  it('does not bleed high horizontal speed while airborne', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 1, 0);
    player.movement.velocity = vec3(GAME_CONSTANTS.player.softSpeedLimit + 4, 0, 0);
    player.movement.grounded = false;

    const next = stepMovement(player.movement, player.movementInternal, player.dash, neutralInput(), neutralInput(), 1 / 72, [], false);

    expect(next.movement.velocity.x).toBeCloseTo(GAME_CONSTANTS.player.softSpeedLimit + 4, 6);
  });

  it('preserves horizontal momentum during the bhop landing grace window', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 0, 0);
    player.movement.velocity = vec3(12, -1, 0);
    player.movement.grounded = false;

    const landed = stepMovement(player.movement, player.movementInternal, player.dash, neutralInput(), neutralInput(), 1 / 72, [], false);
    expect(landed.movement.grounded).toBe(true);
    expect(landed.internal.jumpGraceTimer).toBeGreaterThan(0);
    expect(landed.movement.speed).toBeCloseTo(12, 5);

    const hopped = stepMovement(
      landed.movement,
      landed.internal,
      landed.dash,
      { ...neutralInput(), jumpPressed: true },
      neutralInput(),
      1 / 72,
      [],
      false
    );

    expect(hopped.movement.grounded).toBe(false);
    expect(hopped.movement.speed).toBeGreaterThan(12);
  });

  it('allows one dash-powered double jump before landing', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 1, 0);
    player.movement.velocity = vec3(0, -2, 0);
    player.movement.grounded = false;

    const jump = { ...neutralInput(), jumpPressed: true };
    const first = stepMovement(player.movement, player.movementInternal, player.dash, jump, neutralInput(), 1 / 72, [], false);

    expect(first.dash.charges).toBe(GAME_CONSTANTS.dash.maxCharges - 1);
    expect(first.movement.velocity.y).toBeGreaterThan(0);
    expect(first.internal.doubleJumpAvailable).toBe(false);
    expect(first.movement.dashingThisFrame).toBe(true);

    const second = stepMovement(first.movement, first.internal, first.dash, jump, neutralInput(), 1 / 72, [], false);
    expect(second.dash.charges).toBe(first.dash.charges);
    expect(second.internal.doubleJumpAvailable).toBe(false);
  });

  it('overholding a slide brakes the player down to a stop instead of preserving momentum', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.velocity = vec3(8, 0, 0);
    player.movement.grounded = true;

    let state = stepMovement(
      player.movement,
      player.movementInternal,
      player.dash,
      { ...neutralInput(), slidePressed: true, slideHeld: true, crouchHeld: true },
      neutralInput(),
      1 / 72,
      [],
      false
    );

    const held = { ...neutralInput(), slideHeld: true, crouchHeld: true };
    const steps = Math.ceil((GAME_CONSTANTS.slide.overholdBrakeDelay + 0.8) * 72);
    for (let i = 0; i < steps; i += 1) {
      state = stepMovement(state.movement, state.internal, state.dash, held, held, 1 / 72, [], false);
    }

    expect(state.movement.speed).toBeLessThan(1);
    expect(state.movement.sliding).toBe(false);
  });

  it('buffers held crouch in the air and starts sliding on landing', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 0, 0);
    player.movement.velocity = vec3(0, -4, 9);
    player.movement.grounded = false;

    const heldCrouch = { ...neutralInput(), crouchHeld: true };
    const next = stepMovement(player.movement, player.movementInternal, player.dash, heldCrouch, neutralInput(), 1 / 72, [], false);

    expect(next.movement.grounded).toBe(true);
    expect(next.movement.sliding).toBe(true);
  });

  it('preserves high horizontal speed when entering slide', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.velocity = vec3(0, 0, 13);
    player.movement.grounded = true;

    const next = stepMovement(
      player.movement,
      player.movementInternal,
      player.dash,
      { ...neutralInput(), slidePressed: true, slideHeld: true },
      neutralInput(),
      1 / 72,
      [],
      false
    );

    expect(next.movement.sliding).toBe(true);
    expect(next.movement.speed).toBeGreaterThan(12);
  });

  it('uses crouch height for crouch and 80 percent height for slide', () => {
    expect(playerBodyHeight({ crouching: true, sliding: false })).toBeCloseTo(
      GAME_CONSTANTS.player.height * GAME_CONSTANTS.player.crouchHeightMultiplier,
      6
    );
    expect(playerBodyHeight({ crouching: true, sliding: true })).toBeCloseTo(
      GAME_CONSTANTS.player.height * GAME_CONSTANTS.slide.heightScale,
      6
    );
  });

  it('drops wall-run before the player can repeatedly boost into the ceiling', () => {
    const player = createPlayerState('p1', 'blue');
    const bodyHeight = GAME_CONSTANTS.player.height;
    const maxPlayerY = GAME_CONSTANTS.map.wallHeight - bodyHeight - GAME_CONSTANTS.player.ceilingClearance;
    player.movement.position = vec3(
      GAME_CONSTANTS.map.halfWidth - GAME_CONSTANTS.player.radius,
      maxPlayerY - GAME_CONSTANTS.wall.ceilingDetachDistance * 0.5,
      0
    );
    player.movement.velocity = vec3(0, 2, GAME_CONSTANTS.wall.minEntrySpeed + 3);
    player.movement.grounded = false;
    player.movement.wallRunning = true;
    player.movementInternal.wallRunTimer = 0.2;
    player.movementInternal.lastWallNormalX = -1;

    const next = stepMovement(player.movement, player.movementInternal, player.dash, neutralInput(), neutralInput(), 1 / 72, [], false);

    expect(next.movement.position.y).toBeLessThanOrEqual(maxPlayerY);
    expect(next.movement.wallRunning).toBe(false);
    expect(next.internal.wallRunTimer).toBe(0);
    expect(next.internal.wallReattachCooldown).toBeGreaterThan(0);

    const forward = { ...neutralInput(), moveZ: 1 };
    const after = stepMovement(next.movement, next.internal, next.dash, forward, forward, 1 / 72, [], false);
    expect(after.movement.wallRunning).toBe(false);
  });

  // Wall-run vertical is controlled by A/D while holding W. Player hugs the +X wall (normal = -X),
  // facing +Z (yaw 0), so right = +X points INTO the wall: D (moveX +1) steers into the wall (climb),
  // A (moveX -1) steers away (descend). W alone runs straight (holds height). A/D without W: nothing.
  it('descends during a wall-run when steering away from the wall (W + away strafe)', () => {
    const dt = 1 / 72;
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(GAME_CONSTANTS.map.halfWidth - GAME_CONSTANTS.player.radius, 4, 0);
    player.movement.velocity = vec3(0, 0, GAME_CONSTANTS.wall.minEntrySpeed + 3);
    player.movement.grounded = false;
    player.movement.wallRunning = true;
    player.movementInternal.lastWallNormalX = -1;

    // W + A (moveX -1) = steer away from the wall = descend.
    const wPlusAway = { ...neutralInput(), moveZ: 1, moveX: -1 };
    let state = stepMovement(player.movement, player.movementInternal, player.dash, wPlusAway, neutralInput(), dt, [], false);
    const startY = state.movement.position.y;
    for (let i = 0; i < 20; i += 1) {
      state = stepMovement(state.movement, state.internal, state.dash, wPlusAway, wPlusAway, dt, [], false);
    }

    expect(state.movement.wallRunning).toBe(true);
    expect(state.movement.velocity.y).toBeLessThan(0);
    expect(state.movement.position.y).toBeLessThan(startY);
  });

  it('climbs during a wall-run when steering into the wall (W + into strafe)', () => {
    const dt = 1 / 72;
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(GAME_CONSTANTS.map.halfWidth - GAME_CONSTANTS.player.radius, 2, 0);
    player.movement.velocity = vec3(0, 0, GAME_CONSTANTS.wall.minEntrySpeed + 3);
    player.movement.grounded = false;
    player.movement.wallRunning = true;
    player.movementInternal.lastWallNormalX = -1;

    // W + D (moveX +1) = steer into the wall = climb.
    const wPlusInto = { ...neutralInput(), moveZ: 1, moveX: 1 };
    let state = stepMovement(player.movement, player.movementInternal, player.dash, wPlusInto, neutralInput(), dt, [], false);
    const startY = state.movement.position.y;
    for (let i = 0; i < 10; i += 1) {
      state = stepMovement(state.movement, state.internal, state.dash, wPlusInto, wPlusInto, dt, [], false);
    }

    expect(state.movement.velocity.y).toBeGreaterThan(0);
    expect(state.movement.position.y).toBeGreaterThan(startY);
  });

  it('applies real gravity once a wall-run held straight (W only) passes the gravity delay', () => {
    const dt = 1 / 72;
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(GAME_CONSTANTS.map.halfWidth - GAME_CONSTANTS.player.radius, 4, 0);
    player.movement.velocity = vec3(0, 0, GAME_CONSTANTS.wall.minEntrySpeed + 3);
    player.movement.grounded = false;
    player.movement.wallRunning = true;
    player.movementInternal.lastWallNormalX = -1;

    // W only (moveX 0) = hold straight, no strafe.
    const straight = { ...neutralInput(), moveZ: 1 };
    let state = stepMovement(player.movement, player.movementInternal, player.dash, straight, neutralInput(), dt, [], false);
    const ticksPastDelay = Math.ceil(GAME_CONSTANTS.wall.runGravityDelaySeconds / dt) + 5;
    for (let i = 0; i < ticksPastDelay; i += 1) {
      state = stepMovement(state.movement, state.internal, state.dash, straight, straight, dt, [], false);
    }

    expect(state.internal.wallRunTimer).toBeGreaterThanOrEqual(GAME_CONSTANTS.wall.runGravityDelaySeconds);
    expect(state.movement.wallRunning).toBe(true);
    expect(state.movement.velocity.y).toBeLessThan(0);
  });

  it('does not adjust wall-run height from A/D without holding W', () => {
    const dt = 1 / 72;
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(GAME_CONSTANTS.map.halfWidth - GAME_CONSTANTS.player.radius, 3, 0);
    player.movement.velocity = vec3(0, 0, GAME_CONSTANTS.wall.minEntrySpeed + 3);
    player.movement.grounded = false;
    player.movement.wallRunning = true;
    player.movementInternal.lastWallNormalX = -1;

    // D (into the wall) WITHOUT W: must NOT climb. Vertical should follow residual wall gravity
    // (drift down), never rise from the A/D input.
    const intoNoForward = { ...neutralInput(), moveZ: 0, moveX: 1 };
    let state = stepMovement(player.movement, player.movementInternal, player.dash, intoNoForward, neutralInput(), dt, [], false);
    const startY = state.movement.position.y;
    for (let i = 0; i < 12; i += 1) {
      state = stepMovement(state.movement, state.internal, state.dash, intoNoForward, intoNoForward, dt, [], false);
    }

    expect(state.movement.velocity.y).toBeLessThanOrEqual(0);
    expect(state.movement.position.y).toBeLessThan(startY);
  });

  it('does not shrink the body or sap momentum when crouch is held in the air', () => {
    const dt = 1 / 72;
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 3, 0);
    player.movement.velocity = vec3(0, 1, 9);
    player.movement.grounded = false;

    const heldCrouch = { ...neutralInput(), crouchHeld: true };
    const next = stepMovement(player.movement, player.movementInternal, player.dash, heldCrouch, neutralInput(), dt, [], false);

    // Crouch in the air must not register as crouching (which would shrink the hitbox and perturb
    // air-strafe momentum); the horizontal speed must be preserved.
    expect(next.movement.crouching).toBe(false);
    expect(Math.hypot(next.movement.velocity.x, next.movement.velocity.z)).toBeCloseTo(9, 5);
  });
});

describe('shared ball state transitions', () => {
  it('held becomes live on throw', () => {
    const player = createPlayerState('p1', 'blue');
    const pickup = ok(tryPickupBall(player, player.hands, createBallState('b1', vec3())));

    const thrown = ok(throwBallFromHand(player, pickup.hands, 'left', pickup.ball, {
      origin: vec3(0, 1, 0),
      velocity: vec3(0, 0, 24),
      isSuper: false,
      dropScale: GAME_CONSTANTS.ball.quickDropScale
    }));

    expect(thrown.ball.phase).toBe('live');
    expect(thrown.ball.heldHand).toBeNull();
    expect(thrown.hands.left.heldBallId).toBeNull();
  });

  it('live becomes dead and then loose after a bounce and settle', () => {
    const live = createBallState('b1', vec3(), {
      phase: 'live',
      velocity: vec3(0, -2, 0),
      ownerKind: 'player',
      ownerId: 'p1'
    });

    const bounced = applyBallBounce(live);
    const settled = settleBallIfSlow({ ...bounced, velocity: vec3() });

    expect(bounced.phase).toBe('dead');
    expect(settled.phase).toBe('loose');
  });

  it('live becomes held on catch', () => {
    const player = createPlayerState('p1', 'blue');
    const live = createBallState('b1', vec3(0, 0, 1), {
      phase: 'live',
      velocity: vec3(0, 0, -10),
      ownerKind: 'launcher'
    });

    const caught = ok(catchBallInHand(
      player,
      player.hands,
      'left',
      live,
      vec3(0, 0, 1)
    ));

    expect(caught.ball.phase).toBe('held');
    expect(caught.ball.heldByPlayerId).toBe('p1');
    expect(caught.hands.left.heldBallId).toBe('b1');
  });

  it('dropping a held ball releases it downward instead of hovering', () => {
    const player = createPlayerState('p1', 'blue');
    const pickup = ok(tryPickupBall(player, player.hands, createBallState('b1', vec3())));

    const dropped = ok(dropBallFromHand(pickup.hands, 'left', pickup.ball, vec3(0, 1, 0)));

    expect(dropped.ball.phase).toBe('dead');
    expect(dropped.ball.velocity.y).toBeLessThan(0);
    expect(dropped.ball.heldByPlayerId).toBeNull();
  });

  it('live becomes deflected on auto-parry', () => {
    const player = createPlayerState('p1', 'blue');
    const { hands } = pickUpTwoBalls();
    const threat = createBallState('threat', vec3(0, 0, 0.5), {
      phase: 'live',
      velocity: vec3(0, 0, -20),
      ownerKind: 'launcher'
    });

    const parried = ok(autoParryBall(player, hands, threat, vec3(0, 0, 1), 0));

    expect(parried.ball.phase).toBe('deflected');
    expect(parried.ball.ownerKind).toBe('player');
    expect(parried.parryCooldownSeconds).toBe(GAME_CONSTANTS.parry.cooldownSeconds);
  });

  it('deflected becomes dead and then loose', () => {
    const deflected = createBallState('b1', vec3(), {
      phase: 'deflected',
      velocity: vec3(0, 1, 0),
      ownerKind: 'player',
      ownerId: 'p1'
    });

    const bounced = applyBallBounce(deflected);
    const settled = settleBallIfSlow({ ...bounced, velocity: vec3() });

    expect(bounced.phase).toBe('dead');
    expect(settled.phase).toBe('loose');
  });
});

describe('shared scoring and match rules', () => {
  it('a hit grants score and one dash charge', () => {
    const player = createPlayerState('p1', 'blue', 'negativeZ', {
      dash: {
        charges: GAME_CONSTANTS.dash.maxCharges - 1,
        rechargeTimerSeconds: 1,
        cooldownSeconds: 0
      }
    });
    const room = createRoomState({ players: [player] });

    const next = registerPlayerHit(room, 'p1');

    expect(next.match.scoreByTeamId.blue).toBe(1);
    expect(next.players.p1.dash.charges).toBe(GAME_CONSTANTS.dash.maxCharges);
  });

  it('first to 5 wins the match', () => {
    let match = createMatchState('m1', ['blue', 'red'], {
      scoreByTeamId: { blue: GAME_CONSTANTS.match.scoreLimit - 1, red: 0 }
    });

    match = applyScore(match, 'blue');

    expect(match.status).toBe('complete');
    expect(match.winnerTeamId).toBe('blue');
    expect(match.scoreByTeamId.blue).toBe(GAME_CONSTANTS.match.scoreLimit);
  });
});

describe('shared half-court rules', () => {
  it('first illegal cross warns', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));

    expect(match.boundary.lastEvent.type).toBe('half-court-warning');
    expect(match.boundary.illegalCrossByPlayerId.p1.warningsIssued).toBe(1);
    expect(match.scoreByTeamId.red).toBe(0);
  });

  it('staying across after the warning starts the penalty countdown without a cross-back', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    // Tick 1: cross spends the warning. No penalty yet, but the countdown is now armed.
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    // Tick 2: still across — the penalty countdown must now ACTIVATE on its own (the old behavior
    // left it dormant until the player crossed back and re-crossed, so damage never ticked).
    match = applyHalfCourtRule(
      match,
      'p1',
      'blue',
      'negativeZ',
      vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1),
      GAME_CONSTANTS.match.illegalCrossPenaltyIntervalSeconds - 0.1
    );

    expect(match.boundary.lastEvent.type).toBe('none');
    expect(match.boundary.illegalCrossByPlayerId.p1.deathCountdownActive).toBe(true);
    expect(match.boundary.illegalCrossByPlayerId.p1.countdownSeconds).toBeCloseTo(0.1, 5);
    expect(match.boundary.illegalCrossByPlayerId.p1.penaltiesIssued).toBe(0);
    expect(match.scoreByTeamId.red).toBe(0);

    // Tick 3: the remaining countdown elapses while still across → one penalty hit, no cross-back.
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1), 0.11);

    expect(match.boundary.lastEvent.type).toBe('half-court-penalty');
    expect(match.boundary.illegalCrossByPlayerId.p1.penaltiesIssued).toBe(1);
    expect(match.scoreByTeamId.red).toBe(1);
  });

  it('re-crossing after the warning applies one penalty hit per second', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, -1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    match = applyHalfCourtRule(
      match,
      'p1',
      'blue',
      'negativeZ',
      vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1),
      GAME_CONSTANTS.match.illegalCrossPenaltyIntervalSeconds + 0.01
    );

    expect(match.boundary.lastEvent.type).toBe('half-court-penalty');
    expect(match.boundary.illegalCrossByPlayerId.p1.eliminationIssued).toBe(false);
    expect(match.boundary.illegalCrossByPlayerId.p1.penaltiesIssued).toBe(1);
    expect(match.boundary.illegalCrossByPlayerId.p1.countdownSeconds).toBeCloseTo(0.99, 5);
    expect(match.scoreByTeamId.red).toBe(1);
  });

  it('only issues the warning once, then penalizes future crossings', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, -1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));

    expect(match.boundary.lastEvent.type).toBe('none');
    expect(match.boundary.illegalCrossByPlayerId.p1.warningsIssued).toBe(1);

    match = applyHalfCourtRule(
      match,
      'p1',
      'blue',
      'negativeZ',
      vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1),
      GAME_CONSTANTS.match.illegalCrossPenaltyIntervalSeconds
    );

    expect(match.boundary.lastEvent.type).toBe('half-court-penalty');
    expect(match.scoreByTeamId.red).toBe(1);
  });

  it('leaving your side before the penalty tick clears the active countdown', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, -1));

    expect(match.boundary.illegalCrossByPlayerId.p1.deathCountdownActive).toBe(false);
    expect(match.boundary.illegalCrossByPlayerId.p1.countdownSeconds).toBe(GAME_CONSTANTS.match.illegalCrossPenaltyIntervalSeconds);
  });

  it('no-boundaries disables the half-court rule', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = advanceNoBoundariesTimer(match, GAME_CONSTANTS.match.noBoundariesSeconds);
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));

    expect(match.boundary.noBoundaries).toBe(true);
    expect(match.boundary.illegalCrossByPlayerId.p1.illegalCrossCount).toBe(0);
    expect(match.scoreByTeamId.red).toBe(0);
  });
});

describe('backflip QTE tiers', () => {
  const { hitHalfWidth, tierCount } = GAME_CONSTANTS.backflip.qte;

  it('dead-center is the top tier and equals the fastest speed', () => {
    expect(backflipQteTier(0)).toBe(tierCount);
    const topMultiplier = GAME_CONSTANTS.backflip.qte.tierSpeedMultipliers[tierCount - 1];
    expect(backflipQteSpeed(tierCount)).toBeCloseTo(GAME_CONSTANTS.ball.quickThrowSpeed * topMultiplier, 5);
  });

  it('the edge of the hit zone is the slowest tier (a regular quick throw)', () => {
    const edge = backflipQteTier(hitHalfWidth - 1e-6);
    expect(edge).toBe(1);
    expect(backflipQteSpeed(1)).toBeCloseTo(GAME_CONSTANTS.ball.quickThrowSpeed, 5);
  });

  it('clicks outside the hit half-width are a miss (tier 0)', () => {
    expect(backflipQteTier(hitHalfWidth + 0.05)).toBe(0);
    expect(backflipQteTier(-1)).toBe(0);
    expect(backflipQteTier(1)).toBe(0);
  });

  it('tiers decrease monotonically as the click moves away from center', () => {
    const tiers = [0, 0.2, 0.4, 0.55].map((o) => backflipQteTier(o * hitHalfWidth));
    for (let i = 1; i < tiers.length; i++) {
      expect(tiers[i]).toBeLessThanOrEqual(tiers[i - 1]);
    }
    expect(tiers[0]).toBe(tierCount); // center band is the best
  });

  it('the center (top) band is narrower than an outer band', () => {
    const edges = GAME_CONSTANTS.backflip.qte.tierBandEdges;
    const centerWidth = edges[0];                 // top-tier band: [0, edge0]
    const outerWidth = edges[edges.length - 1] - edges[edges.length - 2]; // slowest band
    expect(centerWidth).toBeLessThan(outerWidth);
  });
});

describe('shared map geometry', () => {
  it('uses visible end-cap rail and fascia boxes instead of a hidden solid bleacher side panel', () => {
    const boxes = createBleacherCollisionBoxes();
    expect(boxes.some((box) => box.id === 'bleacher_south_side_-1')).toBe(false);
    expect(boxes.some((box) => box.id?.startsWith('bleacher_endcap_rail_top_'))).toBe(true);

    const southWestPanel = createBleacherPanelSpecs().find((panel) => panel.side === -1 && panel.name === 'south_side');
    expect(southWestPanel).toBeTruthy();
    const westTiers = createBleacherTierSpecs().filter((tier) => tier.side === -1).sort((a, b) => a.step - b.step);
    const innerX = westTiers[0].center.x + westTiers[0].size.width / 2;
    const openGapX = innerX - 0.85;
    const openGapY = 0.1;
    const openGapZ = southWestPanel!.center.z;

    expect(boxes.some((box) => containsPoint(box, openGapX, openGapY, openGapZ))).toBe(false);
  });
});
