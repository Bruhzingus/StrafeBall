"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.predictStaticThrowTrajectory = predictStaticThrowTrajectory;
const constants_1 = require("../constants");
const netConfig_1 = require("../netConfig");
const BallSim_1 = require("./BallSim");
const StaticBallCollision_1 = require("./StaticBallCollision");
/** Static court prediction only. This calls the same integration and collision functions as the server. */
function predictStaticThrowTrajectory(input) {
    const points = input.output ?? [];
    let used = 0;
    const constants = input.constants ?? constants_1.GAME_CONSTANTS;
    const step = Math.max(0.001, input.stepSeconds ?? netConfig_1.SERVER_STEP_MS / 1000 / netConfig_1.LIVE_BALL_COMBAT_SUBSTEPS);
    const maxSteps = Math.max(0, Math.floor(Math.min(3, input.maxSeconds ?? 2.2) / step));
    const maxDistance = Math.min(100, input.maxDistance ?? 70);
    const maxPoints = Math.max(3, Math.min(64, input.maxPoints ?? 32));
    let ball = (0, BallSim_1.createBallState)('trajectory-preview', input.origin, {
        phase: 'live', velocity: input.velocity, curveAccel: input.curveAccel,
        dropScale: input.dropScale, ownerKind: 'player', ownerId: 'preview'
    });
    const put = (collision, stepIndex) => {
        if (used >= maxPoints) {
            if (!collision)
                return;
            used = maxPoints - 1;
        }
        const point = points[used] ??= { stepIndex: 0, position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, bounceCount: 0, collision: false };
        point.stepIndex = stepIndex;
        point.position.x = ball.position.x;
        point.position.y = ball.position.y;
        point.position.z = ball.position.z;
        point.velocity.x = ball.velocity.x;
        point.velocity.y = ball.velocity.y;
        point.velocity.z = ball.velocity.z;
        point.bounceCount = ball.bounceCount;
        point.collision = collision;
        used++;
    };
    put(false, 0);
    let traveled = 0;
    // Reserve room for both impact points. Roughly 25 evenly timed flight samples at the default budget.
    const sampleEvery = Math.max(1, Math.ceil(maxSteps / (maxPoints - 5)));
    for (let i = 1; i <= maxSteps; i++) {
        const before = ball.position;
        const bounceCount = ball.bounceCount;
        const advanced = (0, BallSim_1.advanceBall)(ball, step, constants);
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
        ball = (0, StaticBallCollision_1.resolveBallStaticBoxes)((0, StaticBallCollision_1.resolveBallBounds)(ball, input.bounceRule), input.boxes, undefined, input.bounceRule);
        ball = (0, BallSim_1.settleBallIfSlow)(ball, constants, input.boxes);
        const collision = ball.bounceCount > bounceCount;
        if (collision || i % sampleEvery === 0 || i === maxSteps || traveled >= maxDistance)
            put(collision, i);
        if (ball.bounceCount >= 2 || traveled >= maxDistance || ball.phase === 'loose')
            break;
    }
    points.length = used;
    return points;
}
