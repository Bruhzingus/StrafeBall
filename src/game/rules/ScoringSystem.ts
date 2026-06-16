import { AbstractMesh, Vector3 } from '@babylonjs/core';
import { Ball } from '../ball/Ball';
import { BallState } from '../ball/BallState';
import { TUNING } from '../config/tuning';

export class ScoringSystem {
  public playerHits = 0;

  /**
   * Detects player-thrown live balls striking target dummies. Returns the number of new
   * hits registered this frame so the caller can apply side effects (e.g. granting a dash
   * charge per hit). Kept side-effect-light here so scoring stays portable to a server.
   */
  updateAgainstDummies(balls: Ball[], targetDummies: AbstractMesh[]): number {
    let hitsThisFrame = 0;
    for (const ball of balls) {
      if (ball.state !== BallState.Live || ball.owner !== 'player') continue;

      for (const dummy of targetDummies) {
        const dist = Vector3.Distance(ball.mesh.position, dummy.position);
        if (dist > TUNING.ball.hitRadius) continue;
        this.playerHits += 1;
        hitsThisFrame += 1;
        dummy.metadata.hitCount = (dummy.metadata.hitCount ?? 0) + 1;
        ball.makeDead();
        break;
      }
    }
    return hitsThisFrame;
  }

  isWin(): boolean {
    return this.playerHits >= TUNING.match.scoreLimit;
  }

  reset(): void {
    this.playerHits = 0;
  }
}
