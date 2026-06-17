import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../../shared/constants';
import { length, vec3 } from '../../shared/simulation/CollisionMath';
import { backflipQteSpeed } from '../../shared/simulation/ThrowMath';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

/**
 * Skip the pre-round countdown for tests that exercise live combat/hits. A real match now starts in
 * a 5s 'countdown' (players pinned to spawn); these unit tests assert combat that only resolves once
 * status is 'playing', so they force it directly. Tests of the countdown itself do NOT call this.
 */
function playNow(loop: ServerGameLoop): void {
  loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
}

describe('ServerGameLoop', () => {
  it('assigns two players and rejects a third', () => {
    const loop = new ServerGameLoop('room');

    const p1 = loop.addPlayer('a', 'A');
    const p2 = loop.addPlayer('b', 'B');
    const p3 = loop.addPlayer('c', 'C');

    expect(p1?.spawnSide).toBe('negativeZ');
    expect(p2?.spawnSide).toBe('positiveZ');
    expect(p3).toBeNull();
  });

  it('server decides a contested pickup and does not duplicate the ball', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    loop.state.players.a.movement.position = vec3(0, 0, 0);
    loop.state.players.b.movement.position = vec3(0, 0, 0);

    const first = loop.handlePickup('a');
    const second = loop.handlePickup('b');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(loop.state.players.a.hands.left.heldBallId).toBeTruthy();
    expect(loop.state.players.b.hands.left.heldBallId).toBeTruthy();
    expect(loop.state.players.a.hands.left.heldBallId).not.toBe(loop.state.players.b.hands.left.heldBallId);
  });

  it('validates throws from held balls only', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.state.players.a.movement.position = vec3(0, 0, 0);

    expect(loop.handleThrow('a', { hand: 'left', direction: vec3(0, 0, 1), charge01: 0 }).ok).toBe(false);

    expect(loop.handlePickup('a').ok).toBe(true);
    const thrown = loop.handleThrow('a', { hand: 'left', direction: vec3(0, 0, 1), charge01: 0 });

    expect(thrown.ok).toBe(true);
    const ballId = Object.values(loop.state.balls).find((ball) => ball.phase === 'live')?.id;
    expect(ballId).toBeTruthy();
  });

  it('uses authoritative pitch when creating throw velocity', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.state.players.a.movement.position = vec3(0, 0, 0);

    loop.handleInput('a', { lookYawRadians: 0, lookPitchRadians: -0.5 }, 1);
    loop.step();
    expect(loop.handlePickup('a').ok).toBe(true);
    expect(loop.handleThrow('a', { hand: 'left' }).ok).toBe(true);

    const upward = Object.values(loop.state.balls).find((ball) => ball.phase === 'live');
    expect(upward?.velocity.y).toBeGreaterThan(0);
    expect(upward?.velocity.z).toBeGreaterThan(0);
  });

  it('uses yaw and pitch correctly from the opposite spawn side', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);
    loop.state.players.b.movement.position = vec3(0, 0, 0);

    loop.handleInput('b', { lookYawRadians: Math.PI, lookPitchRadians: 0.45 }, 1);
    loop.step();
    expect(loop.handlePickup('b').ok).toBe(true);
    expect(loop.handleThrow('b', { hand: 'left' }).ok).toBe(true);

    const downward = Object.values(loop.state.balls).find((ball) => ball.phase === 'live');
    expect(downward?.velocity.y).toBeLessThan(0);
    expect(downward?.velocity.z).toBeLessThan(0);
  });

  describe('Step 7 — side-wall / ceiling 1-bounce rule', () => {
    // Drive a single live ball toward a target surface and run sim steps until it leaves the
    // 'live'/'deflected' phase (or a step cap), returning how it ended up.
    function settleBall(loop: ServerGameLoop, ballId: string, maxSteps = 240): { phase: string; bounceCount: number } {
      for (let i = 0; i < maxSteps; i += 1) {
        loop.step();
        const b = loop.state.balls[ballId];
        if (b.phase !== 'live' && b.phase !== 'deflected') return { phase: b.phase, bounceCount: b.bounceCount };
      }
      const b = loop.state.balls[ballId];
      return { phase: b.phase, bounceCount: b.bounceCount };
    }

    it('keeps a live ball alive through its FIRST side-wall bounce, then kills it on the second', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      // A flat, fast ball near the +X wall aimed straight at it. Start close so the first wall
      // contact happens before gravity drops it to the floor (the floor would kill it first).
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live',
        ownerKind: 'player',
        ownerId: 'a',
        position: vec3(GAME_CONSTANTS.map.halfWidth - 1, 3, 0),
        velocity: vec3(40, 0, 0),
        bounceCount: 0
      };

      // Step until the first wall contact: the ball must SURVIVE it (still live, bounceCount === 1,
      // reflected back toward -X).
      let sawFirstBounce = false;
      for (let i = 0; i < 30; i += 1) {
        loop.step();
        const b = loop.state.balls.ball_0;
        if (b.bounceCount >= 1) {
          expect(b.phase).toBe('live');
          expect(b.bounceCount).toBe(1);
          expect(b.velocity.x).toBeLessThan(0);
          sawFirstBounce = true;
          break;
        }
      }
      expect(sawFirstBounce).toBe(true);

      // It is now heading back across the court; the SECOND wall/ceiling contact must kill it.
      const ended = settleBall(loop, 'ball_0');
      expect(ended.phase).not.toBe('live');
      expect(ended.bounceCount).toBeGreaterThanOrEqual(2);
    });

    it('kills a live ball on its FIRST floor bounce (floor is not part of the survive rule)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live',
        ownerKind: 'player',
        ownerId: 'a',
        position: vec3(0, 0.5, 0),
        velocity: vec3(0, -8, 0),
        bounceCount: 0
      };

      // First contact is the floor → dead immediately (becomes dead/loose), not a surviving bounce.
      const ended = settleBall(loop, 'ball_0', 30);
      expect(ended.phase).not.toBe('live');
    });
  });

  it('keeps a live ball alive through its FIRST ceiling bounce', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    const maxY = GAME_CONSTANTS.map.wallHeight - GAME_CONSTANTS.ball.radius;
    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      position: vec3(0, maxY - 0.1, 0),
      velocity: vec3(0, 20, 0),
      bounceCount: 0
    };

    loop.step();
    const ball = loop.state.balls.ball_0;
    expect(ball.phase).toBe('live');
    expect(ball.bounceCount).toBe(1);
    expect(ball.position.y).toBeLessThanOrEqual(maxY);
    expect(ball.velocity.y).toBeLessThan(0);
  });

  it('keeps players under the solid ceiling', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    const maxY = GAME_CONSTANTS.map.wallHeight - GAME_CONSTANTS.player.height - GAME_CONSTANTS.player.ceilingClearance;
    loop.state.players.a.movement.position = vec3(0, maxY + 0.2, 0);
    loop.state.players.a.movement.velocity = vec3(0, 10, 0);
    loop.state.players.a.movement.grounded = false;

    loop.handleInput('a', { sequence: 1 }, 1);
    loop.step();

    expect(loop.state.players.a.movement.position.y).toBeLessThanOrEqual(maxY);
    expect(loop.state.players.a.movement.velocity.y).toBeLessThanOrEqual(0);
  });

  describe('mats — block balls, knocked over by players', () => {
    // Pick a mat from the authoritative state to aim at.
    function firstMat(loop: ServerGameLoop) {
      const id = Object.keys(loop.state.mats)[0];
      return loop.state.mats[id];
    }

    it('bounces a live ball back off a standing mat (mats block balls)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      const mat = firstMat(loop);

      // A ball fired at moderate speed straight at the standing mat center along +X. The mat is solid
      // cover for balls now, so the ball should bounce off it (bounceCount increments) rather than
      // sail through. Moderate speed avoids tunneling so the bounce resolves cleanly on the near face.
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live',
        ownerKind: 'player',
        ownerId: 'a',
        position: vec3(mat.position.x - 1.5, mat.position.y, mat.position.z),
        velocity: vec3(12, 0, 0),
        bounceCount: 0
      };

      const steps = Math.ceil(loop.tickRate * 0.25);
      for (let i = 0; i < steps; i += 1) loop.step();
      const b = loop.state.balls.ball_0;
      expect(b.bounceCount).toBeGreaterThan(0);
      // After bouncing off the near (-X) face, the ball is travelling back toward -X, so it never
      // reaches the far side of the mat.
      expect(b.position.x).toBeLessThan(mat.position.x);
    });

    it('lets a ball pass over a knocked-over mat', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      playNow(loop);
      const mat = firstMat(loop);

      // Knock the mat down first by walking the player into it.
      loop.state.players.a.movement.position = vec3(mat.position.x, 0, mat.position.z - 0.6);
      loop.state.players.a.movement.velocity = vec3(0, 0, 4);
      loop.step();
      expect(loop.state.mats[mat.id].knockedOver).toBe(true);

      // Now a ball fired through the mat's old footprint should pass straight through, untouched.
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live',
        ownerKind: 'player',
        ownerId: 'a',
        position: vec3(mat.position.x - 1.5, mat.position.y, mat.position.z),
        velocity: vec3(50, 0, 0),
        bounceCount: 0
      };
      const steps = Math.ceil(loop.tickRate * 0.04);
      for (let i = 0; i < steps; i += 1) loop.step();
      const b = loop.state.balls.ball_0;
      expect(b.bounceCount).toBe(0);
      expect(b.position.x).toBeGreaterThan(mat.position.x);
    });

    it('knocks a mat over (and stays down) when a player walks into it', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      playNow(loop);
      const mat = firstMat(loop);
      expect(mat.knockedOver).toBe(false);

      // Place the player right at the mat's standing face with into-mat velocity, then step. step()
      // captures the pre-resolution velocity (what the knock-over rule uses) before movement runs.
      loop.state.players.a.movement.position = vec3(mat.position.x, 0, mat.position.z - 0.6);
      loop.state.players.a.movement.velocity = vec3(0, 0, 4);

      loop.step();

      const after = loop.state.mats[mat.id];
      expect(after.knockedOver).toBe(true);
      // knockDirection points the way the player pushed (toward +Z here), normalized.
      expect(after.knockDirection.z).toBeGreaterThan(0.5);
    });
  });

  it('server-side hit validation grants score and dash charge', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    loop.state.players.a.dash.charges = GAME_CONSTANTS.dash.maxCharges - 1;
    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
      velocity: vec3(0, 0, 24)
    };

    loop.step();

    expect(loop.state.match.scoreByTeamId.blue).toBe(1);
    expect(loop.state.players.a.score).toBe(1);
    expect(loop.state.players.a.dash.charges).toBe(GAME_CONSTANTS.dash.maxCharges);
    expect(loop.state.balls.ball_0.phase).toBe('dead');
  });

  it('does not score when a held or attached ball touches another player', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'held',
      ownerKind: 'player',
      ownerId: 'a',
      heldByPlayerId: 'a',
      heldHand: 'left',
      position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
      velocity: vec3(0, 0, 24)
    };

    loop.step();

    expect(loop.state.match.scoreByTeamId.blue).toBe(0);

    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      heldByPlayerId: 'a',
      heldHand: 'left',
      position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
      velocity: vec3(0, 0, 24)
    };

    loop.step();

    expect(loop.state.match.scoreByTeamId.blue).toBe(0);
  });

  it('does not score from slow live or dead ball contact', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    playNow(loop);

    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
      velocity: vec3(0, 0, GAME_CONSTANTS.ball.liveHitMinSpeed * 0.5)
    };

    loop.step();

    expect(loop.state.match.scoreByTeamId.blue).toBe(0);

    loop.state.balls.ball_0 = {
      ...loop.state.balls.ball_0,
      phase: 'dead',
      ownerKind: null,
      ownerId: null,
      heldByPlayerId: null,
      heldHand: null,
      position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
      velocity: vec3(0, 0, 24)
    };

    loop.step();

    expect(loop.state.match.scoreByTeamId.blue).toBe(0);
  });

  it('uses the shortened crouch hitbox for player hits', () => {
    const missLoop = new ServerGameLoop('room');
    missLoop.addPlayer('a', 'A');
    missLoop.addPlayer('b', 'B');
    playNow(missLoop);
    missLoop.handleInput('b', { crouchHeld: true }, 1);

    const crouchHeight = GAME_CONSTANTS.player.height * GAME_CONSTANTS.player.crouchHeightMultiplier;
    const combinedRadius = GAME_CONSTANTS.player.radius + GAME_CONSTANTS.ball.radius;
    const overCrouchedHeadY = crouchHeight + combinedRadius + 0.08;
    expect(overCrouchedHeadY).toBeLessThan(GAME_CONSTANTS.player.height + combinedRadius);

    missLoop.state.balls.ball_0 = {
      ...missLoop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      position: { ...missLoop.state.players.b.movement.position, y: overCrouchedHeadY },
      velocity: vec3(0, 0, 24)
    };

    missLoop.step();

    expect(missLoop.state.match.scoreByTeamId.blue).toBe(0);

    const hitLoop = new ServerGameLoop('room');
    hitLoop.addPlayer('a', 'A');
    hitLoop.addPlayer('b', 'B');
    playNow(hitLoop);
    hitLoop.handleInput('b', { crouchHeld: true }, 1);
    hitLoop.state.balls.ball_0 = {
      ...hitLoop.state.balls.ball_0,
      phase: 'live',
      ownerKind: 'player',
      ownerId: 'a',
      position: { ...hitLoop.state.players.b.movement.position, y: crouchHeight + combinedRadius - 0.05 },
      velocity: vec3(0, 0, 24)
    };

    hitLoop.step();

    expect(hitLoop.state.match.scoreByTeamId.blue).toBe(1);
  });

  it('resets immediately with one player', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.state.match.scoreByTeamId.blue = 3;
    loop.state.players.a.score = 3;

    const reset = loop.handleReset('a');

    expect(reset.ok).toBe(true);
    expect(loop.state.match.scoreByTeamId.blue).toBe(0);
    expect(loop.state.players.a.score).toBe(0);
    expect(loop.state.resetVote.voteCount).toBe(0);
    expect(loop.state.resetVote.requiredVotes).toBe(1);
    expect(loop.state.resetVote.resetSerial).toBe(1);
  });

  it('requires all connected players to vote for a room reset', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    loop.state.match.scoreByTeamId.blue = 3;
    loop.state.players.a.score = 3;

    const first = loop.handleReset('a');

    expect(first.ok).toBe(true);
    expect(loop.state.match.scoreByTeamId.blue).toBe(3);
    expect(loop.state.resetVote.voteCount).toBe(1);
    expect(loop.state.resetVote.requiredVotes).toBe(2);

    const second = loop.handleReset('b');

    expect(second.ok).toBe(true);
    expect(Object.keys(loop.state.players)).toEqual(['a', 'b']);
    expect(Object.keys(loop.state.balls)).toHaveLength(GAME_CONSTANTS.map.ballCount);
    expect(loop.state.match.scoreByTeamId.blue).toBe(0);
    expect(loop.state.players.a.score).toBe(0);
    expect(loop.state.resetVote.voteCount).toBe(0);
    expect(loop.state.resetVote.requiredVotes).toBe(2);
  });

  it('drops pre-reset inputs after a room reset so the player is not frozen at spawn', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    // Both vote → room reset. resetSerial goes 0 → 1; match enters countdown. Force 'playing' so a
    // movement input would integrate if accepted.
    expect(loop.handleReset('a').ok).toBe(true);
    expect(loop.handleReset('b').ok).toBe(true);
    expect(loop.state.resetVote.resetSerial).toBe(1);
    playNow(loop);

    const spawn = { ...loop.state.players.a.movement.position };
    const movedXZ = () => {
      const p = loop.state.players.a.movement.position;
      return Math.hypot(p.x - spawn.x, p.z - spawn.z);
    };

    // A pre-reset packet (old timeline, resetSerial 0) with a HIGH seq still in flight. It must be
    // rejected — otherwise it bumps the server's last-seen seq and freezes the fresh input stream.
    loop.handleInput('a', { moveZ: 1, sequence: 9999, resetSerial: 0 }, 9999);
    loop.step();
    expect(movedXZ()).toBeCloseTo(0, 4); // ignored, no movement

    // A fresh post-reset packet (current timeline, low seq) must be accepted and move the player.
    for (let i = 1; i <= 6; i++) {
      loop.handleInput('a', { moveZ: 1, sequence: i, resetSerial: 1 }, i);
      loop.step();
    }
    expect(movedXZ()).toBeGreaterThan(0.05); // accepted → moved off spawn
  });

  it('recomputes reset votes when a player leaves', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');
    loop.state.match.scoreByTeamId.blue = 3;

    expect(loop.handleReset('a').ok).toBe(true);
    expect(loop.state.resetVote.voteCount).toBe(1);
    expect(loop.state.resetVote.requiredVotes).toBe(2);

    loop.removePlayer('b');

    expect(Object.keys(loop.state.players)).toEqual(['a']);
    expect(loop.state.match.scoreByTeamId.blue).toBe(0);
    expect(loop.state.resetVote.voteCount).toBe(0);
    expect(loop.state.resetVote.requiredVotes).toBe(1);
  });

  it('forfeits to the remaining player when an opponent abandons mid-match', () => {
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.addPlayer('b', 'B');

    loop.abandon('b');

    expect(loop.state.match.status).toBe('complete');
    expect(loop.state.match.winnerTeamId).toBe(loop.state.players.a.teamId);
    expect(Object.keys(loop.state.players)).toEqual(['a']);
  });

  describe('pre-round countdown (fixes the post-reset freeze)', () => {
    it('enters a countdown when the second player joins, then flips to playing after it elapses', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      expect(loop.state.match.status).toBe('warmup');
      loop.addPlayer('b', 'B');
      expect(loop.state.match.status).toBe('countdown');
      expect(loop.state.match.countdownSeconds).toBeCloseTo(GAME_CONSTANTS.match.countdownSeconds, 5);

      // Step past the countdown (a little over the configured seconds at the tick rate).
      const steps = Math.ceil(GAME_CONSTANTS.match.countdownSeconds * loop.tickRate) + 2;
      for (let i = 0; i < steps; i += 1) loop.step();
      expect(loop.state.match.status).toBe('playing');
      expect(loop.state.match.countdownSeconds).toBe(0);
    });

    it('pins players to spawn and ignores movement input during the countdown', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      expect(loop.state.match.status).toBe('countdown');

      const spawnZ = loop.state.players.a.movement.position.z;
      // Try to walk forward hard during the countdown.
      loop.handleInput('a', { moveZ: 1, jumpHeld: true, sequence: 1 }, 1);
      loop.step();
      // Position is still pinned at spawn (no integration while counting down).
      expect(loop.state.players.a.movement.position.z).toBeCloseTo(spawnZ, 5);
      expect(loop.state.players.a.movement.velocity.x).toBe(0);
      expect(loop.state.players.a.movement.velocity.z).toBe(0);
    });

    it('a room reset re-enters the countdown (so a 1v1 rematch starts cleanly, not frozen forever)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      // Get into live play first.
      playNow(loop);
      expect(loop.state.match.status).toBe('playing');
      // Both vote → reset → fresh countdown, not a stuck state.
      loop.handleReset('a');
      loop.handleReset('b');
      expect(loop.state.match.status).toBe('countdown');
      expect(loop.state.match.countdownSeconds).toBeCloseTo(GAME_CONSTANTS.match.countdownSeconds, 5);

      // After the countdown the match is playing and BOTH players can move again (not frozen).
      const steps = Math.ceil(GAME_CONSTANTS.match.countdownSeconds * loop.tickRate) + 2;
      for (let i = 0; i < steps; i += 1) loop.step();
      expect(loop.state.match.status).toBe('playing');
      const zBefore = loop.state.players.a.movement.position.z;
      for (let i = 0; i < 10; i += 1) loop.handleInput('a', { moveZ: 1, sequence: 2 + i }, 2 + i);
      for (let i = 0; i < 10; i += 1) loop.step();
      expect(loop.state.players.a.movement.position.z).not.toBeCloseTo(zBefore, 2);
    });
  });

  describe('1v1 reset', () => {
    it('both players voting resets scores and bumps resetSerial so clients detect it', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      loop.state.match.scoreByTeamId.blue = 4;
      loop.state.players.a.score = 4;
      const serialBefore = loop.state.resetVote.resetSerial;

      // First vote: pending (requires both connected players in a 1v1).
      expect(loop.handleReset('a').ok).toBe(true);
      expect(loop.state.resetVote.requiredVotes).toBe(2);
      expect(loop.state.resetVote.voteCount).toBe(1);
      expect(loop.state.match.scoreByTeamId.blue).toBe(4);

      // Second vote: reset fires.
      expect(loop.handleReset('b').ok).toBe(true);
      expect(loop.state.match.scoreByTeamId.blue).toBe(0);
      expect(loop.state.players.a.score).toBe(0);
      expect(loop.state.resetVote.voteCount).toBe(0);
      // resetSerial must increase so the client's handleOnlineResetEvents triggers.
      expect(loop.state.resetVote.resetSerial).toBe(serialBefore + 1);
    });

    it('reset clears a live ball and restores the center-line loose balls', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');

      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live',
        ownerKind: 'player',
        ownerId: 'a',
        velocity: vec3(0, 0, 24)
      };

      loop.handleReset('a');
      loop.handleReset('b');

      // Every ball is back to a fresh loose, owner-less state.
      const balls = Object.values(loop.state.balls);
      expect(balls).toHaveLength(GAME_CONSTANTS.map.ballCount);
      for (const ball of balls) {
        expect(ball.phase).toBe('loose');
        expect(ball.ownerId).toBeNull();
        expect(ball.heldByPlayerId).toBeNull();
      }
    });

    it('reset clears a held ball back to the ball pool', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      loop.state.players.a.movement.position = vec3(0, 0, 0);
      expect(loop.handlePickup('a').ok).toBe(true);
      expect(loop.state.players.a.hands.left.heldBallId).toBeTruthy();

      loop.handleReset('a');
      loop.handleReset('b');

      expect(loop.state.players.a.hands.left.heldBallId).toBeNull();
      expect(loop.state.players.a.hands.right.heldBallId).toBeNull();
      for (const ball of Object.values(loop.state.balls)) {
        expect(ball.heldByPlayerId).toBeNull();
      }
    });

    it('keeps the snapshot tick monotonic across a reset (prevents the client reconcile freeze)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');

      // Advance the sim so the tick is well above zero before the reset.
      for (let i = 0; i < 50; i += 1) loop.step();
      const tickBeforeReset = loop.state.tick;
      expect(tickBeforeReset).toBeGreaterThanOrEqual(50);

      loop.handleReset('a');
      loop.handleReset('b');

      // The tick must NOT fall back to 0 — the client gates reconciliation on tick > lastReconciled,
      // so a backward tick would wedge prediction and freeze the local player after a reset.
      expect(loop.state.tick).toBeGreaterThanOrEqual(tickBeforeReset);
      const tickAfterReset = loop.state.tick;
      loop.step();
      expect(loop.state.tick).toBeGreaterThan(tickAfterReset);
    });

    it('recomputes the required votes immediately when one of the two players disconnects', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');

      // a votes; still pending because both connected players are needed.
      expect(loop.handleReset('a').ok).toBe(true);
      expect(loop.state.resetVote.requiredVotes).toBe(2);
      expect(loop.state.resetVote.voteCount).toBe(1);

      // b disconnects → a's lone vote now satisfies the (recomputed) 1-player requirement and the
      // pending reset resolves rather than stranding the room waiting on a ghost vote.
      loop.setConnected('b', false);

      expect(loop.state.resetVote.voteCount).toBe(0);
      expect(loop.state.resetVote.requiredVotes).toBe(1);
    });
  });

  describe('combat — catch attempts, auto-parry, interaction order', () => {
    const eye = GAME_CONSTANTS.player.eyeHeight;

    // Put defender 'b' at the origin facing -Z (yaw π) and seed their look angles via input so the
    // recorded defense sample aims down -Z. Returns the loop with both players present + active.
    function defenderFacingIncoming(): ServerGameLoop {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      playNow(loop); // combat tests bypass the pre-round countdown
      loop.state.players.b.movement.position = vec3(0, 0, 0);
      // Aim straight down -Z (yaw π, pitch 0). Send it as input so the server stores it + the sample.
      loop.handleInput('b', { lookYawRadians: Math.PI, lookPitchRadians: 0, sequence: 1 }, 1);
      loop.step();
      return loop;
    }

    // A slow live ball owned by 'a', positioned just in front of 'b' (toward -Z) at eye height,
    // drifting toward 'b'. Inside catch cone+range of a -Z-facing defender.
    function placeIncomingBall(loop: ServerGameLoop, zDistance = 2): void {
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live',
        ownerKind: 'player',
        ownerId: 'a',
        heldByPlayerId: null,
        heldHand: null,
        position: vec3(0, eye, -zDistance),
        velocity: vec3(0, 0, 4),
        bounceCount: 0,
        throwId: 1
      };
    }

    it('a timed catch attempt with an empty hand, aimed at a slow live ball, catches it', () => {
      const loop = defenderFacingIncoming();
      placeIncomingBall(loop);
      loop.state.players.b.dash.charges = GAME_CONSTANTS.dash.maxCharges - 1;

      // 'b' clicks to attempt a catch on the left hand: a fresh latched attempt id in the input.
      loop.handleInput('b', { lookYawRadians: Math.PI, leftCatchAttemptId: 1, sequence: 2 }, 2);
      loop.step();

      const ball = loop.state.balls.ball_0;
      expect(ball.phase).toBe('held');
      expect(ball.heldByPlayerId).toBe('b');
      expect(loop.state.players.b.hands.left.heldBallId).toBe('ball_0');
      expect(loop.state.players.b.dash.charges).toBe(GAME_CONSTANTS.dash.maxCharges);
      // No score: a caught ball never counts as a hit.
      expect(loop.state.match.scoreByTeamId.blue).toBe(0);
    });

    it('CAN catch a ball that has bounced once (dead but still fast, in the air)', () => {
      const loop = defenderFacingIncoming();
      // A live ball turns 'dead' on its first floor/back-wall/bleacher bounce (it can no longer
      // SCORE), but a fast once-bounced ball is still a real ball in the air you should be able to
      // catch. Simulate that state directly: dead, bounceCount 1, fast, in front of the defender.
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'dead',
        ownerKind: null,
        ownerId: null,
        heldByPlayerId: null,
        heldHand: null,
        bounceCount: 1,
        position: vec3(0, eye, -2),
        velocity: vec3(0, 0, 8) // well above the bounced-catch speed floor
      };
      loop.handleInput('b', { lookYawRadians: Math.PI, leftCatchAttemptId: 1, sequence: 2 }, 2);
      loop.step();

      const ball = loop.state.balls.ball_0;
      expect(ball.phase).toBe('held');
      expect(ball.heldByPlayerId).toBe('b');
      expect(loop.state.match.scoreByTeamId.blue).toBe(0);
    });

    it('does NOT catch a settled/slow dead ball, or one that has bounced more than once', () => {
      // Slow dead ball → not catchable in the air (treat as on the ground; pick it up instead).
      const slow = defenderFacingIncoming();
      slow.state.balls.ball_0 = {
        ...slow.state.balls.ball_0,
        phase: 'dead', ownerKind: null, ownerId: null, heldByPlayerId: null, heldHand: null,
        bounceCount: 1, position: vec3(0, eye, -2), velocity: vec3(0, 0, 0.5)
      };
      slow.handleInput('b', { lookYawRadians: Math.PI, leftCatchAttemptId: 1, sequence: 2 }, 2);
      slow.step();
      expect(slow.state.balls.ball_0.heldByPlayerId).not.toBe('b');

      // Fast but multi-bounce → not catchable (only a fresh single bounce stays catchable).
      const multi = defenderFacingIncoming();
      multi.state.balls.ball_0 = {
        ...multi.state.balls.ball_0,
        phase: 'dead', ownerKind: null, ownerId: null, heldByPlayerId: null, heldHand: null,
        bounceCount: 2, position: vec3(0, eye, -2), velocity: vec3(0, 0, 8)
      };
      multi.handleInput('b', { lookYawRadians: Math.PI, leftCatchAttemptId: 1, sequence: 2 }, 2);
      multi.step();
      expect(multi.state.balls.ball_0.heldByPlayerId).not.toBe('b');
    });

    it('a bounced ball that reaches a player without being caught does NOT score (dead cannot hit)', () => {
      const loop = defenderFacingIncoming();
      // Fast once-bounced (dead) ball on a direct hit path to 'b', but 'b' makes no catch attempt.
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'dead', ownerKind: null, ownerId: null, heldByPlayerId: null, heldHand: null,
        bounceCount: 1,
        position: { ...loop.state.players.b.movement.position, y: GAME_CONSTANTS.player.height * 0.5 },
        velocity: vec3(0, 0, 24)
      };
      loop.step();
      // Dead balls never score regardless of speed/contact.
      expect(loop.state.match.scoreByTeamId.blue).toBe(0);
      expect(loop.state.match.scoreByTeamId.red).toBe(0);
    });

    it('acknowledges a catch attempt on the hand state even if it ultimately whiffs', () => {
      const loop = defenderFacingIncoming();
      // No ball in front — the attempt cannot catch, but the server must still ack the id so the
      // client stops re-latching it.
      loop.handleInput('b', { lookYawRadians: Math.PI, rightCatchAttemptId: 7, sequence: 2 }, 2);
      loop.step();
      expect(loop.state.players.b.hands.right.lastCatchAttemptId).toBe(7);
      expect(loop.state.players.b.hands.right.heldBallId).toBeNull();
    });

    it('does not catch while dashing (empty hand + aim are not enough)', () => {
      const loop = defenderFacingIncoming();
      placeIncomingBall(loop);
      // Trigger a REAL dash this tick (dashPressed + a dash direction) so the recorded defense
      // sample shows dashing=true, alongside the catch attempt. Catch must be denied.
      loop.handleInput('b', {
        lookYawRadians: Math.PI,
        dashPressed: true,
        dashDirection: vec3(1, 0, 0),
        moveX: 1,
        leftCatchAttemptId: 1,
        sequence: 2
      }, 2);
      loop.step();
      expect(loop.state.players.b.movement.dashingThisFrame).toBe(true); // sanity: really dashed
      const ball = loop.state.balls.ball_0;
      expect(ball.heldByPlayerId).not.toBe('b');
    });

    it('does not catch a ball aimed away from the defender (cone gate)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      playNow(loop);
      loop.state.players.b.movement.position = vec3(0, 0, 0);
      // Defender looks +X, away from the -Z incoming ball.
      loop.handleInput('b', { lookYawRadians: Math.PI / 2, lookPitchRadians: 0, sequence: 1 }, 1);
      loop.step();
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live', ownerKind: 'player', ownerId: 'a',
        position: vec3(0, eye, -2), velocity: vec3(0, 0, 4), bounceCount: 0, throwId: 1
      };
      loop.handleInput('b', { lookYawRadians: Math.PI / 2, leftCatchAttemptId: 1, sequence: 2 }, 2);
      loop.step();
      expect(loop.state.balls.ball_0.heldByPlayerId).not.toBe('b');
    });

    // --- Lag-compensated catch (online timing): a high-ping defender's click reaches the server
    // only after the ball already hit/passed them, so the catch is judged against BALL HISTORY
    // rewound to what the defender saw, and a legit catch reverts the hit it superseded. These tests
    // drive a VIRTUAL clock at the true tick spacing so the wall-clock windows behave like online. ---
    const STEP_MS = 1000 / 90;

    // Run a fast straight throw into a -Z-facing defender at the origin, stepping a virtual clock at
    // 90Hz, WITHOUT a catch — returns the loop right after 'b' is hit (score blue == 1). The ball's
    // pre-hit swept history is retained so a late catch can rewind to it.
    function hitThenReadyForLateCatch(aimYaw = Math.PI): { loop: ServerGameLoop; clock: { ms: number }; seq: number } {
      const clock = { ms: 100000 };
      const loop = new ServerGameLoop('room', { now: () => clock.ms });
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
      loop.state.players.b.movement.position = vec3(0, 0, 0);
      let seq = 1;
      // Warm up defense history (b aiming) before the ball exists.
      for (let i = 0; i < 6; i += 1) {
        clock.ms += STEP_MS;
        loop.handleInput('b', { lookYawRadians: aimYaw, lookPitchRadians: 0, sequence: seq }, seq);
        seq += 1;
        loop.step();
      }
      // Fast live ball 6m in front of b, straight at the face.
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live', ownerKind: 'player', ownerId: 'a', heldByPlayerId: null, heldHand: null,
        position: vec3(0, eye, -6), velocity: vec3(0, 0, 30), bounceCount: 0, throwId: 1
      };
      // Step until the hit lands (no catch yet — the click is still "in flight").
      for (let i = 0; i < 30 && loop.state.match.scoreByTeamId.blue === 0; i += 1) {
        clock.ms += STEP_MS;
        loop.handleInput('b', { lookYawRadians: aimYaw, sequence: seq }, seq);
        seq += 1;
        loop.step();
      }
      return { loop, clock, seq };
    }

    it('lag-comp reclaim: a late catch claims a ball that already hit the defender and reverts the score', () => {
      const { loop, clock, seq } = hitThenReadyForLateCatch();
      expect(loop.state.match.scoreByTeamId.blue).toBe(1); // the hit landed first (high-ping defender)

      // The late catch click arrives and the defender holds it (latched) across the active window —
      // the rewound evaluation scans recent ball history until it finds the in-cone/in-range moment.
      let s = seq;
      for (let i = 0; i < 8 && loop.state.balls.ball_0.heldByPlayerId !== 'b'; i += 1) {
        clock.ms += STEP_MS;
        loop.handleInput('b', { lookYawRadians: Math.PI, leftCatchAttemptId: 1, sequence: s }, s);
        s += 1;
        loop.step();
      }

      expect(loop.state.balls.ball_0.heldByPlayerId).toBe('b'); // reclaimed from history
      expect(loop.state.match.scoreByTeamId.blue).toBe(0);      // superseded hit reverted
    });

    it('lag-comp reclaim respects the cone: a defender who never aimed at the ball stays hit', () => {
      // b looks +X the whole time, never at the -Z ball. The hit must stand even with a catch click.
      const { loop, clock, seq } = hitThenReadyForLateCatch(Math.PI / 2);
      expect(loop.state.match.scoreByTeamId.blue).toBe(1);

      let s = seq;
      for (let i = 0; i < 8; i += 1) {
        clock.ms += STEP_MS;
        loop.handleInput('b', { lookYawRadians: Math.PI / 2, leftCatchAttemptId: 1, sequence: s }, s);
        s += 1;
        loop.step();
      }

      expect(loop.state.balls.ball_0.heldByPlayerId).not.toBe('b'); // cone gate denies the reclaim
      expect(loop.state.match.scoreByTeamId.blue).toBe(1);          // hit stands
    });

    it('lag-comp reclaim does not fire after the undo grace fully elapses (too late)', () => {
      const { loop, clock, seq } = hitThenReadyForLateCatch();
      expect(loop.state.match.scoreByTeamId.blue).toBe(1);
      // Let well over the grace pass with no catch — the recent-hit record is pruned.
      for (let i = 0; i < 40; i += 1) { clock.ms += STEP_MS; loop.step(); }
      clock.ms += STEP_MS;
      loop.handleInput('b', { lookYawRadians: Math.PI, leftCatchAttemptId: 1, sequence: seq }, seq);
      loop.step();
      expect(loop.state.match.scoreByTeamId.blue).toBe(1); // far too late — no revival
    });

    it('auto-parries an incoming live ball when the defender holds two balls and aims at it', () => {
      const loop = defenderFacingIncoming();
      // Give 'b' two held balls so they are in the parry stance.
      loop.state.players.b.hands.left.heldBallId = 'ball_4';
      loop.state.players.b.hands.right.heldBallId = 'ball_5';
      loop.state.balls.ball_4 = { ...loop.state.balls.ball_4, phase: 'held', heldByPlayerId: 'b', heldHand: 'left', ownerId: 'b' };
      loop.state.balls.ball_5 = { ...loop.state.balls.ball_5, phase: 'held', heldByPlayerId: 'b', heldHand: 'right', ownerId: 'b' };
      // Re-record the two-balls sample, then bring in a close incoming ball (parry range is short).
      loop.handleInput('b', { lookYawRadians: Math.PI, sequence: 2 }, 2);
      loop.step();
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live', ownerKind: 'player', ownerId: 'a',
        position: vec3(0, eye, -0.6), velocity: vec3(0, 0, 6), bounceCount: 0, throwId: 2
      };
      loop.step();
      const ball = loop.state.balls.ball_0;
      expect(ball.phase).toBe('deflected');
      expect(ball.ownerId).toBe('b');
      // No score from the deflected ball for the original thrower.
      expect(loop.state.match.scoreByTeamId.blue).toBe(0);
    });

    it('a successful catch prevents the hit from also applying that tick (order: catch before hit)', () => {
      const loop = defenderFacingIncoming();
      // Ball positioned so it is both catchable AND on a hit path to 'b'. Catch must win.
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live', ownerKind: 'player', ownerId: 'a',
        position: vec3(0, eye, -1.2), velocity: vec3(0, 0, 24), bounceCount: 0, throwId: 1
      };
      loop.handleInput('b', { lookYawRadians: Math.PI, leftCatchAttemptId: 1, sequence: 2 }, 2);
      loop.step();
      expect(loop.state.balls.ball_0.heldByPlayerId).toBe('b');
      expect(loop.state.match.scoreByTeamId.blue).toBe(0); // hit did NOT also fire
    });

    it('a throw assigns a unique incrementing throwId and emits a drainable throw event', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      loop.state.players.a.movement.position = vec3(0, 0, 0);
      expect(loop.handlePickup('a').ok).toBe(true);
      expect(loop.handleThrow('a', { hand: 'left' }).ok).toBe(true);

      const events = loop.drainThrowEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('throw-event');
      expect(events[0].throwId).toBeGreaterThan(0);
      const live = Object.values(loop.state.balls).find((b) => b.phase === 'live');
      expect(live?.throwId).toBe(events[0].throwId);
      // Draining again yields nothing (events are consumed once).
      expect(loop.drainThrowEvents()).toHaveLength(0);
    });

    it('a crouch throw produces a sideways curve acceleration (deterministic curve)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.state.players.a.movement.position = vec3(0, 0, 0);
      // Crouch + face +Z. The curve must be perpendicular to aim (along X), not zero.
      loop.handleInput('a', { lookYawRadians: 0, lookPitchRadians: 0, crouchHeld: true, sequence: 1 }, 1);
      loop.step();
      expect(loop.handlePickup('a').ok).toBe(true);
      expect(loop.handleThrow('a', { hand: 'left' }).ok).toBe(true);
      const live = Object.values(loop.state.balls).find((b) => b.phase === 'live');
      expect(live!.curveAccel.x).toBeGreaterThan(1);
      expect(Math.abs(live!.curveAccel.z)).toBeLessThan(0.01); // perpendicular to +Z aim
    });

    it('honors a backflip QTE tier (recent backflip + grounded) with tiered speed + super', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.state.players.a.movement.position = vec3(0, 0, 0);
      loop.handleInput('a', { lookYawRadians: 0, lookPitchRadians: 0, sequence: 1 }, 1);
      loop.step();
      expect(loop.handlePickup('a').ok).toBe(true);
      // Simulate "just landed a backflip": grounded with a fresh backflip cooldown.
      loop.state.players.a.movement.grounded = true;
      loop.state.players.a.movementInternal.backflipCooldown = GAME_CONSTANTS.backflip.cooldownSeconds;
      loop.state.players.a.dash.charges = GAME_CONSTANTS.dash.maxCharges - 1;

      expect(loop.handleThrow('a', { hand: 'left', backflipTier: 5 }).ok).toBe(true);
      const live = Object.values(loop.state.balls).find((b) => b.phase === 'live');
      expect(live!.isSuper).toBe(true);
      // Top tier = quick × 2.2 (10% above the legacy super); movement velocity is ~0 here.
      expect(length(live!.velocity)).toBeCloseTo(backflipQteSpeed(5), 1);
      expect(loop.state.players.a.dash.charges).toBe(GAME_CONSTANTS.dash.maxCharges);
    });

    it('ignores a spoofed backflip tier when no recent backflip (normal throw, not super)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.state.players.a.movement.position = vec3(0, 0, 0);
      loop.handleInput('a', { lookYawRadians: 0, lookPitchRadians: 0, sequence: 1 }, 1);
      loop.step();
      expect(loop.handlePickup('a').ok).toBe(true);
      // Grounded but NO recent backflip (cooldown 0) → the tier must be rejected.
      loop.state.players.a.movement.grounded = true;
      loop.state.players.a.movementInternal.backflipCooldown = 0;

      expect(loop.handleThrow('a', { hand: 'left', backflipTier: 5 }).ok).toBe(true);
      const live = Object.values(loop.state.balls).find((b) => b.phase === 'live');
      expect(live!.isSuper).toBe(false);
      expect(length(live!.velocity)).toBeCloseTo(GAME_CONSTANTS.ball.quickThrowSpeed, 1);
    });

    it('input-stream release while crouching creates the same curve throw online', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
      playNow(loop);
      loop.state.players.a.movement.position = vec3(0, 0, 0);
      expect(loop.handlePickup('a').ok).toBe(true);

      loop.handleInput('a', {
        lookYawRadians: 0,
        lookPitchRadians: 0,
        crouchHeld: true,
        leftHandPressed: true,
        leftHandHeld: true,
        sequence: 1
      }, 1);
      loop.step();

      loop.handleInput('a', {
        lookYawRadians: 0,
        lookPitchRadians: 0,
        crouchHeld: true,
        leftHandReleased: true,
        sequence: 2
      }, 2);
      loop.step();

      const live = Object.values(loop.state.balls).find((b) => b.phase === 'live');
      expect(live).toBeTruthy();
      expect(live!.curveAccel.x).toBeGreaterThan(1);
      expect(Math.abs(live!.curveAccel.z)).toBeLessThan(0.01);
    });
  });
});
