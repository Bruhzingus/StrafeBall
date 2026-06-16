import { Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';
import { HandSide } from './BallState';
import { Ball } from './Ball';
import { BallState } from './BallState';
import { safeNormalize } from '../utils/math';
import { CollisionWorld } from '../map/Collider';
import { ModelLoader } from '../assets/ModelLoader';

export class BallManager {
  public readonly balls: Ball[] = [];

  constructor(
    private readonly loader: ModelLoader,
    private readonly collision: CollisionWorld
  ) {}

  spawnCenterLineBalls(): void {
    this.clear();
    const count = TUNING.map.ballCount;
    const spacing = 2.0;
    const start = -((count - 1) * spacing) / 2;

    for (let i = 0; i < count; i += 1) {
      const position = new Vector3(start + i * spacing, TUNING.ball.radius + 0.05, 0);
      const visual = this.loader.createVisual('ball', { name: `ball_${i}`, size: { diameter: TUNING.ball.radius * 2 }, position });
      this.balls.push(new Ball(visual, position));
    }
  }

  clear(): void {
    for (const ball of this.balls) {
      ball.mesh.dispose();
    }
    this.balls.length = 0;
  }

  update(dt: number): void {
    // Super balls glow; swap the shared material based on live state (cheap, cached materials).
    const ballMaterial = this.loader.material('ball');
    const superBallMaterial = this.loader.material('superBall');
    for (const ball of this.balls) {
      ball.mesh.material = ball.isSuper ? superBallMaterial : ballMaterial;
      ball.update(dt, this.collision);
    }
  }

  findPickupCandidate(position: Vector3): Ball | null {
    let best: Ball | null = null;
    let bestDist = Number.POSITIVE_INFINITY;

    for (const ball of this.balls) {
      if (!this.canPickup(ball)) continue;
      const dist = Vector3.Distance(position, ball.mesh.position);
      if (dist <= TUNING.ball.pickupRadius && dist < bestDist) {
        best = ball;
        bestDist = dist;
      }
    }

    return best;
  }

  canPickup(ball: Ball): boolean {
    if (ball.state === BallState.Loose || ball.state === BallState.Dead) return true;
    return ball.velocity.length() <= TUNING.ball.slowPickupSpeed;
  }

  /** A ball the debug launcher can safely reuse: never one held in a player's hand. */
  findFreeBall(): Ball | null {
    return (
      this.balls.find((b) => b.state === BallState.Loose) ??
      this.balls.find((b) => b.state === BallState.Dead) ??
      this.balls.find((b) => b.state !== BallState.Held) ??
      null
    );
  }

  throwBall(
    ball: Ball,
    origin: Vector3,
    direction: Vector3,
    speed: number,
    owner: 'player' | 'launcher',
    isSuper: boolean,
    dropScale = 1,
    curveAccel?: Vector3
  ): void {
    ball.mesh.position.copyFrom(origin);
    ball.throw(owner, safeNormalize(direction).scale(speed), isSuper, dropScale, curveAccel);
  }

  dropBall(ball: Ball, position: Vector3): void {
    ball.drop(position);
  }

  getLiveThreatsToward(position: Vector3): Ball[] {
    return this.balls.filter((ball) => {
      if (ball.state !== BallState.Live) return false;
      const toPlayer = position.subtract(ball.mesh.position);
      if (toPlayer.lengthSquared() <= 0.001) return false;
      return Vector3.Dot(ball.velocity.normalizeToNew(), toPlayer.normalizeToNew()) > 0.35;
    });
  }

  attachHeldBall(ball: Ball, hand: HandSide, position: Vector3): void {
    ball.setHeld(hand);
    ball.mesh.position.copyFrom(position);
  }
}
