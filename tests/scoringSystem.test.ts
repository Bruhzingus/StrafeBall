import { describe, it, expect } from 'vitest';
import { AbstractMesh, Vector3 } from '@babylonjs/core';
import { ScoringSystem } from '../src/game/rules/ScoringSystem';
import { Ball } from '../src/game/ball/Ball';
import { BallState, BallOwner } from '../src/game/ball/BallState';
import { TUNING } from '../src/game/config/tuning';

// Lightweight duck-typed stand-ins so we don't need a Babylon Engine/Scene to exercise the
// pure scoring logic. ScoringSystem only touches state/owner/mesh.position/makeDead on balls,
// and position/metadata on dummies.
const DT = 1 / 60;

function makeBall(state: BallState, owner: BallOwner, position: Vector3): Ball {
  const ball = {
    state,
    owner,
    mesh: { position },
    velocity: new Vector3(0, 0, 0),
    makeDead() {
      ball.state = BallState.Dead;
      ball.owner = null;
    }
  } as unknown as Ball;
  return ball;
}

function makeDummy(position: Vector3): AbstractMesh {
  return { position, metadata: { hitCount: 0 } } as unknown as AbstractMesh;
}

describe('ScoringSystem.updateAgainstDummies', () => {
  it('registers a hit when a player-owned live ball is within hitRadius', () => {
    const scoring = new ScoringSystem();
    const ball = makeBall(BallState.Live, 'player', new Vector3(0, 1, 0));
    const dummy = makeDummy(new Vector3(0, 1, 0));

    const hits = scoring.updateAgainstDummies([ball], [dummy], DT);

    expect(hits).toHaveLength(1);
    expect(scoring.playerHits).toBe(1);
    expect((dummy.metadata as { hitCount: number }).hitCount).toBe(1);
    expect(ball.state).toBe(BallState.Dead); // the ball is consumed on hit
  });

  it('ignores balls not owned by the player', () => {
    const scoring = new ScoringSystem();
    const ball = makeBall(BallState.Live, 'launcher', new Vector3(0, 1, 0));
    const dummy = makeDummy(new Vector3(0, 1, 0));
    expect(scoring.updateAgainstDummies([ball], [dummy], DT)).toHaveLength(0);
    expect(scoring.playerHits).toBe(0);
  });

  it('ignores balls that are not live', () => {
    const scoring = new ScoringSystem();
    const ball = makeBall(BallState.Held, 'player', new Vector3(0, 1, 0));
    const dummy = makeDummy(new Vector3(0, 1, 0));
    expect(scoring.updateAgainstDummies([ball], [dummy], DT)).toHaveLength(0);
  });

  it('ignores balls beyond the hit radius', () => {
    const scoring = new ScoringSystem();
    const ball = makeBall(BallState.Live, 'player', new Vector3(0, 1, 0));
    const dummy = makeDummy(new Vector3(TUNING.ball.hitRadius + 1, 1, 0));
    expect(scoring.updateAgainstDummies([ball], [dummy], DT)).toHaveLength(0);
  });

  it('counts only one hit per ball even with multiple dummies in range', () => {
    const scoring = new ScoringSystem();
    const ball = makeBall(BallState.Live, 'player', new Vector3(0, 1, 0));
    const dummies = [makeDummy(new Vector3(0, 1, 0)), makeDummy(new Vector3(0, 1, 0))];
    expect(scoring.updateAgainstDummies([ball], dummies, DT)).toHaveLength(1);
  });

  it('isWin becomes true at the score limit', () => {
    const scoring = new ScoringSystem();
    expect(scoring.isWin()).toBe(false);
    scoring.playerHits = TUNING.match.scoreLimit;
    expect(scoring.isWin()).toBe(true);
  });
});
