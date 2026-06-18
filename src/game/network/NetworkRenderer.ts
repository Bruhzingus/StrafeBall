import { Color3, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import type { CatchEvent, ServerSnapshot, ThrowEvent } from '../../../shared/protocol';
import type { BallState, HandSide, PlayerState, Vec3 } from '../../../shared/types';
import { BallPredictor } from './BallPredictor';
import { TUNING } from '../config/tuning';
import { computePlayerHandAnchor } from '../../../shared/simulation/HandAnchors';
import { backflipPitchOffset, lookVectorsFromAngles } from '../../../shared/simulation/AimMath';
import { playerAimOriginHeight, playerHitCapsule } from '../../../shared/simulation/PlayerHitbox';
import { isBallPickupStateEligible } from '../../../shared/simulation/BallSim';
import { ballVariantForState, createBallMesh, getBallMaterial, updateBallBlobShadow } from '../ball/BallVisualFactory';
import type { BallVisualEffects } from '../ball/BallVisualEffects';
import { BALL_QTE_TRAIL_SPEED_THRESHOLD, BALL_TRAIL_INTERVAL_SECONDS } from '../ball/BallVisualEffects';
import {
  EXTRAPOLATION_LIMIT_MS,
  HUGE_ERROR_SNAP_METERS,
  INTERPOLATION_DELAY_MS,
  SERVER_STEP_MS,
  SNAPSHOT_BUFFER_LIMIT_MS,
  SNAPSHOT_INTERVAL_MS
} from '../../../shared/netConfig';

interface PlayerVisual {
  root: TransformNode;
  body: Mesh;
  torso: Mesh;
  chestStripe: Mesh;
  hips: Mesh;
  leftShoulder: Mesh;
  rightShoulder: Mesh;
  leftLeg: Mesh;
  rightLeg: Mesh;
  leftFoot: Mesh;
  rightFoot: Mesh;
  head: Mesh;
  visor: Mesh;
  facing: Mesh;
  hitbox: Mesh;
  leftArm: ArmVisual;
  rightArm: ArmVisual;
}

interface ArmVisual {
  upper: Mesh;
  lower: Mesh;
  hand: Mesh;
}

interface ArmAnimTrack {
  throwAnim: number;
  fakeAnim: number;
  previousMode: PlayerState['hands'][HandSide]['mode'];
  previousHeldBallId: string | null;
}

interface RemoteArmAnimations {
  left: ArmAnimTrack;
  right: ArmAnimTrack;
}

interface BallVisual {
  mesh: Mesh;
  trailTimer: number;
  impactPulse: number;
  lastBounceCount: number;
}

const BALL_IMPACT_VISUAL_MIN_SPEED = 8;
const BALL_IMPACT_VISUAL_SPEED_RANGE = 22;
const BALL_SQUASH_XZ_SCALE = 0.08;
const BALL_SQUASH_Y_SCALE = 0.12;

interface CatchRecoilTrack {
  dirX: number;
  dirZ: number;
  baseDistance: number;
  remaining: number;
  duration: number;
}

type RemotePlayerDebug = { logTimer: number };

interface BufferedSnapshot {
  tick: number;
  resetSerial: number;
  /** Wall-clock arrival time (Date.now). Used ONLY for buffer aging, never for interpolation. */
  receivedAtMs: number;
  /**
   * Monotonic server timeline for this snapshot, in ms. Interpolation samples against THIS, not
   * arrival time, which is what removes packet-arrival jitter from the visuals. Derived from
   * snapshot.serverTimeMs when available, else reconstructed from tick deltas.
   */
  serverTimeMs: number;
  players: PlayerState[];
  balls: BallState[];
}

interface BallRenderContinuity {
  phase: BallState['phase'];
  ownerKind: BallState['ownerKind'];
  ownerId: string | null;
  heldByPlayerId: string | null;
  heldHand: HandSide | null;
}

export interface NetworkRendererDebugStats {
  // Existing fields ArenaScene/Hud already read — keep names stable.
  remoteInterpolationBufferSize: number;
  ballInterpolationBufferSize: number;
  renderDelayMs: number;
  latestSnapshotAgeMs: number;
  oldestSnapshotAgeMs: number;
  // New metrics, sampled over a rolling ~1s window.
  bufferUnderrunsPerSec: number;
  bufferOverrunsPerSec: number;
  avgSnapshotIntervalMs: number;
  maxSnapshotIntervalMs: number;
  remoteSnapCount: number;
  ballSnapCount: number;
  lastCorrectionReason: string;
  ballPredictionCount: number;
  ballPredictionCorrections: number;
  ballPredictionMaxCorrections: number;
  ballPredictionMaxErrorM: number;
  ballPredictionLastErrorM: number;
  ballPredictionSnapCount: number;
  ballPredictionSoftCorrections: number;
  ballPredictionMediumCorrections: number;
  ballPredictionSnapReasonCounts: Record<string, number>;
}

export class NetworkRenderer {
  // All timing now derives from the shared net config (single source of truth) — no hardcoded ms.
  private static readonly INTERPOLATION_DELAY_MS = INTERPOLATION_DELAY_MS;
  static readonly BALL_EXTRAPOLATION_MAX_MS = EXTRAPOLATION_LIMIT_MS;
  private static readonly MAX_BUFFER_MS = SNAPSHOT_BUFFER_LIMIT_MS;
  static readonly HUGE_ERROR_SNAP_METERS = HUGE_ERROR_SNAP_METERS;
  // Fraction of the render-cursor error corrected per frame so the cursor tracks real time
  // smoothly instead of snapping on every jittery arrival.
  private static readonly CURSOR_CORRECTION_PER_FRAME = 0.1;
  // If the cursor drifts further than this from its target we resync hard (big stall / tab resume).
  private static readonly CURSOR_RESYNC_THRESHOLD_MS = Math.max(250, SNAPSHOT_INTERVAL_MS * 8);

  private readonly players = new Map<string, PlayerVisual>();
  private readonly playerDebug = new Map<string, RemotePlayerDebug>();
  private readonly balls = new Map<string, BallVisual>();
  private readonly remoteArmAnimations = new Map<string, RemoteArmAnimations>();
  private readonly catchRecoilByPlayerId = new Map<string, CatchRecoilTrack>();
  // Deterministic visual prediction for live thrown balls (seeded by throw events). Visual only.
  private readonly ballPredictor = new BallPredictor();
  private readonly materials = new Map<string, PBRMaterial>();
  // Reused per-frame "seen this update" sets — cleared in place each frame instead of reallocated.
  private readonly seenPlayers = new Set<string>();
  private readonly seenBalls = new Set<string>();
  private readonly snapshotBuffer: BufferedSnapshot[] = [];
  private readonly ballRenderContinuity = new Map<string, BallRenderContinuity>();
  private lastBufferedTick = -1;
  private lastBufferedResetSerial = -1;
  private latestSnapshotReceivedAtMs = 0;

  // Smoothed render clock. `renderServerTime` is the point on the SERVER timeline we are currently
  // displaying; it advances by real dt every frame and is gently nudged toward
  // (latestServerTime - INTERPOLATION_DELAY_MS). Decoupling it from packet arrival is the core fix.
  private renderServerTime = 0;
  private interpolationDelayMs = INTERPOLATION_DELAY_MS;
  private renderClockInitialized = false;
  // Reconstruct a server timeline from tick deltas when serverTimeMs looks unusable.
  private serverTimeBaseMs = 0;
  private serverTimeBaseTick = 0;
  private serverTimeBaseInitialized = false;

  // Rolling debug-metric window (reset ~every 1s).
  private metricWindowStartMs = 0;
  private metricUnderruns = 0;
  private metricOverruns = 0;
  private metricIntervalTotalMs = 0;
  private metricIntervalCount = 0;
  private metricIntervalMaxMs = 0;
  private metricRemoteSnaps = 0;
  private metricBallSnaps = 0;
  private debugStats: NetworkRendererDebugStats = emptyDebugStats();

  // Reusable "render player" view, mutated in place each frame in posePlayerVisual instead of
  // allocating a fresh spread of the PlayerState/movement tree per remote player per frame. Its
  // movement is a scratch object whose position is pinned to the (flip-adjusted) visual root while
  // the look angles / crouch flags mirror the live player; hands alias the live player's hands.
  private readonly renderPlayerPosition: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly renderPlayerMovement = createScratchMovement(this.renderPlayerPosition);
  private readonly renderPlayerScratch: PlayerState = createScratchPlayer(this.renderPlayerMovement);

  constructor(private readonly scene: Scene, private readonly ballVisualEffects?: BallVisualEffects) {}

  /**
   * @param localPredicted the local player's present-time PREDICTED movement (from ArenaScene's
   *   client-side prediction). When provided, a ball held by the local player attaches to this
   *   present-time hand anchor instead of the ~INTERPOLATION_DELAY_MS-old interpolated one — without
   *   it the local player's own held ball visibly drags behind while strafing.
   */
  update(
    snapshot: ServerSnapshot,
    localPlayerId: string,
    dt: number,
    localPredicted?: PlayerState['movement'] | null
  ): void {
    this.bufferSnapshot(snapshot);
    const targetTimeMs = this.advanceRenderClock(dt);
    if (targetTimeMs === null) return;
    const renderSnapshot = this.sampleBufferedSnapshot(targetTimeMs);
    if (!renderSnapshot) return;
    this.refreshDebugStats(dt);
    this.updatePlayers(renderSnapshot.players, localPlayerId, dt);
    // Live thrown balls render at PRESENT server time via deterministic prediction, reconciled
    // against the newest authoritative snapshot; everything else uses the interpolated render snapshot.
    const newest = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    this.updateBalls(renderSnapshot.balls, renderSnapshot.players, localPlayerId, localPredicted ?? null, newest, dt);
  }

  /** Seed/refresh live-ball visual prediction from authoritative throw events (called by the scene). */
  applyThrowEvents(events: readonly ThrowEvent[]): void {
    for (const event of events) {
      this.ballPredictor.applyThrowEvent(event);
      const anim = this.ensureRemoteArmAnimations(event.ownerId);
      anim[event.hand].throwAnim = 1;
      anim[event.hand].fakeAnim = 0;
      if (isBallPredictDebugEnabled()) {
        console.log(`[ball/predict] seed ballId=${event.ballId} throwId=${event.throwId} owner=${event.ownerId.slice(-4)} curve=${Number(event.isCurve)}`);
      }
    }
  }

  applyCatchEvents(events: readonly CatchEvent[]): void {
    for (const event of events) {
      const speed = event.absorbedSpeed;
      if (speed < TUNING.catch.momentumRecoilMinSpeed) continue;
      const horizontal = Math.hypot(event.incomingVelocity.x, event.incomingVelocity.z);
      if (horizontal <= 0.001) continue;
      const strength = Math.max(
        0,
        Math.min(
          1,
          (speed - TUNING.catch.momentumRecoilMinSpeed) /
            Math.max(0.001, TUNING.catch.momentumRecoilMaxSpeed - TUNING.catch.momentumRecoilMinSpeed)
        )
      );
      const distance =
        TUNING.catch.momentumRecoilMinDistance +
        (TUNING.catch.momentumRecoilMaxDistance - TUNING.catch.momentumRecoilMinDistance) * strength;
      this.catchRecoilByPlayerId.set(event.catcherId, {
        dirX: -event.incomingVelocity.x / horizontal,
        dirZ: -event.incomingVelocity.z / horizontal,
        baseDistance: distance,
        remaining: TUNING.catch.momentumRecoilDuration,
        duration: TUNING.catch.momentumRecoilDuration
      });
    }
  }

  getDebugStats(): NetworkRendererDebugStats {
    // Keep the live buffer size / age fields fresh; rate-style metrics come from the rolling window.
    this.debugStats.remoteInterpolationBufferSize = this.snapshotBuffer.length;
    this.debugStats.ballInterpolationBufferSize = this.snapshotBuffer.length;
    this.debugStats.renderDelayMs = this.interpolationDelayMs;
    const now = Date.now();
    const oldest = this.snapshotBuffer[0];
    const newest = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    this.debugStats.latestSnapshotAgeMs = newest ? Math.max(0, now - newest.serverTimeMs) : 0;
    this.debugStats.oldestSnapshotAgeMs = oldest ? Math.max(0, now - oldest.serverTimeMs) : 0;
    const ballPredictionStats = this.ballPredictor.getStats();
    this.debugStats.ballPredictionCount = ballPredictionStats.activePredictions;
    this.debugStats.ballPredictionCorrections = ballPredictionStats.totalCorrections;
    this.debugStats.ballPredictionMaxCorrections = ballPredictionStats.maxCorrections;
    this.debugStats.ballPredictionMaxErrorM = ballPredictionStats.maxErrorM;
    this.debugStats.ballPredictionLastErrorM = ballPredictionStats.lastErrorM;
    this.debugStats.ballPredictionSnapCount = ballPredictionStats.snapCount;
    this.debugStats.ballPredictionSoftCorrections = ballPredictionStats.softCorrectionCount;
    this.debugStats.ballPredictionMediumCorrections = ballPredictionStats.mediumCorrectionCount;
    this.debugStats.ballPredictionSnapReasonCounts = ballPredictionStats.snapReasonCounts;
    return this.debugStats;
  }

  clear(): void {
    for (const visual of this.players.values()) {
      visual.root.dispose();
    }
    for (const visual of this.balls.values()) {
      visual.mesh.dispose();
    }
    this.players.clear();
    this.playerDebug.clear();
    this.remoteArmAnimations.clear();
    this.balls.clear();
    this.seenPlayers.clear();
    this.seenBalls.clear();
    this.snapshotBuffer.length = 0;
    this.ballRenderContinuity.clear();
    this.ballPredictor.clear();
    this.lastBufferedTick = -1;
    this.lastBufferedResetSerial = -1;
    this.latestSnapshotReceivedAtMs = 0;
    this.resetRenderClock();
    this.resetMetrics();
    this.debugStats = emptyDebugStats();
  }

  dispose(): void {
    this.clear();
    for (const material of this.materials.values()) {
      material.dispose();
    }
    this.materials.clear();
    this.playerDebug.clear();
    this.remoteArmAnimations.clear();
    this.catchRecoilByPlayerId.clear();
  }

  private bufferSnapshot(snapshot: ServerSnapshot): void {
    const resetSerial = snapshot.room.resetVote.resetSerial;
    if (resetSerial !== this.lastBufferedResetSerial) {
      if (this.lastBufferedResetSerial !== -1 && isNetworkRenderDebugEnabled()) {
        console.log(`[net/render-buffer] reset serial ${this.lastBufferedResetSerial} -> ${resetSerial}; clearing interpolation buffer`);
      }
      // resetSerial change: clear buffer + continuity + ball prediction, and resync the render clock
      // so the cursor re-locks to the fresh timeline instead of dragging the old one through the
      // discontinuity. Dropping predictions prevents a stale throwId carrying across the reset.
      this.snapshotBuffer.length = 0;
      this.ballRenderContinuity.clear();
      this.ballPredictor.clear();
      this.lastBufferedTick = -1;
      this.lastBufferedResetSerial = resetSerial;
      this.resetRenderClock();
    }

    // Out-of-order / duplicate ticks: ignore anything not strictly newer than the last buffered.
    if (snapshot.tick <= this.lastBufferedTick) return;

    const now = Date.now();
    if (this.latestSnapshotReceivedAtMs > 0) {
      const interval = now - this.latestSnapshotReceivedAtMs;
      this.metricIntervalTotalMs += interval;
      this.metricIntervalCount += 1;
      this.metricIntervalMaxMs = Math.max(this.metricIntervalMaxMs, interval);
    }
    this.latestSnapshotReceivedAtMs = now;
    this.lastBufferedTick = snapshot.tick;
    this.snapshotBuffer.push({
      tick: snapshot.tick,
      resetSerial,
      receivedAtMs: now,
      serverTimeMs: this.deriveServerTime(snapshot),
      players: Object.values(snapshot.room.players).map(clonePlayerState),
      balls: Object.values(snapshot.room.balls).map(cloneBallState)
    });

    // Buffer overflow: drop snapshots older than the configured age, always keeping >= 2 so we can
    // still bracket the render cursor for interpolation.
    while (
      this.snapshotBuffer.length > 2 &&
      now - this.snapshotBuffer[0].receivedAtMs > NetworkRenderer.MAX_BUFFER_MS
    ) {
      this.snapshotBuffer.shift();
      this.metricOverruns += 1;
    }
  }

  /**
   * Map a snapshot to a monotonic SERVER-timeline value. Prefer the server's own serverTimeMs.
   * If that field is missing/non-monotonic (e.g. the synthetic joined-room snapshot), reconstruct
   * it from tick deltas using the known snapshot interval, anchored to the first usable value.
   */
  private deriveServerTime(snapshot: ServerSnapshot): number {
    const reported = snapshot.serverTimeMs;
    const reconstructed = () => {
      if (!this.serverTimeBaseInitialized) {
        // Anchor the reconstructed timeline to the reported value if present, else to 0.
        this.serverTimeBaseMs = Number.isFinite(reported) && reported > 0 ? reported : 0;
        this.serverTimeBaseTick = snapshot.tick;
        this.serverTimeBaseInitialized = true;
      }
      return this.serverTimeBaseMs + (snapshot.tick - this.serverTimeBaseTick) * SERVER_STEP_MS;
    };

    if (!Number.isFinite(reported) || reported <= 0) return reconstructed();

    // Sanity-check the reported clock against the tick-derived expectation. A wildly inconsistent
    // serverTimeMs (clock reset, synthetic snapshot) falls back to the reconstructed timeline.
    if (this.serverTimeBaseInitialized) {
      const expected = this.serverTimeBaseMs + (snapshot.tick - this.serverTimeBaseTick) * SERVER_STEP_MS;
      if (Math.abs(reported - expected) > NetworkRenderer.CURSOR_RESYNC_THRESHOLD_MS) {
        // Re-anchor reconstruction to the reported value and trust the server clock going forward.
        this.serverTimeBaseMs = reported;
        this.serverTimeBaseTick = snapshot.tick;
      }
    } else {
      this.serverTimeBaseMs = reported;
      this.serverTimeBaseTick = snapshot.tick;
      this.serverTimeBaseInitialized = true;
    }
    return reported;
  }

  /**
   * Advance the smoothed render cursor by real dt and gently nudge it toward the playback target
   * (newest server time - interpolation delay). Returns the server-timeline value to sample at, or
   * null when there is nothing buffered yet. THIS is what makes visuals advance by dt rather than
   * jumping with each packet arrival.
   */
  private advanceRenderClock(dt: number): number | null {
    if (this.snapshotBuffer.length === 0) return null;

    const newest = this.snapshotBuffer[this.snapshotBuffer.length - 1];
    const target = newest.serverTimeMs - this.interpolationDelayMs;

    if (!this.renderClockInitialized) {
      this.renderServerTime = target;
      this.renderClockInitialized = true;
      return this.renderServerTime;
    }

    // Advance by real elapsed time, then correct a fraction of the error toward the target. dt is
    // in seconds (matches the rest of the scene loop); convert to ms.
    this.renderServerTime += dt * 1000;
    const error = target - this.renderServerTime;
    if (Math.abs(error) > NetworkRenderer.CURSOR_RESYNC_THRESHOLD_MS) {
      // Hard resync after a large stall so we don't crawl back over many seconds.
      this.renderServerTime = target;
    } else {
      this.renderServerTime += error * NetworkRenderer.CURSOR_CORRECTION_PER_FRAME;
    }
    return this.renderServerTime;
  }

  private sampleBufferedSnapshot(targetTimeMs: number): BufferedSnapshot | null {
    if (this.snapshotBuffer.length === 0) return null;
    if (this.snapshotBuffer.length === 1) return this.snapshotBuffer[0];

    const oldest = this.snapshotBuffer[0];
    const newest = this.snapshotBuffer[this.snapshotBuffer.length - 1];

    // Cursor behind the oldest buffered server time: hold the oldest (nothing older to lerp from).
    if (targetTimeMs <= oldest.serverTimeMs) return oldest;

    // Buffer underrun: cursor past the newest snapshot. Extrapolate (clamped) for live/deflected
    // balls and briefly for players, else hold.
    if (targetTimeMs >= newest.serverTimeMs) {
      this.metricUnderruns += 1;
      return extrapolateSnapshot(newest, targetTimeMs - newest.serverTimeMs);
    }

    let before: BufferedSnapshot = oldest;
    let after: BufferedSnapshot = newest;
    for (let i = 0; i < this.snapshotBuffer.length; i += 1) {
      const snapshot = this.snapshotBuffer[i];
      if (snapshot.serverTimeMs <= targetTimeMs) before = snapshot;
      if (snapshot.serverTimeMs >= targetTimeMs) {
        after = snapshot;
        break;
      }
    }

    if (before === after) return before;

    const spanMs = Math.max(1, after.serverTimeMs - before.serverTimeMs);
    const t = clamp01((targetTimeMs - before.serverTimeMs) / spanMs);
    return interpolateSnapshots(before, after, t, targetTimeMs);
  }

  private resetRenderClock(): void {
    this.renderServerTime = 0;
    this.renderClockInitialized = false;
    this.serverTimeBaseMs = 0;
    this.serverTimeBaseTick = 0;
    this.serverTimeBaseInitialized = false;
  }

  private resetMetrics(): void {
    this.metricWindowStartMs = 0;
    this.metricUnderruns = 0;
    this.metricOverruns = 0;
    this.metricIntervalTotalMs = 0;
    this.metricIntervalCount = 0;
    this.metricIntervalMaxMs = 0;
    this.metricRemoteSnaps = 0;
    this.metricBallSnaps = 0;
  }

  /** Roll the debug-metric window roughly once per second, computing per-second rates. */
  private refreshDebugStats(_dt: number): void {
    const now = Date.now();
    if (this.metricWindowStartMs === 0) this.metricWindowStartMs = now;
    const elapsed = now - this.metricWindowStartMs;
    if (elapsed < 1000) return;

    const seconds = elapsed / 1000;
    this.debugStats.bufferUnderrunsPerSec = this.metricUnderruns / seconds;
    this.debugStats.bufferOverrunsPerSec = this.metricOverruns / seconds;
    this.debugStats.avgSnapshotIntervalMs =
      this.metricIntervalCount > 0 ? this.metricIntervalTotalMs / this.metricIntervalCount : 0;
    this.debugStats.maxSnapshotIntervalMs = this.metricIntervalMaxMs;
    this.debugStats.remoteSnapCount = this.metricRemoteSnaps;
    this.debugStats.ballSnapCount = this.metricBallSnaps;
    this.updateAdaptiveInterpolationDelay();

    this.metricWindowStartMs = now;
    this.metricUnderruns = 0;
    this.metricOverruns = 0;
    this.metricIntervalTotalMs = 0;
    this.metricIntervalCount = 0;
    this.metricIntervalMaxMs = 0;
    this.metricRemoteSnaps = 0;
    this.metricBallSnaps = 0;
  }

  private updateAdaptiveInterpolationDelay(): void {
    this.interpolationDelayMs = INTERPOLATION_DELAY_MS;
  }

  private updatePlayers(players: PlayerState[], localPlayerId: string, dt: number): void {
    const seen = this.seenPlayers;
    seen.clear();

    for (const player of players) {
      if (player.id === localPlayerId) continue;
      if (player.connected === false) continue;
      seen.add(player.id);
      const visual = this.ensurePlayer(player);
      this.updateRemoteArmAnimations(player, dt);
      const target = player.movement.position;
      const recoil = this.advanceCatchRecoil(player.id, dt);
      const recoilDistance = recoil ? recoil.baseDistance * (recoil.remaining / recoil.duration) : 0;
      const recoilX = recoil ? recoil.dirX * recoilDistance : 0;
      const recoilZ = recoil ? recoil.dirZ * recoilDistance : 0;
      const remoteError = distanceVec3(
        { x: visual.root.position.x, y: visual.root.position.y, z: visual.root.position.z },
        { x: target.x + recoilX, y: target.y, z: target.z + recoilZ }
      );
      if (remoteError > NetworkRenderer.HUGE_ERROR_SNAP_METERS) {
        this.recordCorrection('remote-large-error');
        if (isNetworkRenderDebugEnabled()) {
          console.log(`[remote/${player.id.slice(-4)}] snap largeError=${remoteError.toFixed(2)}m delay=${this.interpolationDelayMs.toFixed(1)}ms`);
        }
      }
      visual.root.position.set(target.x + recoilX, target.y, target.z + recoilZ);
      visual.root.rotation.y = 0;
      // Backflip body tumble: rotate the whole rig backward about its mid-height so the remote
      // avatar visibly flips. Pivot at body center (not the feet) by lifting the root by the
      // rotated half-height offset, so the body spins in place instead of swinging from the floor.
      const flip = backflipPitchOffset(player.movementInternal.backflipActive, player.movementInternal.backflipTimer);
      visual.root.rotation.x = flip;
      if (flip !== 0) {
        const half = TUNING.player.height * 0.5;
        // Lift so the rotation pivots around mid-body: feet stay roughly under the center.
        visual.root.position.y = target.y + half - half * Math.cos(flip);
        visual.root.position.z = target.z - half * Math.sin(flip);
      }
      this.posePlayerVisual(player, visual);

      const dbg = this.playerDebug.get(player.id)!;
      dbg.logTimer += dt;
      if (isNetworkRenderDebugEnabled() && dbg.logTimer >= 1.0) {
        dbg.logTimer = 0;
        const mp = player.movement.position;
        const rp = visual.root.position;
        const left = computePlayerHandAnchor(player, 'left');
        const right = computePlayerHandAnchor(player, 'right');
        console.log(
          `[remote/${player.id.slice(-4)}] target=(${mp.x.toFixed(2)},${mp.y.toFixed(2)},${mp.z.toFixed(2)})` +
          ` mesh=(${rp.x.toFixed(2)},${rp.y.toFixed(2)},${rp.z.toFixed(2)})` +
          ` yaw=${player.movement.yawRadians.toFixed(2)} pitch=${player.movement.pitchRadians.toFixed(2)}` +
          ` hands=L(${left.x.toFixed(2)},${left.y.toFixed(2)},${left.z.toFixed(2)})` +
          ` R(${right.x.toFixed(2)},${right.y.toFixed(2)},${right.z.toFixed(2)})`
        );
      }
    }

    for (const [id, visual] of this.players) {
      if (seen.has(id)) continue;
      visual.root.dispose();
      this.players.delete(id);
      this.playerDebug.delete(id);
      this.remoteArmAnimations.delete(id);
      this.catchRecoilByPlayerId.delete(id);
    }
  }

  private advanceCatchRecoil(playerId: string, dt: number): CatchRecoilTrack | null {
    const track = this.catchRecoilByPlayerId.get(playerId);
    if (!track) return null;
    track.remaining = Math.max(0, track.remaining - dt);
    if (track.remaining <= 0 || track.baseDistance <= 0.001) {
      this.catchRecoilByPlayerId.delete(playerId);
      return null;
    }
    return track;
  }

  private updateRemoteArmAnimations(player: PlayerState, dt: number): void {
    const anim = this.ensureRemoteArmAnimations(player.id);
    for (const side of ['left', 'right'] as const) {
      const track = anim[side];
      const hand = player.hands[side];
      const canceledCharge =
        track.previousMode === 'charging' &&
        hand.mode === 'holding' &&
        track.previousHeldBallId !== null &&
        track.previousHeldBallId === hand.heldBallId &&
        track.throwAnim <= 0;

      if (canceledCharge) track.fakeAnim = 1;

      track.throwAnim = Math.max(0, track.throwAnim - dt / TUNING.arms.throwAnimSeconds);
      track.fakeAnim = Math.max(0, track.fakeAnim - dt / TUNING.arms.fakeAnimSeconds);
      track.previousMode = hand.mode;
      track.previousHeldBallId = hand.heldBallId;
    }
  }

  private ensureRemoteArmAnimations(playerId: string): RemoteArmAnimations {
    let anim = this.remoteArmAnimations.get(playerId);
    if (anim) return anim;
    anim = {
      left: createArmAnimTrack(),
      right: createArmAnimTrack()
    };
    this.remoteArmAnimations.set(playerId, anim);
    return anim;
  }

  private updateBalls(
    balls: BallState[],
    players: PlayerState[],
    localPlayerId: string,
    localPredicted: PlayerState['movement'] | null,
    newest: BufferedSnapshot | undefined,
    dt: number
  ): void {
    const seen = this.seenBalls;
    seen.clear();
    const presentTimeMs = newest ? newest.serverTimeMs : 0;
    const highlightedBallId = localPredicted ? findPickupLookBallId(balls, localPredicted) : null;

    for (const ball of balls) {
      seen.add(ball.id);
      const visual = this.ensureBall(ball);

      // Held balls: attach to the holder's hand anchor. For a REMOTE holder, use the interpolated
      // holder state so the ball rides the smooth avatar. For the LOCAL holder, use the present-time
      // PREDICTED movement (when supplied) so the ball stays glued to the player's hand instead of
      // dragging ~INTERPOLATION_DELAY_MS behind while strafing. The held<->live transition is a
      // continuity change, so it snaps rather than lerping.
      // `target` is a plain {x,y,z}; written into the mesh position at the end (no Vector3 alloc).
      const target = scratchBallTarget;
      target.x = ball.position.x;
      target.y = ball.position.y;
      target.z = ball.position.z;
      // Instant local throw detach (Phase 3): if this (interpolation-delayed) render snapshot still
      // shows the ball HELD but a throw event already seeded prediction, the ball has LEFT the hand
      // on the server. Bridge with a visual-only advance so the thrower's ball detaches immediately
      // on release rather than staying glued for ~half-RTT. The normal live branch takes over the
      // instant the authoritative snapshot flips to live.
      const heldBridge = newest && ball.heldByPlayerId !== null && this.ballPredictor.has(ball.id)
        ? this.ballPredictor.advanceVisualOnly(ball.id, presentTimeMs)
        : null;
      if (heldBridge) {
        target.x = heldBridge.x;
        target.y = heldBridge.y;
        target.z = heldBridge.z;
      } else if (ball.heldByPlayerId && ball.heldHand) {
        // Held ball never predicts; forget any stale prediction so a re-throw reseeds cleanly.
        this.ballPredictor.forget(ball.id);
        const holder = findById(players, ball.heldByPlayerId);
        const holderClaimsBall = holder?.hands[ball.heldHand].heldBallId === ball.id;
        if (!holderClaimsBall) {
          if (isNetworkRenderDebugEnabled()) {
            console.log(
              `[net/ball] suppress orphan held-ball id=${ball.id} holder=${ball.heldByPlayerId}` +
              ` hand=${ball.heldHand} claimed=${holder?.hands[ball.heldHand].heldBallId ?? '-'}`
            );
          }
        } else if (ball.heldByPlayerId === localPlayerId && localPredicted && holder) {
          // Reuse the scratch render-player rather than spreading the holder each frame.
          this.renderPlayerScratch.movement = localPredicted;
          const anchor = computePlayerHandAnchor(this.renderPlayerScratch, ball.heldHand);
          this.renderPlayerScratch.movement = this.renderPlayerMovement; // restore alias
          // Keep the LOCAL held ball in front of the eye so it's always visible: the raw hand anchor
          // can fall beside/behind the camera near-plane (e.g. steep pitch while moving), which made
          // your own ball briefly vanish. Clamp it to a minimum forward distance along the look dir.
          keepInFrontOfEyeToRef(anchor, localPredicted, target);
        } else if (holder) {
          const anchor = computePlayerHandAnchor(holder, ball.heldHand);
          target.x = anchor.x;
          target.y = anchor.y;
          target.z = anchor.z;
        }
      } else if ((ball.phase === 'live' || ball.phase === 'deflected') && newest) {
        // Live/deflected balls: render the deterministic prediction at PRESENT server time when one
        // is seeded (reconciled against the newest authoritative ball state), else fall back to the
        // interpolated snapshot position. Prediction is visual only — gameplay outcomes are the
        // server's. The predictor reconciles against the newest snapshot, not the delayed interp one.
        const authoritative = findById(newest.balls, ball.id) ?? ball;
        const result = this.ballPredictor.predict(authoritative, presentTimeMs);
        if (result) {
          target.x = result.position.x;
          target.y = result.position.y;
          target.z = result.position.z;
          if (result.snapped) this.recordCorrection(`ball-predict-${result.snapReason || 'snap'}`);
          if (isBallPredictDebugEnabled() && (result.snapped || result.errorM > 0.5)) {
            console.log(
              `[ball/predict] id=${ball.id} throwId=${result.throwId} mode=${ball.phase}` +
              ` err=${result.errorM.toFixed(2)}m corrections=${result.correctionCount}` +
              `${result.snapReason ? ` snap=${result.snapReason}` : ''}`
            );
          }
        }
      } else {
        // Loose/dead/resting: no prediction; drop any stale entry.
        this.ballPredictor.forget(ball.id);
      }

      const previous = this.ballRenderContinuity.get(ball.id);
      const changed = previous !== undefined && !continuityMatchesBall(previous, ball);
      const mp = visual.mesh.position;
      const ballError = distanceVec3({ x: mp.x, y: mp.y, z: mp.z }, target);
      if (changed || ballError > NetworkRenderer.HUGE_ERROR_SNAP_METERS) {
        this.recordCorrection(changed ? 'ball-continuity-change' : 'ball-large-error');
        if (isNetworkRenderDebugEnabled()) {
          console.log(
            `[net/ball] snap id=${ball.id} phase=${ball.phase} changed=${Number(changed)} error=${ballError.toFixed(2)}m`
          );
        }
      }
      visual.mesh.position.set(target.x, target.y, target.z);
      if (ball.bounceCount > visual.lastBounceCount) {
        const speed = Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z);
        if (speed >= BALL_IMPACT_VISUAL_MIN_SPEED) {
          const pulse = Math.min(0.55, (speed - BALL_IMPACT_VISUAL_MIN_SPEED) / BALL_IMPACT_VISUAL_SPEED_RANGE);
          visual.impactPulse = Math.max(visual.impactPulse, pulse);
        }
      }
      visual.lastBounceCount = ball.bounceCount;
      const desiredMaterial = getBallMaterial(
        this.scene,
        ball.id === highlightedBallId
          ? ballVariantForState({ phase: ball.phase, isSuper: ball.isSuper, highlighted: true })
          : ballVariantForState(ball)
      );
      if (visual.mesh.material !== desiredMaterial) visual.mesh.material = desiredMaterial;
      visual.mesh.setEnabled(true);
      this.updateBallEffects(visual, ball, dt);
      // Update the stored continuity in place (allocate one only the first time we see this ball).
      if (previous) {
        copyBallContinuity(previous, ball);
      } else {
        this.ballRenderContinuity.set(ball.id, ballContinuity(ball));
      }
    }

    for (const [id, visual] of this.balls) {
      if (seen.has(id)) continue;
      visual.mesh.dispose();
      this.balls.delete(id);
      this.ballRenderContinuity.delete(id);
    }
  }

  private ensurePlayer(player: PlayerState): PlayerVisual {
    const existing = this.players.get(player.id);
    if (existing) return existing;
    if (isNetworkRenderDebugEnabled()) console.log(`[remote] creating avatar player=${player.id} team=${player.teamId}`);

    const root = new TransformNode(`remotePlayer_${player.id}`, this.scene);
    root.position = toVector3(player.movement.position);

    const body = MeshBuilder.CreateCapsule(
      `remotePlayerBody_${player.id}`,
      { height: TUNING.player.height, radius: TUNING.player.radius, tessellation: 18 },
      this.scene
    );
    body.parent = root;
    body.position.y = TUNING.player.height * 0.5;
    body.material = this.material(player.teamId === 'red' ? 'playerRedSuit' : 'playerBlueSuit');
    body.isPickable = false;

    const torso = MeshBuilder.CreateBox(
      `remotePlayerTorso_${player.id}`,
      { width: 0.62, height: 0.58, depth: 0.28 },
      this.scene
    );
    torso.parent = root;
    torso.material = this.material(player.teamId === 'red' ? 'playerRedJersey' : 'playerBlueJersey');
    torso.isPickable = false;

    const chestStripe = MeshBuilder.CreateBox(
      `remotePlayerChestStripe_${player.id}`,
      { width: 0.5, height: 0.08, depth: 0.035 },
      this.scene
    );
    chestStripe.parent = root;
    chestStripe.material = this.material('playerUniformTrim');
    chestStripe.isPickable = false;

    const hips = MeshBuilder.CreateBox(
      `remotePlayerHips_${player.id}`,
      { width: 0.54, height: 0.18, depth: 0.34 },
      this.scene
    );
    hips.parent = root;
    hips.material = this.material('playerShorts');
    hips.isPickable = false;

    const leftShoulder = this.buildShoulder(player.id, 'left', root, player.teamId);
    const rightShoulder = this.buildShoulder(player.id, 'right', root, player.teamId);
    const leftLeg = this.buildLeg(player.id, 'left', root);
    const rightLeg = this.buildLeg(player.id, 'right', root);
    const leftFoot = this.buildFoot(player.id, 'left', root);
    const rightFoot = this.buildFoot(player.id, 'right', root);

    const head = MeshBuilder.CreateSphere(
      `remotePlayerHead_${player.id}`,
      { diameter: 0.42, segments: 16 },
      this.scene
    );
    head.parent = root;
    head.position.y = TUNING.player.eyeHeight - 0.06;
    head.scaling.set(1.02, 0.9, 1.04);
    head.material = this.material('playerHead');
    head.isPickable = false;

    const visor = MeshBuilder.CreateBox(
      `remotePlayerVisor_${player.id}`,
      { width: 0.34, height: 0.075, depth: 0.035 },
      this.scene
    );
    visor.parent = root;
    visor.material = this.material('playerVisor');
    visor.isPickable = false;

    const facing = MeshBuilder.CreateCylinder(
      `remotePlayerFacing_${player.id}`,
      { height: 0.52, diameter: 0.07, tessellation: 10 },
      this.scene
    );
    facing.parent = root;
    facing.material = this.material('playerFacing');
    facing.isPickable = false;

    const hitbox = MeshBuilder.CreateCapsule(
      `remotePlayerHitbox_${player.id}`,
      { height: TUNING.player.height, radius: TUNING.player.radius, tessellation: 18 },
      this.scene
    );
    hitbox.parent = root;
    hitbox.position.y = TUNING.player.height * 0.5;
    hitbox.material = this.material('playerHitbox');
    hitbox.isPickable = false;
    hitbox.setEnabled(false);

    const visual = {
      root,
      body,
      torso,
      chestStripe,
      hips,
      leftShoulder,
      rightShoulder,
      leftLeg,
      rightLeg,
      leftFoot,
      rightFoot,
      head,
      visor,
      facing,
      hitbox,
      leftArm: this.buildArm(player.id, 'left', root),
      rightArm: this.buildArm(player.id, 'right', root)
    };
    this.players.set(player.id, visual);
    this.playerDebug.set(player.id, { logTimer: 0 });
    return visual;
  }

  private buildShoulder(playerId: string, side: HandSide, root: TransformNode, teamId: string): Mesh {
    const shoulder = MeshBuilder.CreateBox(
      `remotePlayer_${playerId}_${side}_shoulderPad`,
      { width: 0.24, height: 0.13, depth: 0.28 },
      this.scene
    );
    shoulder.parent = root;
    shoulder.material = this.material(teamId === 'red' ? 'playerRedJersey' : 'playerBlueJersey');
    shoulder.isPickable = false;
    return shoulder;
  }

  private buildLeg(playerId: string, side: HandSide, root: TransformNode): Mesh {
    const leg = MeshBuilder.CreateCapsule(
      `remotePlayer_${playerId}_${side}_leg`,
      { height: 0.72, radius: 0.095, tessellation: 12 },
      this.scene
    );
    leg.parent = root;
    leg.material = this.material('playerLeg');
    leg.isPickable = false;
    return leg;
  }

  private buildFoot(playerId: string, side: HandSide, root: TransformNode): Mesh {
    const foot = MeshBuilder.CreateBox(
      `remotePlayer_${playerId}_${side}_shoe`,
      { width: 0.24, height: 0.09, depth: 0.38 },
      this.scene
    );
    foot.parent = root;
    foot.material = this.material('playerShoe');
    foot.isPickable = false;
    return foot;
  }

  private buildArm(playerId: string, side: HandSide, root: TransformNode): ArmVisual {
    const upper = MeshBuilder.CreateCylinder(
      `remotePlayer_${playerId}_${side}_upperArm`,
      { height: 1, diameter: 0.11, tessellation: 10 },
      this.scene
    );
    upper.parent = root;
    upper.material = this.material('playerArm');

    const lower = MeshBuilder.CreateCylinder(
      `remotePlayer_${playerId}_${side}_lowerArm`,
      { height: 1, diameter: 0.095, tessellation: 10 },
      this.scene
    );
    lower.parent = root;
    lower.material = this.material('playerArm');

    const hand = MeshBuilder.CreateSphere(
      `remotePlayer_${playerId}_${side}_hand`,
      { diameter: 0.17, segments: 10 },
      this.scene
    );
    hand.parent = root;
    hand.material = this.material(side === 'left' ? 'leftHand' : 'rightHand');

    return { upper, lower, hand };
  }

  private posePlayerVisual(player: PlayerState, visual: PlayerVisual): void {
    const root = visual.root.position;
    // Reusable render-player view: same as `player` but with the position pinned to the (possibly
    // flip-adjusted) visual root. Mutated in place each frame instead of re-spreading the whole
    // PlayerState tree, which was a per-player-per-frame allocation of several nested objects.
    const renderPlayer = this.renderPlayerScratch;
    const m = this.renderPlayerMovement;
    const pm = player.movement;
    const eliminated = player.combatState === 'eliminated';
    m.yawRadians = pm.yawRadians;
    m.pitchRadians = pm.pitchRadians;
    m.facing = pm.facing;
    m.velocity = pm.velocity;
    m.grounded = pm.grounded;
    m.crouching = eliminated || pm.crouching;
    m.sliding = pm.sliding;
    m.wallRunning = pm.wallRunning;
    m.dashingThisFrame = pm.dashingThisFrame;
    m.speed = pm.speed;
    renderPlayer.hands = player.hands;
    this.renderPlayerPosition.x = root.x;
    this.renderPlayerPosition.y = root.y;
    this.renderPlayerPosition.z = root.z;

    const look = lookVectorsFromAngles(player.movement.yawRadians, player.movement.pitchRadians);
    const forwardV = scratchForward.set(look.forward.x, look.forward.y, look.forward.z);
    const rightV = scratchRight.set(look.right.x, look.right.y, look.right.z);
    const flatForward = flatForwardToRef(forwardV, scratchFlatForward);
    const hitbox = playerHitCapsule(renderPlayer);
    const bodyHeight = eliminated ? Math.min(hitbox.height, TUNING.player.height * 0.56) : hitbox.height;
    const bodyScale = bodyHeight / TUNING.player.height;
    const eyeHeight = playerAimOriginHeight(player.movement);
    const headY = Math.max(0.62, Math.min(bodyHeight - 0.2, eyeHeight - 0.04));
    const legHeight = Math.max(0.36, Math.min(0.72, bodyHeight * 0.42));
    const torsoScaleY = Math.max(0.68, bodyScale);
    const shoulderY = Math.max(0.56, Math.min(bodyHeight - 0.32, eyeHeight - 0.34));
    const hipY = Math.max(0.26, legHeight + 0.06);

    visual.body.position.y = bodyHeight * 0.5;
    visual.body.scaling.set(1, bodyScale, 1);
    visual.hitbox.position.y = bodyHeight * 0.5;
    visual.hitbox.scaling.set(1, bodyScale, 1);
    visual.hitbox.setEnabled(isHitboxDebugEnabled());

    // torso = flatForward*0.02 + (0, max(0.58, h*0.53), 0)
    visual.torso.position.set(flatForward.x * 0.02, flatForward.y * 0.02 + Math.max(0.58, bodyHeight * 0.53), flatForward.z * 0.02);
    visual.torso.scaling.set(1, torsoScaleY, 1);
    orientYaw(visual.torso, flatForward);
    visual.chestStripe.position.set(flatForward.x * 0.235, flatForward.y * 0.235 + Math.max(0.72, bodyHeight * 0.62), flatForward.z * 0.235);
    visual.chestStripe.scaling.set(1, Math.max(0.8, bodyScale), 1);
    orientYaw(visual.chestStripe, flatForward);
    visual.hips.position.set(0, hipY, 0);
    visual.hips.scaling.set(1, Math.max(0.78, bodyScale), 1);
    orientYaw(visual.hips, flatForward);

    this.poseStaticSidePart(visual.leftShoulder, 'left', shoulderY, flatForward, rightV);
    this.poseStaticSidePart(visual.rightShoulder, 'right', shoulderY, flatForward, rightV);
    this.poseLeg(visual.leftLeg, 'left', legHeight, rightV);
    this.poseLeg(visual.rightLeg, 'right', legHeight, rightV);
    this.poseFoot(visual.leftFoot, 'left', flatForward, rightV);
    this.poseFoot(visual.rightFoot, 'right', flatForward, rightV);

    // eye = root + (0, eyeHeight, 0); aimEnd = eye + forward*0.5
    scratchEye.set(root.x, root.y + eyeHeight, root.z);
    scratchAimEnd.set(scratchEye.x + forwardV.x * 0.5, scratchEye.y + forwardV.y * 0.5, scratchEye.z + forwardV.z * 0.5);

    visual.head.position.set(0, headY, 0.015);
    visual.visor.position.set(forwardV.x * 0.225, headY + 0.035 + forwardV.y * 0.225, 0.015 + forwardV.z * 0.225);
    visual.visor.rotationQuaternion ??= new Quaternion();
    Quaternion.FromUnitVectorsToRef(SCRATCH_FWD_Z, forwardV, visual.visor.rotationQuaternion);
    this.poseSegment(visual.facing, scratchEye, scratchAimEnd, root);
    const armAnim = this.remoteArmAnimations.get(player.id);
    this.poseArm(renderPlayer, visual.leftArm, 'left', root, forwardV, rightV, armAnim?.left);
    this.poseArm(renderPlayer, visual.rightArm, 'right', root, forwardV, rightV, armAnim?.right);
  }

  private poseStaticSidePart(mesh: Mesh, side: HandSide, y: number, forward: Vector3, right: Vector3): void {
    const sign = side === 'left' ? -1 : 1;
    // pos = right*sign*0.28 + forward*0.015 + (0, y, 0)
    const p = mesh.position;
    p.set(right.x * sign * 0.28 + forward.x * 0.015, right.y * sign * 0.28 + forward.y * 0.015 + y, right.z * sign * 0.28 + forward.z * 0.015);
    orientYaw(mesh, forward);
  }

  private poseLeg(mesh: Mesh, side: HandSide, height: number, right: Vector3): void {
    const sign = side === 'left' ? -1 : 1;
    const p = mesh.position;
    p.set(right.x * sign * 0.16, right.y * sign * 0.16 + Math.max(0.22, height * 0.52), right.z * sign * 0.16 + 0.035);
    mesh.scaling.y = height / 0.72;
  }

  private poseFoot(mesh: Mesh, side: HandSide, forward: Vector3, right: Vector3): void {
    const sign = side === 'left' ? -1 : 1;
    const p = mesh.position;
    p.set(right.x * sign * 0.16 + forward.x * 0.08, right.y * sign * 0.16 + forward.y * 0.08 + 0.045, right.z * sign * 0.16 + forward.z * 0.08);
    orientYaw(mesh, forward);
  }

  private poseArm(
    player: PlayerState,
    arm: ArmVisual,
    side: HandSide,
    root: Vector3,
    forward: Vector3,
    right: Vector3,
    anim?: ArmAnimTrack
  ): void {
    const sign = side === 'left' ? -1 : 1;
    const handState = player.hands[side];
    const pos = player.movement.position;
    const shoulderHeight = Math.max(0.56, Math.min(playerHitCapsule(player).height - 0.32, playerAimOriginHeight(player.movement) - 0.34));
    // shoulder = pos + (0, shoulderHeight, 0) + right*sign*0.36 + forward*-0.03
    const shoulder = scratchShoulder;
    shoulder.set(
      pos.x + right.x * sign * 0.36 + forward.x * -0.03,
      pos.y + shoulderHeight + right.y * sign * 0.36 + forward.y * -0.03,
      pos.z + right.z * sign * 0.36 + forward.z * -0.03
    );

    const anchor = computePlayerHandAnchor(player, side);
    const hand = scratchHand.set(anchor.x, anchor.y, anchor.z);
    const throwSwing = easeOutCubic(anim?.throwAnim ?? 0);
    const fakeWindup = easeOutCubic(anim?.fakeAnim ?? 0) * 0.8;
    if (throwSwing > 0) {
      hand.set(
        hand.x + forward.x * TUNING.arms.throwReach * throwSwing - right.x * sign * TUNING.arms.throwCenter * throwSwing,
        hand.y + forward.y * TUNING.arms.throwReach * throwSwing - TUNING.arms.throwDrop * throwSwing - right.y * sign * TUNING.arms.throwCenter * throwSwing,
        hand.z + forward.z * TUNING.arms.throwReach * throwSwing - right.z * sign * TUNING.arms.throwCenter * throwSwing
      );
    } else if (handState.mode === 'charging') {
      const charge = Math.min(1, handState.chargeSeconds / TUNING.ball.maxChargeSeconds);
      hand.set(
        hand.x - forward.x * TUNING.arms.windupPull * charge + right.x * sign * TUNING.arms.windupSide * charge,
        hand.y - forward.y * TUNING.arms.windupPull * charge + TUNING.arms.windupLift * charge + right.y * sign * TUNING.arms.windupSide * charge,
        hand.z - forward.z * TUNING.arms.windupPull * charge + right.z * sign * TUNING.arms.windupSide * charge
      );
    } else if (fakeWindup > 0) {
      hand.set(
        hand.x - forward.x * TUNING.arms.windupPull * fakeWindup + right.x * sign * TUNING.arms.windupSide * fakeWindup,
        hand.y - forward.y * TUNING.arms.windupPull * fakeWindup + TUNING.arms.windupLift * fakeWindup + right.y * sign * TUNING.arms.windupSide * fakeWindup,
        hand.z - forward.z * TUNING.arms.windupPull * fakeWindup + right.z * sign * TUNING.arms.windupSide * fakeWindup
      );
    } else if (!handState.heldBallId && handState.mode === 'empty') {
      hand.set(hand.x - forward.x * 0.08, hand.y - 0.12 - forward.y * 0.08, hand.z - forward.z * 0.08);
    }

    // elbow = lerp(shoulder, hand, 0.52) + (0, -0.04, 0) + right*sign*0.05
    const elbow = scratchElbow;
    const elbowLift = (handState.mode === 'charging' ? Math.min(1, handState.chargeSeconds / TUNING.ball.maxChargeSeconds) : fakeWindup) * 0.18;
    const elbowDrop = throwSwing * 0.1;
    elbow.set(
      shoulder.x + (hand.x - shoulder.x) * 0.52 + right.x * sign * (0.05 + elbowLift),
      shoulder.y + (hand.y - shoulder.y) * 0.52 - 0.04 + elbowLift - elbowDrop + right.y * sign * (0.05 + elbowLift),
      shoulder.z + (hand.z - shoulder.z) * 0.52 + right.z * sign * (0.05 + elbowLift)
    );

    this.poseSegment(arm.upper, shoulder, elbow, root);
    this.poseSegment(arm.lower, elbow, hand, root);
    arm.hand.position.set(hand.x - root.x, hand.y - root.y, hand.z - root.z);
    arm.hand.material = this.material(side === 'left' ? 'leftHand' : 'rightHand');
  }

  private poseSegment(mesh: Mesh, start: Vector3, end: Vector3, root: Vector3): void {
    // delta = end - start (scratchA), reused as the normalized direction.
    end.subtractToRef(start, scratchA);
    const length = Math.max(0.001, scratchA.length());
    scratchA.scaleInPlace(1 / length); // now the unit direction
    // position = midpoint(start, end) - root.
    start.addToRef(end, scratchB);
    scratchB.scaleInPlace(0.5);
    scratchB.subtractToRef(root, mesh.position);
    mesh.scaling.y = length;
    mesh.rotationQuaternion ??= new Quaternion();
    Quaternion.FromUnitVectorsToRef(SCRATCH_UP, scratchA, mesh.rotationQuaternion);
  }

  private ensureBall(ball: BallState): BallVisual {
    const existing = this.balls.get(ball.id);
    if (existing) return existing;

    const mesh = createBallMesh(this.scene, `networkBall_${ball.id}`, toVector3(ball.position), ballVariantForState(ball));
    if (isNetworkRenderDebugEnabled()) {
      console.log(`[net/ball] created id=${ball.id} phase=${ball.phase} variant=${ballVariantForState(ball)}`);
    }
    const visual = { mesh, trailTimer: 0, impactPulse: 0, lastBounceCount: ball.bounceCount };
    this.balls.set(ball.id, visual);
    return visual;
  }

  private updateBallEffects(visual: BallVisual, ball: BallState, dt: number): void {
    if (this.ballVisualEffects && ball.isSuper && (ball.phase === 'live' || ball.phase === 'deflected') && !ball.heldByPlayerId) {
      const speedSq =
        ball.velocity.x * ball.velocity.x +
        ball.velocity.y * ball.velocity.y +
        ball.velocity.z * ball.velocity.z;
      if (speedSq >= BALL_QTE_TRAIL_SPEED_THRESHOLD * BALL_QTE_TRAIL_SPEED_THRESHOLD) {
        visual.trailTimer -= dt;
        if (visual.trailTimer <= 0) {
          this.ballVisualEffects.spawnTrail(visual.mesh.position, ball.velocity);
          visual.trailTimer = BALL_TRAIL_INTERVAL_SECONDS;
        }
      } else {
        visual.trailTimer = 0;
      }
    } else {
      visual.trailTimer = 0;
    }

    if (visual.impactPulse > 0) {
      const amount = visual.impactPulse;
      visual.mesh.scaling.set(1 + amount * BALL_SQUASH_XZ_SCALE, 1 - amount * BALL_SQUASH_Y_SCALE, 1 + amount * BALL_SQUASH_XZ_SCALE);
      visual.impactPulse = Math.max(0, visual.impactPulse - dt * 8.5);
    } else if (visual.mesh.scaling.x !== 1 || visual.mesh.scaling.y !== 1 || visual.mesh.scaling.z !== 1) {
      visual.mesh.scaling.setAll(1);
    }

    updateBallBlobShadow(visual.mesh);
  }

  private material(key: string): PBRMaterial {
    const existing = this.materials.get(key);
    if (existing) return existing;

    const material = new PBRMaterial(`${key}_material`, this.scene);
    const color = materialColor(key);
    material.albedoColor = color.diffuse;
    material.emissiveColor = color.emissive;
    material.metallic = color.metallic;
    material.roughness = color.roughness;
    material.alpha = color.alpha ?? 1;
    this.materials.set(key, material);
    return material;
  }

  private recordCorrection(reason: string): void {
    if (reason.startsWith('remote')) {
      this.metricRemoteSnaps += 1;
    } else {
      this.metricBallSnaps += 1;
    }
    this.debugStats.lastCorrectionReason = reason;
  }
}

