import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS } from '../../shared/constants';
import { vec3 } from '../../shared/simulation/CollisionMath';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

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

  describe('mats — immune to balls, knocked over by players', () => {
    // Pick a mat from the authoritative state to aim at.
    function firstMat(loop: ServerGameLoop) {
      const id = Object.keys(loop.state.mats)[0];
      return loop.state.mats[id];
    }

    it('lets a live ball pass straight through a mat (mats are immune to balls)', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      const mat = firstMat(loop);

      // A flat, fast ball fired straight through the mat center along +X. If mats blocked balls it
      // would bounce/die at the mat; instead it should sail past with x beyond the mat.
      loop.state.balls.ball_0 = {
        ...loop.state.balls.ball_0,
        phase: 'live',
        ownerKind: 'player',
        ownerId: 'a',
        position: vec3(mat.position.x - 1.5, mat.position.y, mat.position.z),
        velocity: vec3(50, 0, 0),
        bounceCount: 0
      };

      // One step moves ~0.83 m at 50 m/s; after 2 steps it has crossed the 0.18 m-thick mat without
      // any bounce being counted (a mat bounce would have incremented bounceCount).
      loop.step();
      loop.step();
      const b = loop.state.balls.ball_0;
      expect(b.bounceCount).toBe(0);
      expect(b.position.x).toBeGreaterThan(mat.position.x);
    });

    it('knocks a mat over (and stays down) when a player walks into it', () => {
      const loop = new ServerGameLoop('room');
      loop.addPlayer('a', 'A');
      loop.addPlayer('b', 'B');
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
});
