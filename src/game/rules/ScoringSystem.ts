import { AbstractMesh } from '@babylonjs/core';
import { Ball } from '../ball/Ball';
import { hasReachedScoreLimit, isLivePlayerOwnedBall } from '../../../shared/simulation/RuleSim';
import { sweptBallHitsBody } from '../../../shared/simulation/CollisionMath';
import { TUNING } from '../config/tuning';
import { GAME_CONSTANTS } from '../../../shared/constants';

// Dummy body axis (feet → above the head) for swept hit detection. Dummies sit with their
// center at y≈0.9; the head sphere reaches ~2.0. Testing the full axis (not a single mid-body
// point) is what lets headshots register.
const DUMMY_BODY_BASE_Y = 0.15;
const DUMMY_BODY_TOP_Y = 2.0;

export interface DummyHitResult {
  speed: number;
}

export class ScoringSystem {
  public playerHits = 0;

  /**
   * Detects player-thrown live balls striking target dummies. Uses a SWEPT CAPSULE test — the
   * ball's path this tick vs the dummy's full vertical body axis — so headshots register and a
   * fast throw can't tunnel through a dummy between frames. Returns the number of new hits.
   */
  updateAgainstDummies(balls: Ball[], targetDummies: AbstractMesh[], dt: number): DummyHitResult[] {
    const hitsThisFrame: DummyHitResult[] = [];
    for (const ball of balls) {
      if (!isLivePlayerOwnedBall(ball.state, ball.owner)) continue;
      const radius = TUNING.ball.hitRadius + (ball.powerupKind === 'cannon'
        ? TUNING.ball.radius * (GAME_CONSTANTS.powerup.cannonFlightScale - 1)
        : 0);

      const curr = ball.mesh.position;
      const prev = { x: curr.x - ball.velocity.x * dt, y: curr.y - ball.velocity.y * dt, z: curr.z - ball.velocity.z * dt };

      for (const dummy of targetDummies) {
        if (ball.powerupKind === 'cannon' && ball.cannonHitDummyIds.has(dummy.name)) continue;
        const d = dummy.position;
        const base = { x: d.x, y: DUMMY_BODY_BASE_Y, z: d.z };
        const top = { x: d.x, y: DUMMY_BODY_TOP_Y, z: d.z };
        if (!sweptBallHitsBody(prev, curr, base, top, radius)) continue;
        this.playerHits += 1;
        hitsThisFrame.push({ speed: ball.velocity.length() });
        dummy.metadata.hitCount = (dummy.metadata.hitCount ?? 0) + 1;
        if (ball.powerupKind === 'cannon') {
          ball.cannonHitDummyIds.add(dummy.name);
          continue;
        }
        ball.makeDead();
        break;
      }
    }
    return hitsThisFrame;
  }

  isWin(): boolean {
    return hasReachedScoreLimit(this.playerHits);
  }

  reset(): void {
    this.playerHits = 0;
  }
}