/** Scratch movement whose `position` aliases the supplied ref; other fields are overwritten/aliased
 * each frame in posePlayerVisual. Only the fields the renderer's pose math reads are meaningful. */
function createScratchMovement(positionRef: Vec3): PlayerState['movement'] {
  return {
    position: positionRef,
    velocity: { x: 0, y: 0, z: 0 },
    yawRadians: 0,
    pitchRadians: 0,
    facing: { x: 0, y: 0, z: 1 },
    grounded: true,
    crouching: false,
    sliding: false,
    wallRunning: false,
    dashingThisFrame: false,
    speed: 0
  };
}

/** Scratch player wrapping the scratch movement; `hands` is aliased to the live player each frame. */
function createScratchPlayer(movement: PlayerState['movement']): PlayerState {
  return {
    id: '',
    name: '',
    teamId: '',
    spawnSide: 'negativeZ',
    teamSlotIndex: 0,
    legalHalf: 'negativeZ',
    movement,
    movementInternal: {
      slideTimer: 0,
      jumpGraceTimer: 0,
      wallRunTimer: 0,
      wallReattachCooldown: 0,
      dashActiveTimer: 0,
      doubleJumpAvailable: true,
      catchBoostTimer: 0,
      groundHeight: 0,
      lastWallNormalX: 0,
      lastWallNormalZ: 0,
      backflipActive: false,
      backflipTimer: 0,
      backflipCooldown: 0
    },
    hands: {
      left: { side: 'left', heldBallId: null, mode: 'empty', chargeSeconds: 0, cooldownSeconds: 0, catchTrackingSecondsByBallId: {}, lastCatchAttemptId: 0 },
      right: { side: 'right', heldBallId: null, mode: 'empty', chargeSeconds: 0, cooldownSeconds: 0, catchTrackingSecondsByBallId: {}, lastCatchAttemptId: 0 }
    },
    dash: { charges: 0, rechargeTimerSeconds: 0, cooldownSeconds: 0 },
    score: 0,
    lives: TUNING.match.playerLives,
    combatState: 'alive',
    eliminatedAtMs: null,
    lastPlayerBuffUntilMs: null,
    connected: true,
    reconnectDeadlineAtMs: null,
    lastProcessedInputSeq: 0
  };
}

