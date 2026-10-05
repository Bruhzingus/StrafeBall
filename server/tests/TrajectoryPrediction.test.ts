import { describe, expect, it } from 'vitest';
import { GAME_CONSTANTS as C } from '../../shared/constants';
import { LIVE_BALL_COMBAT_SUBSTEPS, SERVER_STEP_MS } from '../../shared/netConfig';
import { advanceBall, createBallState, settleBallIfSlow } from '../../shared/simulation/BallSim';
import type { AABB } from '../../shared/simulation/MapGeometry';
import { resolveBallBounds, resolveBallStaticBoxes } from '../../shared/simulation/StaticBallCollision';
import { calculateThrow } from '../../shared/simulation/ThrowMath';
import { predictStaticThrowTrajectory, type StaticThrowTrajectoryInput } from '../../shared/simulation/TrajectoryPrediction';

const v = (x = 0, y = 0, z = 0) => ({ x, y, z });
const step = SERVER_STEP_MS / 1000 / LIVE_BALL_COMBAT_SUBSTEPS;

function compareWithLive(input: StaticThrowTrajectoryInput): ReturnType<typeof predictStaticThrowTrajectory> {
  const points = predictStaticThrowTrajectory({ ...input, stepSeconds: step });
  let ball = createBallState('live', input.origin, {
    phase: 'live', velocity: input.velocity, curveAccel: input.curveAccel, dropScale: input.dropScale,
    ownerKind: 'player', ownerId: 'test'
  });
  let index = 0;
  for (const point of points) {
    while (index < point.stepIndex) {
      ball = advanceBall(ball, step, input.constants);
      ball = resolveBallStaticBoxes(resolveBallBounds(ball, input.bounceRule), input.boxes as AABB[], undefined, input.bounceRule);
      ball = settleBallIfSlow(ball, input.constants, input.boxes);
      index++;
    }
    for (const axis of ['x', 'y', 'z'] as const) {
      expect(point.position[axis]).toBeCloseTo(ball.position[axis], 8);
      expect(point.velocity[axis]).toBeCloseTo(ball.velocity[axis], 8);
    }
    expect(point.bounceCount).toBe(ball.bounceCount);
  }
  return points;
}

describe('static throw trajectory', () => {
  it('matches straight full-charge live flight and leaves the input untouched', () => {
    const throwState = calculateThrow({ hand: 'left', forward: v(0, 0, 1), playerVelocity: v(), charge01: 1, crouching: false });
    const input = { origin: v(0, 2, 0), ...throwState, boxes: [] as AABB[], maxSeconds: 0.5 };
    const before = structuredClone(input);
    const points = compareWithLive(input);
    expect(points[0].position).toEqual(input.origin);
    expect(points.at(-1)!.position.z).toBeGreaterThan(15);
    expect(input).toEqual(before);
    expect(predictStaticThrowTrajectory(input)).toEqual(points);
  });

  it('matches full crouch curve and the post-bounce path', () => {
    const throwState = calculateThrow({ hand: 'left', forward: v(1, 0, 0), playerVelocity: v(), charge01: 1, crouching: true });
    const points = compareWithLive({ origin: v(-C.map.halfWidth + 1, 3, 0), ...throwState, boxes: [], maxSeconds: 1.2 });
    const bounce = points.findIndex(p => p.collision);
    expect(bounce).toBeGreaterThan(0);
    expect(points[bounce].velocity.x).toBeLessThan(0);
    expect(points.slice(1, bounce).some(p => Math.abs(p.position.z) > 0.1)).toBe(true);
    expect(points.slice(bounce + 1).some(p => p.position.x < points[bounce].position.x - 1)).toBe(true);
  });

  it.each([
    ['wall', v(C.map.halfWidth - 1, 3, 0), v(30, 0, 0), [] as AABB[]],
    ['floor', v(0, 0.65, 0), v(0, -25, 0), [] as AABB[]],
    ['ceiling', v(0, C.map.wallHeight - 0.65, 0), v(0, 25, 0), [] as AABB[]],
    ['mat', v(0, 1, 0), v(30, 0, 0), [{ minX: 2, maxX: 2.2, minY: 0, maxY: 2, minZ: -1, maxZ: 1, kind: 'mat' }] as AABB[]]
  ])('matches live %s impact position and reflected velocity', (_name, origin, velocity, boxes) => {
    const points = compareWithLive({ origin, velocity, curveAccel: v(), dropScale: 1, boxes, maxSeconds: 0.3 });
    const bounce = points.find(p => p.collision);
    expect(bounce).toBeDefined();
    expect(bounce!.bounceCount).toBe(1);
    expect(Math.hypot(bounce!.velocity.x, bounce!.velocity.y, bounce!.velocity.z)).toBeGreaterThan(0);
  });

  it('stops at the second collision and obeys shorter time and distance limits', () => {
    const base = { origin: v(0, 2, 0), velocity: v(40, 0, 0), curveAccel: v(), dropScale: 0, boxes: [] as AABB[] };
    const points = compareWithLive({ ...base, maxSeconds: 3, maxDistance: 100 });
    expect(points.filter(p => p.collision)).toHaveLength(2);
    expect(points.at(-1)!.bounceCount).toBe(2);
    expect(predictStaticThrowTrajectory({ ...base, maxSeconds: 0.1 }).at(-1)!.stepIndex).toBeLessThan(points.at(-1)!.stepIndex);
    expect(predictStaticThrowTrajectory({ ...base, maxDistance: 1 }).at(-1)!.stepIndex).toBeLessThan(points.at(-1)!.stepIndex);
    expect(points.length).toBeLessThanOrEqual(32);
  });
});
