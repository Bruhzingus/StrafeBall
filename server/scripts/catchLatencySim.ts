/**
 * Virtual-time catch latency simulation. Models the REAL online pipeline that unit tests skip:
 *   - server stepping at the true 90Hz spacing (via an injected virtual clock)
 *   - client view delayed by INTERPOLATION_DELAY + one-way latency
 *   - the catch click taking another one-way latency to reach the server
 *
 * The defender (B) is given the BEST possible case: stationary, aiming dead-center at the incoming
 * ball, clicking exactly when they perceive it at a chosen distance. If catch fails even here, the
 * model is broken for real play. Run: `npx tsx scripts/catchLatencySim.ts`
 */
import { GAME_CONSTANTS } from '../../shared/constants';
import { INTERPOLATION_DELAY_MS, SERVER_STEP_MS, SERVER_TICK_RATE } from '../../shared/netConfig';
import { distance, vec3 } from '../../shared/simulation/CollisionMath';
import type { PlayerInput } from '../../shared/types';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

const EYE = GAME_CONSTANTS.player.eyeHeight;
const CATCH_RANGE = GAME_CONSTANTS.catch.rangeMeters;

interface SimResult {
  outcome: 'catch' | 'hit' | 'expired' | 'timeout';
  atMs: number;          // server time the outcome occurred, relative to throw
  clickArriveMs: number; // server time the catch attempt was processed, relative to throw
  perceivedAtMs: number; // server time B decided to click, relative to throw
}

interface PendingInput {
  arriveMs: number;
  playerId: string;
  input: Partial<PlayerInput>;
  seq: number;
}

function eyePos(z: number): { x: number; y: number; z: number } {
  return vec3(0, EYE, z);
}

/**
 * Run one catch scenario.
 * @param oneWayMs   one-way network latency (ping = 2*oneWayMs)
 * @param ballSpeed  incoming ball speed (m/s)
 * @param clickDist  distance (m) at which B clicks when they PERCEIVE the ball that close
 * @param startZ     z where the incoming ball starts (B is at +12; ball travels +Z)
 */
function runScenario(oneWayMs: number, ballSpeed: number, clickDist: number, startZ = 6): SimResult {
  let serverMs = 100000;
  const loop = new ServerGameLoop('sim', { tickRate: SERVER_TICK_RATE, now: () => serverMs });
  loop.addPlayer('a', 'A');
  loop.addPlayer('b', 'B');
  loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };

  // B (positiveZ) sits at +12 facing -Z; pin it there. A is at -12 facing +Z.
  const bz = 12;
  loop.state.players.b.movement.position = vec3(0, 0, bz);

  const pending: PendingInput[] = [];
  const seqByPlayer: Record<string, number> = { a: 0, b: 0 };
  const ballHistory: Array<{ ms: number; pos: { x: number; y: number; z: number } }> = [];

  const viewDelayMs = INTERPOLATION_DELAY_MS + oneWayMs;
  const step = SERVER_STEP_MS;

  // Warm up a few ticks so defense history populates and the match is live.
  for (let i = 0; i < 5; i += 1) {
    serverMs += step;
    deliverDue(loop, pending, serverMs);
    // both players send a look input
    sendInput(pending, seqByPlayer, 'a', serverMs, oneWayMs, { lookYawRadians: 0, lookPitchRadians: 0 });
    sendInput(pending, seqByPlayer, 'b', serverMs, oneWayMs, { lookYawRadians: Math.PI, lookPitchRadians: 0 });
    loop.step();
  }

  // Inject the incoming live ball owned by A, on a straight path toward B at eye height.
  loop.state.balls.ball_0 = {
    ...loop.state.balls.ball_0,
    phase: 'live',
    ownerKind: 'player',
    ownerId: 'a',
    heldByPlayerId: null,
    heldHand: null,
    position: vec3(0, EYE, startZ),
    velocity: vec3(0, 0, ballSpeed),
    bounceCount: 0,
    throwId: 1
  };
  const throwMs = serverMs;

  let decided = false;
  let perceivedAtMs = -1;
  let clickArriveMs = -1;
  let attemptLatched = false;
  let hitAtMs = -1; // server time (rel throw) a hit FIRST scored — may be reverted by a late catch

  // Score can tick up on a hit then be REVERTED by a lag-compensated catch reclaim within the grace,
  // so we never declare 'hit' on the first positive score — we run on and let the catch resolve.
  const graceMs = GAME_CONSTANTS.combat.catchHitGraceMs;
  const maxMs = 2500;
  for (let t = 0; t < maxMs; t += step) {
    serverMs += step;

    // B's perception of the ball is delayed; decide when to click.
    if (!decided) {
      const perceived = sampleHistory(ballHistory, serverMs - viewDelayMs);
      if (perceived && distance(perceived, eyePos(bz)) <= clickDist) {
        decided = true;
        perceivedAtMs = serverMs - throwMs;
      }
    }

    // B aims dead-center at the incoming ball every tick (best case). Once decided, latch the
    // catch attempt id onto every input until the sim ends (server dedupes the latched re-send).
    const bInput: Partial<PlayerInput> = { lookYawRadians: Math.PI, lookPitchRadians: 0 };
    if (decided) {
      attemptLatched = true;
      bInput.leftCatchAttemptId = 1;
    }
    sendInput(pending, seqByPlayer, 'b', serverMs, oneWayMs, bInput);
    sendInput(pending, seqByPlayer, 'a', serverMs, oneWayMs, { lookYawRadians: 0, lookPitchRadians: 0 });

    deliverDue(loop, pending, serverMs);
    loop.step();

    const ball = loop.state.balls.ball_0;
    ballHistory.push({ ms: serverMs, pos: { ...ball.position } });

    // Record when the latched attempt was first acknowledged (= processed) by the server.
    if (attemptLatched && clickArriveMs < 0 && loop.state.players.b.hands.left.lastCatchAttemptId >= 1) {
      clickArriveMs = serverMs - throwMs;
    }

    // A catch wins outright (even if it reclaimed an already-scored ball — the score is reverted).
    if (ball.phase === 'held' && ball.heldByPlayerId === 'b') {
      return { outcome: 'catch', atMs: serverMs - throwMs, clickArriveMs, perceivedAtMs };
    }
    if (loop.state.match.scoreByTeamId.blue > 0 && hitAtMs < 0) hitAtMs = serverMs - throwMs;
    // Finalize a hit only after the catch-undo grace has fully elapsed with the score still standing.
    if (loop.state.match.scoreByTeamId.blue > 0 && hitAtMs >= 0 && (serverMs - throwMs) - hitAtMs > graceMs) {
      return { outcome: 'hit', atMs: hitAtMs, clickArriveMs, perceivedAtMs };
    }
  }
  // Out of time: if a hit was scored and never reverted, it's a hit; else nothing connected.
  if (loop.state.match.scoreByTeamId.blue > 0) return { outcome: 'hit', atMs: hitAtMs, clickArriveMs, perceivedAtMs };
  return { outcome: 'expired', atMs: -1, clickArriveMs, perceivedAtMs };
}