function emptyDebugStats(): NetworkRendererDebugStats {
  return {
    remoteInterpolationBufferSize: 0,
    ballInterpolationBufferSize: 0,
    renderDelayMs: INTERPOLATION_DELAY_MS,
    latestSnapshotAgeMs: 0,
    oldestSnapshotAgeMs: 0,
    bufferUnderrunsPerSec: 0,
    bufferOverrunsPerSec: 0,
    avgSnapshotIntervalMs: 0,
    maxSnapshotIntervalMs: 0,
    remoteSnapCount: 0,
    ballSnapCount: 0,
    lastCorrectionReason: '',
    ballPredictionCount: 0,
    ballPredictionCorrections: 0,
    ballPredictionMaxCorrections: 0,
    ballPredictionMaxErrorM: 0,
    ballPredictionLastErrorM: 0,
    ballPredictionSnapCount: 0,
    ballPredictionSoftCorrections: 0,
    ballPredictionMediumCorrections: 0,
    ballPredictionSnapReasonCounts: {}
  };
}

function toVector3(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

// --- Per-frame scratch vectors (module-level, reused) -------------------------------------------
// The pose math below runs every frame for every remote player and used to allocate dozens of
// Vector3/Quaternion objects per player per frame (each .add()/.scale()/.subtract()/clone()/Lerp
// returns a NEW Vector3). That allocation churn is a primary GC pressure source. These scratch
// instances let the hot pose path do all its vector math in place with the Babylon *ToRef APIs.
// They are NOT reentrant — only ever touched synchronously from the single render-loop update.
const SCRATCH_UP = new Vector3(0, 1, 0);
const SCRATCH_FWD_Z = new Vector3(0, 0, 1);
const scratchForward = new Vector3();
const scratchRight = new Vector3();
const scratchFlatForward = new Vector3();
const scratchA = new Vector3();
const scratchB = new Vector3();
const scratchShoulder = new Vector3();
const scratchHand = new Vector3();
const scratchElbow = new Vector3();
const scratchEye = new Vector3();
const scratchAimEnd = new Vector3();
// Held-ball target is a plain Vec3 (never a Babylon Vector3) so the math stays alloc-free.
const scratchBallTarget: Vec3 = { x: 0, y: 0, z: 0 };

function createArmAnimTrack(): ArmAnimTrack {
  return {
    throwAnim: 0,
    fakeAnim: 0,
    previousMode: 'empty',
    previousHeldBallId: null
  };
}

function easeOutCubic(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return 1 - (1 - x) * (1 - x) * (1 - x);
}

/**
 * Keep a held-ball anchor in front of the local eye. Projects the anchor onto the camera look
 * direction; if its forward component is below MIN_FORWARD it is pushed out to MIN_FORWARD (the
 * lateral/vertical offset is preserved). This guarantees the local player's own held ball stays
 * visible — it can never sit beside or behind the near clip plane — without affecting throw
 * direction/origin (computed separately from the camera) or any remote/authoritative state.
 */
function keepInFrontOfEyeToRef(anchor: Vec3, movement: PlayerState['movement'], out: Vec3): void {
  const MIN_FORWARD = 0.45; // meters in front of the eye
  const eyeHeight = playerAimOriginHeight(movement);
  const eyeX = movement.position.x;
  const eyeY = movement.position.y + eyeHeight;
  const eyeZ = movement.position.z;
  const f = lookVectorsFromAngles(movement.yawRadians, movement.pitchRadians).forward;
  const relX = anchor.x - eyeX;
  const relY = anchor.y - eyeY;
  const relZ = anchor.z - eyeZ;
  const along = relX * f.x + relY * f.y + relZ * f.z;
  if (along >= MIN_FORWARD) {
    out.x = anchor.x;
    out.y = anchor.y;
    out.z = anchor.z;
    return;
  }
  // Shift the anchor forward along the look direction by the shortfall, preserving its offset.
  const shift = MIN_FORWARD - along;
  out.x = anchor.x + f.x * shift;
  out.y = anchor.y + f.y * shift;
  out.z = anchor.z + f.z * shift;
}

/** Flatten `forward` onto the XZ plane and normalize, writing into `out` (no allocation). */
function flatForwardToRef(forward: Vector3, out: Vector3): Vector3 {
  out.set(forward.x, 0, forward.z);
  if (out.lengthSquared() > 0.0001) out.normalize();
  else out.set(0, 0, 1);
  return out;
}

function orientYaw(mesh: Mesh, forward: Vector3): void {
  mesh.rotationQuaternion ??= new Quaternion();
  Quaternion.FromUnitVectorsToRef(SCRATCH_FWD_Z, forward, mesh.rotationQuaternion);
}

function clonePlayerState(player: PlayerState): PlayerState {
  return {
    ...player,
    movement: {
      ...player.movement,
      position: { ...player.movement.position },
      velocity: { ...player.movement.velocity },
      facing: { ...player.movement.facing }
    },
    movementInternal: { ...player.movementInternal },
    dash: { ...player.dash },
    hands: {
      left: {
        ...player.hands.left,
        catchTrackingSecondsByBallId: { ...player.hands.left.catchTrackingSecondsByBallId }
      },
      right: {
        ...player.hands.right,
        catchTrackingSecondsByBallId: { ...player.hands.right.catchTrackingSecondsByBallId }
      }
    }
  };
}

function cloneBallState(ball: BallState): BallState {
  return {
    ...ball,
    position: { ...ball.position },
    velocity: { ...ball.velocity },
    curveAccel: { ...ball.curveAccel }
  };
}

function findPickupLookBallId(balls: BallState[], movement: PlayerState['movement']): string | null {
  const look = lookVectorsFromAngles(movement.yawRadians, movement.pitchRadians).forward;
  const originX = movement.position.x;
  const originY = movement.position.y + playerAimOriginHeight(movement);
  const originZ = movement.position.z;
  const maxDistance = TUNING.ball.pickupRadius + 0.65;
  const maxDistanceSq = maxDistance * maxDistance;
  let bestId: string | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const ball of balls) {
    if (!isBallPickupStateEligible(ball)) continue;
    const dx = ball.position.x - originX;
    const dy = ball.position.y - originY;
    const dz = ball.position.z - originZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq <= 0.0001 || distSq > maxDistanceSq) continue;

    const dot = (dx * look.x + dy * look.y + dz * look.z) / Math.sqrt(distSq);
    if (dot < 0.78) continue;
    const score = dot * 2 - distSq * 0.04;
    if (score > bestScore) {
      bestId = ball.id;
      bestScore = score;
    }
  }

  return bestId;
}

