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

  it('does not bleed high horizontal speed while airborne', () => {
    const player = createPlayerState('p1', 'blue');
    player.movement.position = vec3(0, 1, 0);
    player.movement.velocity = vec3(GAME_CONSTANTS.player.softSpeedLimit + 4, 0, 0);
    player.movement.grounded = false;

    const next = stepMovement(player.movement, player.movementInternal, player.dash, neutralInput(), neutralInput(), 1 / 72, [], false);

    expect(next.movement.velocity.x).toBeCloseTo(GAME_CONSTANTS.player.softSpeedLimit + 4, 6);
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

  it('staying across after the red warning starts a death countdown, then eliminates', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    match = applyHalfCourtRule(
      match,
      'p1',
      'blue',
      'negativeZ',
      vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1),
      GAME_CONSTANTS.match.illegalCrossDeathCountdownSeconds - 0.1
    );

    expect(match.boundary.lastEvent.type).toBe('none');
    expect(match.boundary.illegalCrossByPlayerId.p1.deathCountdownActive).toBe(true);
    expect(match.boundary.illegalCrossByPlayerId.p1.countdownSeconds).toBeCloseTo(0.1, 5);
    expect(match.scoreByTeamId.red).toBe(0);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1), 0.11);

    expect(match.boundary.lastEvent.type).toBe('half-court-elimination');
    expect(match.boundary.illegalCrossByPlayerId.p1.eliminationIssued).toBe(true);
    expect(match.scoreByTeamId.red).toBe(0);
  });

  it('leaving your side before the countdown expires clears the active countdown', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, -1));

    expect(match.boundary.illegalCrossByPlayerId.p1.deathCountdownActive).toBe(false);
    expect(match.boundary.illegalCrossByPlayerId.p1.countdownSeconds).toBe(GAME_CONSTANTS.match.illegalCrossDeathCountdownSeconds);
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