function sendInput(
  pending: PendingInput[],
  seqByPlayer: Record<string, number>,
  playerId: string,
  sentAtMs: number,
  oneWayMs: number,
  input: Partial<PlayerInput>
): void {
  seqByPlayer[playerId] += 1;
  pending.push({ arriveMs: sentAtMs + oneWayMs, playerId, input: { ...input, sequence: seqByPlayer[playerId] }, seq: seqByPlayer[playerId] });
}

function deliverDue(loop: ServerGameLoop, pending: PendingInput[], nowMs: number): void {
  for (let i = pending.length - 1; i >= 0; i -= 1) {
    if (pending[i].arriveMs <= nowMs) {
      const p = pending[i];
      loop.handleInput(p.playerId, p.input, p.seq);
      pending.splice(i, 1);
    }
  }
}

function sampleHistory(
  history: Array<{ ms: number; pos: { x: number; y: number; z: number } }>,
  targetMs: number
): { x: number; y: number; z: number } | null {
  if (history.length === 0) return null;
  let best = history[0];
  let bestDelta = Math.abs(history[0].ms - targetMs);
  for (const h of history) {
    const d = Math.abs(h.ms - targetMs);
    if (d < bestDelta) { best = h; bestDelta = d; }
  }
  return best.pos;
}

function main(): void {
  const pings = [0, 30, 60, 100, 150];
  const speeds = [18, 24, 30];
  // Defender clicks when they perceive the ball at this distance. Sweep a few: edge-of-range,
  // a bit early (anticipation), and very early.
  const clickDists = [CATCH_RANGE, CATCH_RANGE + 1.5, 6];

  console.log(`\nCatch latency simulation @ ${SERVER_TICK_RATE}Hz, interpDelay=${INTERPOLATION_DELAY_MS}ms, catchRange=${CATCH_RANGE}m, activeWindow=${GAME_CONSTANTS.combat.catchActiveMs}ms`);
  console.log('clickDist = distance at which the defender clicks when they SEE the ball that close\n');

  for (const clickDist of clickDists) {
    console.log(`=== Defender clicks at perceived distance ${clickDist.toFixed(2)}m ===`);
    console.log('ping(ms) | speed | outcome  | outcome@ms | clickProc@ms | perceived@ms');
    console.log('---------+-------+----------+-----------+-------------+------------');
    for (const ping of pings) {
      for (const speed of speeds) {
        const r = runScenario(ping / 2, speed, clickDist);
        console.log(
          `${String(ping).padStart(8)} | ${String(speed).padStart(5)} | ${r.outcome.padEnd(8)} |` +
          ` ${String(r.atMs).padStart(9)} | ${String(r.clickArriveMs).padStart(11)} | ${String(r.perceivedAtMs).padStart(10)}`
        );
      }
    }
    console.log('');
  }
}

main();
