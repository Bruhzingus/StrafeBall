/**
 * Virtual-time catch/parry latency diagnostic.
 *
 * Models the online server loop with a virtual clock, delayed client perception, delayed input
 * arrival, and the real ServerGameLoop catch/parry code. This is intentionally diagnostic only:
 * it does not tune windows or change gameplay. Run from server/: npx tsx scripts/catchLatencySim.ts
 */
import { GAME_CONSTANTS } from '../../shared/constants';
import {
  ACTIVE_NET_MODE,
  INTERPOLATION_DELAY_MS,
  SERVER_STEP_MS,
  SERVER_TICK_RATE
} from '../../shared/netConfig';
import type { HandSide, PlayerInput, Vec3 } from '../../shared/types';
import { distance, vec3 } from '../../shared/simulation/CollisionMath';
import { backflipQteSpeed } from '../../shared/simulation/ThrowMath';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

const EYE = GAME_CONSTANTS.player.eyeHeight;
const DEFENDER_Z = 12;
const START_Z = 6;
const CATCH_RANGE = GAME_CONSTANTS.catch.rangeMeters;
const MAX_SCENARIO_MS = 2500;

type Outcome = 'catch' | 'hit' | 'hit-then-reverted' | 'expired' | 'timeout' | 'parry';

interface SimResult {
  outcome: Outcome;
  outcomeAtMs: number;
  clickAtMs: number;
  perceivedWorldMs: number;
  inputArriveMs: number;
  reclaim: boolean;
  fair: 'yes' | 'no' | 'n/a';
}

interface PendingInput {
  arriveMs: number;
  playerId: string;
  input: Partial<PlayerInput>;
  seq: number;
}

interface BallHistorySample {
  ms: number;
  pos: Vec3;
}

interface SpeedCase {
  label: string;
  speed: number;
}

function runCatchScenario(oneWayMs: number, ballSpeed: number, clickDist: number): SimResult {
  const ctx = createScenario();
  const { loop, pending, seqByPlayer, ballHistory } = ctx;
  const viewDelayMs = INTERPOLATION_DELAY_MS + oneWayMs;
  const throwMs = ctx.serverMs;

  injectIncomingBall(loop, ballSpeed);
  ballHistory.push({ ms: ctx.serverMs, pos: { ...loop.state.balls.ball_0.position } });

  let decided = false;
  let clickAtMs = -1;
  let perceivedWorldMs = -1;
  let inputArriveMs = -1;
  let hitAtMs = -1;
  let reclaim = false;

  for (let elapsedMs = 0; elapsedMs <= MAX_SCENARIO_MS; elapsedMs += SERVER_STEP_MS) {
    ctx.serverMs += SERVER_STEP_MS;

    if (!decided) {
      const perceivedSampleTime = ctx.serverMs - viewDelayMs;
      const perceived = sampleHistory(ballHistory, perceivedSampleTime);
      if (perceived && distance(perceived, eyePos(DEFENDER_Z)) <= clickDist) {
        decided = true;
        clickAtMs = ctx.serverMs - throwMs;
        perceivedWorldMs = perceivedSampleTime - throwMs;
      }
    }

    const bInput: Partial<PlayerInput> = { lookYawRadians: Math.PI, lookPitchRadians: 0 };
    if (decided) bInput.leftCatchAttemptId = 1;
    sendInput(pending, seqByPlayer, 'a', ctx.serverMs, oneWayMs, { lookYawRadians: 0, lookPitchRadians: 0 });
    sendInput(pending, seqByPlayer, 'b', ctx.serverMs, oneWayMs, bInput);

    deliverDue(loop, pending, ctx.serverMs);
    loop.step();

    ballHistory.push({ ms: ctx.serverMs, pos: { ...loop.state.balls.ball_0.position } });

    if (decided && inputArriveMs < 0 && loop.state.players.b.hands.left.lastCatchAttemptId >= 1) {
      inputArriveMs = ctx.serverMs - throwMs;
    }

    for (const event of loop.drainCombatEvents()) {
      if (event.type === 'hit-event' && event.ballId === 'ball_0' && event.targetId === 'b' && hitAtMs < 0) {
        hitAtMs = event.serverTimeMs - throwMs;
      } else if (event.type === 'catch-event' && event.ballId === 'ball_0' && event.catcherId === 'b') {
        reclaim = event.reclaim;
        const outcome: Outcome = hitAtMs >= 0 || reclaim ? 'hit-then-reverted' : 'catch';
        return result(outcome, event.serverTimeMs - throwMs, clickAtMs, perceivedWorldMs, inputArriveMs, reclaim);
      } else if (event.type === 'hit-revert-event' && event.ballId === 'ball_0' && event.targetId === 'b') {
        reclaim = true;
      }
    }

    if (hitAtMs >= 0 && (ctx.serverMs - throwMs) - hitAtMs > GAME_CONSTANTS.combat.catchHitGraceMs) {
      return result('hit', hitAtMs, clickAtMs, perceivedWorldMs, inputArriveMs, reclaim);
    }
  }

  const ball = loop.state.balls.ball_0;
  const outcome: Outcome = ball.phase === 'live' || ball.phase === 'deflected' ? 'timeout' : 'expired';
  return result(outcome, -1, clickAtMs, perceivedWorldMs, inputArriveMs, reclaim);
}

