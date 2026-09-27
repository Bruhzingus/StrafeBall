import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../shared/constants';
import { holdBall, createBallState } from '../shared/simulation/BallSim';
import { createRoomState } from '../shared/simulation/MatchSim';
import { createPlayerState } from '../shared/simulation/PlayerSim';
import { coachGlassesEligible } from '../src/game/effects/CoachGlassesEligibility';

describe('local Coach’s Glasses guide eligibility', () => {
  const setup = () => {
    const room = createRoomState({ players: [createPlayerState('local', 'blue'), createPlayerState('other', 'red', 'positiveZ')] });
    room.match.status = 'playing';
    const player = room.players.local;
    player.movementInternal.buffs = { speedSeconds: 0, adrenalineSeconds: 0, magnetSeconds: 0, cannonLocked: false, coachGlassesSeconds: 15 };
    room.balls.ball = holdBall(createBallState('ball'), player.id, 'left');
    player.hands.left.heldBallId = 'ball';
    const ready = (charge: number = C.ball.maxChargeSeconds, charging = true, animating = false, firstPerson = true, countdown = false) =>
      coachGlassesEligible(room, player, 'left', charge, charging, animating, firstPerson, countdown);
    return { room, player, ready };
  };

  it('shows only with a fully charged normal ball in the local first-person throw state', () => {
    const { room, player, ready } = setup();
    expect(ready()).toBe(true);
    expect(ready(C.ball.maxChargeSeconds - 0.02)).toBe(false);
    expect(ready(C.ball.maxChargeSeconds, false)).toBe(false);
    expect(ready(C.ball.maxChargeSeconds, true, true)).toBe(false);
    expect(ready(C.ball.maxChargeSeconds, true, false, false)).toBe(false);
    expect(ready(C.ball.maxChargeSeconds, true, false, true, true)).toBe(false);
    room.balls.ball.kind = 'cannon'; expect(ready()).toBe(false);
    room.balls.ball.kind = 'bomb'; expect(ready()).toBe(false);
    room.balls.ball.kind = 'normal'; expect(ready()).toBe(true);
    player.movementInternal.buffs!.coachGlassesSeconds = 0; expect(ready()).toBe(false);
  });

  it('hides on death, reset state, and ownership changes', () => {
    const { room, player, ready } = setup();
    player.combatState = 'eliminated'; expect(ready()).toBe(false);
    player.combatState = 'alive'; room.match.status = 'intermission'; expect(ready()).toBe(false);
    room.match.status = 'playing'; room.balls.ball.heldByPlayerId = 'other'; expect(ready()).toBe(false);
  });
});