function interpolateSnapshots(before: BufferedSnapshot, after: BufferedSnapshot, t: number, targetTimeMs: number): BufferedSnapshot {
  // The arrays are tiny (≤2 players, ≤6 balls), so a linear find by id is cheaper per frame than
  // building two Maps (plus their intermediate [id, value] arrays) on every render frame.
  return {
    tick: after.tick,
    resetSerial: after.resetSerial,
    receivedAtMs: targetTimeMs,
    serverTimeMs: lerpNumber(before.serverTimeMs, after.serverTimeMs, t),
    players: after.players.map((player) => {
      const previous = findById(before.players, player.id);
      return previous ? interpolatePlayerState(previous, player, t) : clonePlayerState(player);
    }),
    balls: after.balls.map((ball) => {
      const previous = findById(before.balls, ball.id);
      return previous ? interpolateBallState(previous, ball, t) : cloneBallState(ball);
    })
  };
}

function findById<T extends { id: string }>(items: T[], id: string): T | undefined {
  for (let i = 0; i < items.length; i += 1) {
    if (items[i].id === id) return items[i];
  }
  return undefined;
}

function extrapolateSnapshot(snapshot: BufferedSnapshot, deltaMs: number): BufferedSnapshot {
  // Clamp extrapolation to the configured limit so a buffer underrun never lets entities run away.
  const clampedMs = Math.min(NetworkRenderer.BALL_EXTRAPOLATION_MAX_MS, Math.max(0, deltaMs));
  const dt = clampedMs / 1000;
  return {
    tick: snapshot.tick,
    resetSerial: snapshot.resetSerial,
    receivedAtMs: snapshot.receivedAtMs + deltaMs,
    serverTimeMs: snapshot.serverTimeMs + clampedMs,
    players: snapshot.players.map((player) => {
      // Briefly extrapolate remote players along velocity so a missed packet doesn't freeze them.
      const clone = clonePlayerState(player);
      if (dt > 0) {
        clone.movement.position = addVec3(player.movement.position, scaleVec3(player.movement.velocity, dt));
      }
      return clone;
    }),
    balls: snapshot.balls.map((ball) => {
      const clone = cloneBallState(ball);
      if (dt > 0 && (ball.phase === 'live' || ball.phase === 'deflected') && !ball.heldByPlayerId) {
        clone.position = addVec3(ball.position, scaleVec3(ball.velocity, dt));
      }
      return clone;
    })
  };
}