function runParryScenario(oneWayMs: number, ballSpeed: number): SimResult {
  const ctx = createScenario({ parryStance: true });
  const { loop, pending, seqByPlayer } = ctx;
  const throwMs = ctx.serverMs;
  injectIncomingBall(loop, ballSpeed);

  let hitAtMs = -1;
  for (let elapsedMs = 0; elapsedMs <= MAX_SCENARIO_MS; elapsedMs += SERVER_STEP_MS) {
    ctx.serverMs += SERVER_STEP_MS;
    sendInput(pending, seqByPlayer, 'a', ctx.serverMs, oneWayMs, { lookYawRadians: 0, lookPitchRadians: 0 });
    sendInput(pending, seqByPlayer, 'b', ctx.serverMs, oneWayMs, { lookYawRadians: Math.PI, lookPitchRadians: 0 });
    deliverDue(loop, pending, ctx.serverMs);
    loop.step();

    for (const event of loop.drainCombatEvents()) {
      if (event.type === 'parry-event' && event.ballId === 'ball_0' && event.deflectorId === 'b') {
        return result('parry', event.serverTimeMs - throwMs, -1, -1, -1, false);
      }
      if (event.type === 'hit-event' && event.ballId === 'ball_0' && event.targetId === 'b' && hitAtMs < 0) {
        hitAtMs = event.serverTimeMs - throwMs;
      }
    }

    if (hitAtMs >= 0) return result('hit', hitAtMs, -1, -1, -1, false);
  }

  return result('timeout', -1, -1, -1, -1, false);
}

function createScenario(options: { parryStance?: boolean } = {}): {
  loop: ServerGameLoop;
  pending: PendingInput[];
  seqByPlayer: Record<string, number>;
  ballHistory: BallHistorySample[];
  serverMs: number;
} {
  let serverMs = 100000;
  const loop = new ServerGameLoop('sim', { tickRate: SERVER_TICK_RATE, now: () => serverMs });
  loop.addPlayer('a', 'A');
  loop.addPlayer('b', 'B');
  loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
  loop.state.players.a.movement.position = vec3(0, 0, -12);
  loop.state.players.b.movement.position = vec3(0, 0, DEFENDER_Z);

  if (options.parryStance) giveHeldBall(loop, 'b', 'left', 'ball_1');
  if (options.parryStance) giveHeldBall(loop, 'b', 'right', 'ball_2');

  const pending: PendingInput[] = [];
  const seqByPlayer: Record<string, number> = { a: 0, b: 0 };
  const ballHistory: BallHistorySample[] = [];

  for (let i = 0; i < 8; i += 1) {
    serverMs += SERVER_STEP_MS;
    sendInput(pending, seqByPlayer, 'a', serverMs, 0, { lookYawRadians: 0, lookPitchRadians: 0 });
    sendInput(pending, seqByPlayer, 'b', serverMs, 0, { lookYawRadians: Math.PI, lookPitchRadians: 0 });
    deliverDue(loop, pending, serverMs);
    loop.step();
    loop.drainCombatEvents();
  }

  return { loop, pending, seqByPlayer, ballHistory, get serverMs() { return serverMs; }, set serverMs(value: number) { serverMs = value; } };
}

function injectIncomingBall(loop: ServerGameLoop, speed: number): void {
  loop.state.balls.ball_0 = {
    ...loop.state.balls.ball_0,
    phase: 'live',
    ownerKind: 'player',
    ownerId: 'a',
    heldByPlayerId: null,
    heldHand: null,
    position: vec3(0, EYE, START_Z),
    velocity: vec3(0, 0, speed),
    bounceCount: 0,
    isSuper: speed > GAME_CONSTANTS.ball.chargedThrowSpeed,
    curveAccel: vec3(),
    throwId: 1
  };
}

