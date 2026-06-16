import { describe, it, expect } from 'vitest';
import { GAME_CONSTANTS } from '../shared/constants';
import type { PlayerHandsState } from '../shared/types';
import { applyBallBounce, createBallState, settleBallIfSlow } from '../shared/simulation/BallSim';
import {
  autoParryBall,
  catchBallInHand,
  heldBallCount,
  throwBallFromHand,
  tryPickupBall
} from '../shared/simulation/HandSim';
import { createRoomState, registerPlayerHit } from '../shared/simulation/MatchSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import { advanceNoBoundariesTimer, applyHalfCourtRule, applyScore, createMatchState } from '../shared/simulation/RuleSim';
import { vec3 } from '../shared/simulation/CollisionMath';

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
      vec3(0, 0, 1),
      GAME_CONSTANTS.catch.trackingSeconds
    ));

    expect(caught.ball.phase).toBe('held');
    expect(caught.ball.heldByPlayerId).toBe('p1');
    expect(caught.hands.left.heldBallId).toBe('b1');
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

  it('second illegal cross gives the opponent one hit', () => {
    let match = createMatchState('m1', ['blue', 'red']);

    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, -1));
    match = applyHalfCourtRule(match, 'p1', 'blue', 'negativeZ', vec3(0, 0, GAME_CONSTANTS.match.halfCourtLineZ + 0.1));

    expect(match.boundary.lastEvent.type).toBe('half-court-penalty');
    expect(match.boundary.illegalCrossByPlayerId.p1.penaltiesIssued).toBe(1);
    expect(match.scoreByTeamId.red).toBe(GAME_CONSTANTS.match.penaltyHitValue);
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