function interpolatePlayerState(before: PlayerState, after: PlayerState, t: number): PlayerState {
  if (distanceVec3(before.movement.position, after.movement.position) > NetworkRenderer.HUGE_ERROR_SNAP_METERS) {
    return clonePlayerState(after);
  }

  const clone = clonePlayerState(after);
  clone.movement = {
    ...clone.movement,
    position: lerpVec3(before.movement.position, after.movement.position, t),
    velocity: lerpVec3(before.movement.velocity, after.movement.velocity, t),
    yawRadians: lerpAngleRadians(before.movement.yawRadians, after.movement.yawRadians, t),
    pitchRadians: lerpNumber(before.movement.pitchRadians, after.movement.pitchRadians, t),
    facing: lerpVec3(before.movement.facing, after.movement.facing, t),
    speed: lerpNumber(before.movement.speed, after.movement.speed, t)
  };
  return clone;
}

function interpolateBallState(before: BallState, after: BallState, t: number): BallState {
  if (!sameBallContinuityState(before, after)) {
    return cloneBallState(after);
  }
  if (distanceVec3(before.position, after.position) > NetworkRenderer.HUGE_ERROR_SNAP_METERS) {
    return cloneBallState(after);
  }

  const clone = cloneBallState(after);
  clone.position = lerpVec3(before.position, after.position, t);
  clone.velocity = lerpVec3(before.velocity, after.velocity, t);
  clone.curveAccel = lerpVec3(before.curveAccel, after.curveAccel, t);
  return clone;
}