function giveHeldBall(loop: ServerGameLoop, playerId: string, hand: HandSide, ballId: string): void {
  const player = loop.state.players[playerId];
  player.hands = {
    ...player.hands,
    [hand]: {
      ...player.hands[hand],
      heldBallId: ballId,
      mode: 'holding',
      chargeSeconds: 0,
      cooldownSeconds: 0
    }
  };
  loop.state.balls[ballId] = {
    ...loop.state.balls[ballId],
    phase: 'held',
    ownerKind: 'player',
    ownerId: playerId,
    heldByPlayerId: playerId,
    heldHand: hand,
    position: eyePos(DEFENDER_Z),
    velocity: vec3(),
    bounceCount: 0,
    isSuper: false,
    curveAccel: vec3(),
    throwId: 0
  };
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
  pending.push({
    arriveMs: sentAtMs + oneWayMs,
    playerId,
    input: { ...input, clientTimeMs: sentAtMs, sequence: seqByPlayer[playerId] },
    seq: seqByPlayer[playerId]
  });
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

function sampleHistory(history: BallHistorySample[], targetMs: number): Vec3 | null {
  if (history.length === 0) return null;
  let best = history[0];
  let bestDelta = Math.abs(history[0].ms - targetMs);
  for (const sample of history) {
    const delta = Math.abs(sample.ms - targetMs);
    if (delta < bestDelta) {
      best = sample;
      bestDelta = delta;
    }
  }
  return best.pos;
}

function eyePos(z: number): Vec3 {
  return vec3(0, EYE, z);
}

function result(
  outcome: Outcome,
  outcomeAtMs: number,
  clickAtMs: number,
  perceivedWorldMs: number,
  inputArriveMs: number,
  reclaim: boolean
): SimResult {
  return {
    outcome,
    outcomeAtMs,
    clickAtMs,
    perceivedWorldMs,
    inputArriveMs,
    reclaim,
    fair: fairness(outcome, clickAtMs)
  };
}

function fairness(outcome: Outcome, clickAtMs: number): SimResult['fair'] {
  if (outcome === 'catch' || outcome === 'hit-then-reverted' || outcome === 'parry') return 'yes';
  if (outcome === 'hit' && clickAtMs >= 0) return 'no';
  return 'n/a';
}

function fmtMs(value: number): string {
  return value >= 0 ? Math.round(value).toString().padStart(6) : '     -';
}

function speedCases(): SpeedCase[] {
  const quick = GAME_CONSTANTS.ball.quickThrowSpeed;
  return [
    { label: 'quick', speed: quick },
    { label: 'charged', speed: GAME_CONSTANTS.ball.chargedThrowSpeed },
    { label: 'fast2x', speed: quick * GAME_CONSTANTS.ball.fastDoubleThrowPenalty },
    { label: 'qte3', speed: backflipQteSpeed(3) },
    { label: 'qte5', speed: backflipQteSpeed(5) }
  ];
}

function main(): void {
  const oneWayLatencies = [0, 25, 50, 75, 100];
  const speeds = speedCases();
  const clickDistances = [
    Math.max(0.5, CATCH_RANGE - 0.25),
    CATCH_RANGE,
    CATCH_RANGE + 0.75,
    CATCH_RANGE + 1.5
  ];

  console.log(
    `\nCatch/parry latency diagnostic mode=${ACTIVE_NET_MODE} server=${SERVER_TICK_RATE}Hz ` +
    `step=${SERVER_STEP_MS.toFixed(2)}ms interpDelay=${INTERPOLATION_DELAY_MS}ms ` +
    `catchRange=${CATCH_RANGE.toFixed(3)}m active=${GAME_CONSTANTS.combat.catchActiveMs}ms ` +
    `rewind=${GAME_CONSTANTS.combat.catchRewindMs}ms grace=${GAME_CONSTANTS.combat.catchHitGraceMs}ms`
  );
  console.log('oneWayMs is one-way latency. ping ~= 2x oneWayMs. clickAt/perceived/arrive/outcome are server-time ms since throw.\n');

  for (const clickDist of clickDistances) {
    console.log(`=== Catch: defender clicks at perceived distance ${clickDist.toFixed(2)}m ===`);
    console.log('oneWay | speedCase | m/s  | outcome           | out@  | click | seen  | arrive | reclaim | fair');
    console.log('-------+-----------+------+-------------------+-------+-------+-------+--------+---------+-----');
    for (const oneWayMs of oneWayLatencies) {
      for (const speed of speeds) {
        const r = runCatchScenario(oneWayMs, speed.speed, clickDist);
        console.log(
          `${String(oneWayMs).padStart(6)} | ${speed.label.padEnd(9)} | ${speed.speed.toFixed(1).padStart(4)} | ` +
          `${r.outcome.padEnd(17)} | ${fmtMs(r.outcomeAtMs)} | ${fmtMs(r.clickAtMs)} | ` +
          `${fmtMs(r.perceivedWorldMs)} | ${fmtMs(r.inputArriveMs)} | ${String(r.reclaim).padEnd(7)} | ${r.fair}`
        );
      }
    }
    console.log('');
  }

  console.log('=== Auto-parry sanity: defender holds two balls and aims at incoming throw ===');
  console.log('oneWay | speedCase | m/s  | outcome | out@  | fair');
  console.log('-------+-----------+------+---------+-------+-----');
  for (const oneWayMs of oneWayLatencies) {
    for (const speed of speeds) {
      const r = runParryScenario(oneWayMs, speed.speed);
      console.log(
        `${String(oneWayMs).padStart(6)} | ${speed.label.padEnd(9)} | ${speed.speed.toFixed(1).padStart(4)} | ` +
        `${r.outcome.padEnd(7)} | ${fmtMs(r.outcomeAtMs)} | ${r.fair}`
      );
    }
  }
}

main();
