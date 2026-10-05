import { GAME_CONSTANTS, type GameConstants } from '../constants';
import { LIVE_BALL_COMBAT_SUBSTEPS, SERVER_STEP_MS } from '../netConfig';
import type { Vec3 } from '../types';
import { advanceBall, createBallState, settleBallIfSlow, type BounceRule } from './BallSim';
import type { AABB } from './MapGeometry';
import { resolveBallBounds, resolveBallStaticBoxes } from './StaticBallCollision';

export interface TrajectoryPoint {
  stepIndex: number;
  position: Vec3;
  velocity: Vec3;
  bounceCount: number;
  collision: boolean;
}

export interface StaticThrowTrajectoryInput {
  origin: Vec3;
  velocity: Vec3;
  curveAccel: Vec3;
  dropScale: number;
  boxes: readonly AABB[];
  constants?: GameConstants;
  bounceRule?: BounceRule;
  stepSeconds?: number;
  maxSeconds?: number;
  maxDistance?: number;
  maxPoints?: number;
  /** Reused by the caller. Existing point objects are updated in place. */
  output?: TrajectoryPoint[];
}

/** Static court prediction only. This calls the same integration and collision functions as the server. */
export function predictStaticThrowTrajectory(input: StaticThrowTrajectoryInput): TrajectoryPoint[] {
  const points = input.output ?? [];
  let used = 0;
  const constants = input.constants ?? GAME_CONSTANTS;
  const step = Math.max(0.001, input.stepSeconds ?? SERVER_STEP_MS / 1000 / LIVE_BALL_COMBAT_SUBSTEPS);
  const maxSteps = Math.max(0, Math.floor(Math.min(3, input.maxSeconds ?? 2.2) / step));
  const maxDistance = Math.min(100, input.maxDistance ?? 70);
  const maxPoints = Math.max(3, Math.min(64, input.maxPoints ?? 32));
  let ball = createBallState('trajectory-preview', input.origin, {
    phase: 'live', velocity: input.velocity, curveAccel: input.curveAccel,
    dropScale: input.dropScale, ownerKind: 'player', ownerId: 'preview'
  });
  const put = (collision: boolean, stepIndex: number): void => {
    if (used >= maxPoints) {
      if (!collision) return;
      used = maxPoints - 1;
    }
    const point = points[used] ??= { stepIndex: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, bounceCount: 0, collision: false };
    point.stepIndex = stepIndex;
    point.position.x = ball.position.x; point.position.y = ball.position.y; point.position.z = ball.position.z;
    point.velocity.x = ball.velocity.x; point.velocity.y = ball.velocity.y; point.velocity.z = ball.velocity.z;
    point.bounceCount = ball.bounceCount; point.collision = collision;
    used++;
  };
  put(false, 0);
  let traveled = 0;
  // Reserve room for both impact points. Roughly 25 evenly timed flight samples at the default budget.
  const sampleEvery = Math.max(1, Math.ceil(maxSteps / (maxPoints - 5)));
  for (let i = 1; i <= maxSteps; i++) {
    const before = ball.position;
    const bounceCount = ball.bounceCount;
    const advanced = advanceBall(ball, step, constants);
    const stepDistance = Math.hypot(advanced.position.x - before.x, advanced.position.y - before.y, advanced.position.z - before.z);
    if (stepDistance > 0 && traveled + stepDistance >= maxDistance) {
      const fraction = Math.max(0, (maxDistance - traveled) / stepDistance);
      ball = {
        ...advanced,
        position: {
          x: before.x + (advanced.position.x - before.x) * fraction,
          y: before.y + (advanced.position.y - before.y) * fraction,
          z: before.z + (advanced.position.z - before.z) * fraction
        }
      };
      put(false, i);
      break;
    }
    traveled += stepDistance;
    ball = advanced;
    ball = resolveBallStaticBoxes(resolveBallBounds(ball, input.bounceRule), input.boxes as AABB[], undefined, input.bounceRule);
    ball = settleBallIfSlow(ball, constants, input.boxes);
    const collision = ball.bounceCount > bounceCount;
    if (collision || i % sampleEvery === 0 || i === maxSteps || traveled >= maxDistance) put(collision, i);
    if (ball.bounceCount >= 2 || traveled >= maxDistance || ball.phase === 'loose') break;
  }
  points.length = used;
  return points;
}