function ballContinuity(ball: BallState): BallRenderContinuity {
  return {
    phase: ball.phase,
    ownerKind: ball.ownerKind,
    ownerId: ball.ownerId,
    heldByPlayerId: ball.heldByPlayerId,
    heldHand: ball.heldHand
  };
}

/** True when the stored continuity record still matches the ball — no allocation (vs building a
 * fresh BallRenderContinuity each frame just to compare). */
function continuityMatchesBall(c: BallRenderContinuity, ball: BallState): boolean {
  return (
    c.phase === ball.phase &&
    c.ownerKind === ball.ownerKind &&
    c.ownerId === ball.ownerId &&
    c.heldByPlayerId === ball.heldByPlayerId &&
    c.heldHand === ball.heldHand
  );
}

function copyBallContinuity(c: BallRenderContinuity, ball: BallState): void {
  c.phase = ball.phase;
  c.ownerKind = ball.ownerKind;
  c.ownerId = ball.ownerId;
  c.heldByPlayerId = ball.heldByPlayerId;
  c.heldHand = ball.heldHand;
}

/** Compare two balls' continuity directly without allocating two BallRenderContinuity records. */
function sameBallContinuityState(a: BallState, b: BallState): boolean {
  return (
    a.phase === b.phase &&
    a.ownerKind === b.ownerKind &&
    a.ownerId === b.ownerId &&
    a.heldByPlayerId === b.heldByPlayerId &&
    a.heldHand === b.heldHand
  );
}

function lerpVec3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, t: number): { x: number; y: number; z: number } {
  return {
    x: lerpNumber(a.x, b.x, t),
    y: lerpNumber(a.y, b.y, t),
    z: lerpNumber(a.z, b.z, t)
  };
}

function addVec3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scaleVec3(v: { x: number; y: number; z: number }, scale: number): { x: number; y: number; z: number } {
  return { x: v.x * scale, y: v.y * scale, z: v.z * scale };
}

function distanceVec3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpAngleRadians(a: number, b: number, t: number): number {
  const delta = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + delta * t;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function materialColor(key: string): { diffuse: Color3; emissive: Color3; metallic: number; roughness: number; alpha?: number } {
  switch (key) {
    case 'playerRed':
      return { diffuse: new Color3(0.95, 0.18, 0.14), emissive: new Color3(0.025, 0, 0), metallic: 0, roughness: 0.4 };
    case 'playerRedSuit':
      return { diffuse: new Color3(0.62, 0.08, 0.07), emissive: new Color3(0.018, 0, 0), metallic: 0.02, roughness: 0.46 };
    case 'playerRedJersey':
      return { diffuse: new Color3(0.94, 0.14, 0.12), emissive: new Color3(0.028, 0, 0), metallic: 0.02, roughness: 0.38 };
    case 'playerBlue':
      return { diffuse: new Color3(0.15, 0.42, 0.95), emissive: new Color3(0, 0.01, 0.035), metallic: 0, roughness: 0.4 };
    case 'playerBlueSuit':
      return { diffuse: new Color3(0.07, 0.2, 0.5), emissive: new Color3(0, 0.008, 0.024), metallic: 0.02, roughness: 0.46 };
    case 'playerBlueJersey':
      return { diffuse: new Color3(0.1, 0.38, 0.92), emissive: new Color3(0, 0.012, 0.036), metallic: 0.02, roughness: 0.38 };
    case 'playerHead':
      return { diffuse: new Color3(0.82, 0.58, 0.46), emissive: new Color3(0.025, 0.012, 0.008), metallic: 0, roughness: 0.46 };
    case 'playerArm':
      return { diffuse: new Color3(0.78, 0.52, 0.4), emissive: new Color3(0.018, 0.008, 0.006), metallic: 0, roughness: 0.5 };
    case 'playerLeg':
      return { diffuse: new Color3(0.18, 0.19, 0.22), emissive: new Color3(0.004, 0.004, 0.006), metallic: 0, roughness: 0.5 };
    case 'playerShorts':
      return { diffuse: new Color3(0.07, 0.08, 0.1), emissive: new Color3(0.002, 0.002, 0.003), metallic: 0, roughness: 0.52 };
    case 'playerShoe':
      return { diffuse: new Color3(0.96, 0.94, 0.86), emissive: new Color3(0.018, 0.016, 0.012), metallic: 0, roughness: 0.44 };
    case 'playerUniformTrim':
      return { diffuse: new Color3(1, 0.96, 0.82), emissive: new Color3(0.035, 0.028, 0.01), metallic: 0.02, roughness: 0.34 };
    case 'playerVisor':
      return { diffuse: new Color3(0.04, 0.08, 0.1), emissive: new Color3(0.0, 0.045, 0.055), metallic: 0.08, roughness: 0.28 };
    case 'leftHand':
      return { diffuse: new Color3(0.95, 0.82, 0.32), emissive: new Color3(0.04, 0.025, 0.004), metallic: 0, roughness: 0.42 };
    case 'rightHand':
      return { diffuse: new Color3(0.5, 0.9, 0.78), emissive: new Color3(0.006, 0.035, 0.025), metallic: 0, roughness: 0.42 };
    case 'playerFacing':
      return { diffuse: new Color3(1, 0.95, 0.78), emissive: new Color3(0.04, 0.03, 0.008), metallic: 0.05, roughness: 0.32 };
    case 'playerHitbox':
      return { diffuse: new Color3(0.75, 1, 0.72), emissive: new Color3(0.02, 0.08, 0.02), metallic: 0, roughness: 0.2, alpha: 0.22 };
    default:
      return { diffuse: new Color3(0.86, 0.86, 0.82), emissive: new Color3(0.01, 0.01, 0.008), metallic: 0, roughness: 0.48 };
  }
}

function isNetworkRenderDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.networkRenderer') === '1';
  } catch {
    return false;
  }
}

function isHitboxDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.hitboxes') === '1';
  } catch {
    return false;
  }
}

/** Ball-prediction debug gate (Phase 13). Enable with localStorage strafeball.debug.ballPredict=1. */
function isBallPredictDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.ballPredict') === '1';
  } catch {
    return false;
  }
}
