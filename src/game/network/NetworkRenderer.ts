import { Color3, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import type { ServerSnapshot } from '../../../shared/protocol';
import type { BallState, HandSide, PlayerState } from '../../../shared/types';
import { TUNING } from '../config/tuning';
import { computePlayerHandAnchor } from '../../../shared/simulation/HandAnchors';
import { backflipPitchOffset, lookVectorsFromAngles } from '../../../shared/simulation/AimMath';
import { playerAimOriginHeight, playerHitCapsule } from '../../../shared/simulation/PlayerHitbox';
import { ballVariantForState, createBallMesh, getBallMaterial } from '../ball/BallVisualFactory';
import {
  EXTRAPOLATION_LIMIT_MS,
  HUGE_ERROR_SNAP_METERS,
  INTERPOLATION_DELAY_MS,
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

interface BallVisual {
  mesh: Mesh;
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
  // New metrics, sampled over a rolling ~1s window.
  bufferUnderrunsPerSec: number;
  bufferOverrunsPerSec: number;
  avgSnapshotIntervalMs: number;
  maxSnapshotIntervalMs: number;
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
  private debugStats: NetworkRendererDebugStats = emptyDebugStats();

  constructor(private readonly scene: Scene) {}

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
    this.updateBalls(renderSnapshot.balls, renderSnapshot.players, localPlayerId, localPredicted ?? null);
  }

  getDebugStats(): NetworkRendererDebugStats {
    // Keep the live buffer size / age fields fresh; rate-style metrics come from the rolling window.
    this.debugStats.remoteInterpolationBufferSize = this.snapshotBuffer.length;
    this.debugStats.ballInterpolationBufferSize = this.snapshotBuffer.length;
    this.debugStats.renderDelayMs = NetworkRenderer.INTERPOLATION_DELAY_MS;
    this.debugStats.latestSnapshotAgeMs =
      this.latestSnapshotReceivedAtMs > 0 ? Date.now() - this.latestSnapshotReceivedAtMs : 0;
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
    this.balls.clear();
    this.seenPlayers.clear();
    this.seenBalls.clear();
    this.snapshotBuffer.length = 0;
    this.ballRenderContinuity.clear();
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
  }

  private bufferSnapshot(snapshot: ServerSnapshot): void {
    const resetSerial = snapshot.room.resetVote.resetSerial;
    if (resetSerial !== this.lastBufferedResetSerial) {
      if (this.lastBufferedResetSerial !== -1 && isNetworkRenderDebugEnabled()) {
        console.log(`[net/render-buffer] reset serial ${this.lastBufferedResetSerial} -> ${resetSerial}; clearing interpolation buffer`);
      }
      // resetSerial change: clear buffer + continuity, and resync the render clock so the cursor
      // re-locks to the fresh timeline instead of dragging the old one through the discontinuity.
      this.snapshotBuffer.length = 0;
      this.ballRenderContinuity.clear();
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
      return this.serverTimeBaseMs + (snapshot.tick - this.serverTimeBaseTick) * SNAPSHOT_INTERVAL_MS;
    };

    if (!Number.isFinite(reported) || reported <= 0) return reconstructed();

    // Sanity-check the reported clock against the tick-derived expectation. A wildly inconsistent
    // serverTimeMs (clock reset, synthetic snapshot) falls back to the reconstructed timeline.
    if (this.serverTimeBaseInitialized) {
      const expected = this.serverTimeBaseMs + (snapshot.tick - this.serverTimeBaseTick) * SNAPSHOT_INTERVAL_MS;
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
    const target = newest.serverTimeMs - NetworkRenderer.INTERPOLATION_DELAY_MS;

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

    this.metricWindowStartMs = now;
    this.metricUnderruns = 0;
    this.metricOverruns = 0;
    this.metricIntervalTotalMs = 0;
    this.metricIntervalCount = 0;
    this.metricIntervalMaxMs = 0;
  }

  private updatePlayers(players: PlayerState[], localPlayerId: string, dt: number): void {
    const seen = this.seenPlayers;
    seen.clear();

    for (const player of players) {
      if (player.id === localPlayerId) continue;
      seen.add(player.id);
      const visual = this.ensurePlayer(player);
      const target = toVector3(player.movement.position);
      const error = Vector3.Distance(visual.root.position, target);
      if (error > NetworkRenderer.HUGE_ERROR_SNAP_METERS && isNetworkRenderDebugEnabled()) {
        console.log(`[remote/${player.id.slice(-4)}] snap largeError=${error.toFixed(2)}m`);
      }
      visual.root.position.copyFrom(target);
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
    }
  }

  private updateBalls(
    balls: BallState[],
    players: PlayerState[],
    localPlayerId: string,
    localPredicted: PlayerState['movement'] | null
  ): void {
    const seen = this.seenBalls;
    seen.clear();

    for (const ball of balls) {
      seen.add(ball.id);
      const visual = this.ensureBall(ball);

      // Held balls: attach to the holder's hand anchor. For a REMOTE holder, use the interpolated
      // holder state so the ball rides the smooth avatar. For the LOCAL holder, use the present-time
      // PREDICTED movement (when supplied) so the ball stays glued to the player's hand instead of
      // dragging ~INTERPOLATION_DELAY_MS behind while strafing. The held<->live transition is a
      // continuity change, so it snaps rather than lerping.
      let target = toVector3(ball.position);
      if (ball.heldByPlayerId && ball.heldHand) {
        const holder = findById(players, ball.heldByPlayerId);
        if (ball.heldByPlayerId === localPlayerId && localPredicted && holder) {
          const predictedHolder: PlayerState = { ...holder, movement: localPredicted };
          target = toVector3(computePlayerHandAnchor(predictedHolder, ball.heldHand));
        } else if (holder) {
          target = toVector3(computePlayerHandAnchor(holder, ball.heldHand));
        }
      }

      const error = Vector3.Distance(visual.mesh.position, target);
      const continuity = ballContinuity(ball);
      const previous = this.ballRenderContinuity.get(ball.id);
      const changed = previous !== undefined && !sameBallContinuity(previous, continuity);
      if ((changed || error > NetworkRenderer.HUGE_ERROR_SNAP_METERS) && isNetworkRenderDebugEnabled()) {
        console.log(
          `[net/ball] snap id=${ball.id} phase=${ball.phase} changed=${Number(changed)} error=${error.toFixed(2)}m`
        );
      }
      visual.mesh.position.copyFrom(target);
      visual.mesh.material = getBallMaterial(this.scene, ballVariantForState(ball));
      visual.mesh.setEnabled(true);
      this.ballRenderContinuity.set(ball.id, continuity);
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
    const renderPlayer: PlayerState = {
      ...player,
      movement: {
        ...player.movement,
        position: { x: root.x, y: root.y, z: root.z }
      }
    };
    const base = root.clone();
    const { forward, right } = lookVectorsFromAngles(player.movement.yawRadians, player.movement.pitchRadians);
    const forwardV = toVector3(forward);
    const rightV = toVector3(right);
    const flatForward = flatForwardFrom(forwardV);
    const hitbox = playerHitCapsule(renderPlayer);
    const bodyHeight = hitbox.height;
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

    visual.torso.position.copyFrom(flatForward.scale(0.02).add(new Vector3(0, Math.max(0.58, bodyHeight * 0.53), 0)));
    visual.torso.scaling.set(1, torsoScaleY, 1);
    orientYaw(visual.torso, flatForward);
    visual.chestStripe.position.copyFrom(flatForward.scale(0.235).add(new Vector3(0, Math.max(0.72, bodyHeight * 0.62), 0)));
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

    const eye = base.add(new Vector3(0, eyeHeight, 0));
    const aimEnd = eye.add(forwardV.scale(0.5));

    visual.head.position.set(0, headY, 0.015);
    visual.visor.position.copyFrom(
      new Vector3(0, headY + 0.035, 0.015)
        .add(forwardV.scale(0.225))
    );
    visual.visor.rotationQuaternion = visual.visor.rotationQuaternion ?? new Quaternion();
    Quaternion.FromUnitVectorsToRef(new Vector3(0, 0, 1), forwardV.normalizeToNew(), visual.visor.rotationQuaternion);
    this.poseSegment(visual.facing, eye, aimEnd, root);
    this.poseArm(renderPlayer, visual.leftArm, 'left', root, forwardV, rightV);
    this.poseArm(renderPlayer, visual.rightArm, 'right', root, forwardV, rightV);
  }

  private poseStaticSidePart(mesh: Mesh, side: HandSide, y: number, forward: Vector3, right: Vector3): void {
    const sign = side === 'left' ? -1 : 1;
    mesh.position.copyFrom(right.scale(sign * 0.28).add(forward.scale(0.015)).add(new Vector3(0, y, 0)));
    orientYaw(mesh, forward);
  }

  private poseLeg(mesh: Mesh, side: HandSide, height: number, right: Vector3): void {
    const sign = side === 'left' ? -1 : 1;
    mesh.position.copyFrom(right.scale(sign * 0.16).add(new Vector3(0, Math.max(0.22, height * 0.52), 0.035)));
    mesh.scaling.y = height / 0.72;
  }

  private poseFoot(mesh: Mesh, side: HandSide, forward: Vector3, right: Vector3): void {
    const sign = side === 'left' ? -1 : 1;
    mesh.position.copyFrom(right.scale(sign * 0.16).add(forward.scale(0.08)).add(new Vector3(0, 0.045, 0)));
    orientYaw(mesh, forward);
  }

  private poseArm(
    player: PlayerState,
    arm: ArmVisual,
    side: HandSide,
    root: Vector3,
    forward: Vector3,
    right: Vector3
  ): void {
    const sign = side === 'left' ? -1 : 1;
    const handState = player.hands[side];
    const base = toVector3(player.movement.position);
    const shoulderHeight = Math.max(0.56, Math.min(playerHitCapsule(player).height - 0.32, playerAimOriginHeight(player.movement) - 0.34));
    const shoulder = base
      .add(new Vector3(0, shoulderHeight, 0))
      .add(right.scale(sign * 0.36))
      .add(forward.scale(-0.03));
    let hand = toVector3(computePlayerHandAnchor(player, side));

    if (handState.mode === 'charging') {
      const charge = Math.min(1, handState.chargeSeconds / TUNING.ball.maxChargeSeconds);
      hand = hand.subtract(forward.scale(0.18 * charge)).add(new Vector3(0, 0.08 * charge, 0));
    } else if (!handState.heldBallId && handState.mode === 'empty') {
      hand = hand.subtract(new Vector3(0, 0.12, 0)).subtract(forward.scale(0.08));
    }

    const elbow = Vector3.Lerp(shoulder, hand, 0.52)
      .add(new Vector3(0, -0.04, 0))
      .add(right.scale(sign * 0.05));

    this.poseSegment(arm.upper, shoulder, elbow, root);
    this.poseSegment(arm.lower, elbow, hand, root);
    arm.hand.position.copyFrom(hand.subtract(root));
    arm.hand.material = this.material(side === 'left' ? 'leftHand' : 'rightHand');
  }

  private poseSegment(mesh: Mesh, start: Vector3, end: Vector3, root: Vector3): void {
    const delta = end.subtract(start);
    const length = Math.max(0.001, delta.length());
    const direction = delta.scale(1 / length);
    mesh.position.copyFrom(start.add(end).scale(0.5).subtract(root));
    mesh.scaling.y = length;
    mesh.rotationQuaternion = mesh.rotationQuaternion ?? new Quaternion();
    Quaternion.FromUnitVectorsToRef(new Vector3(0, 1, 0), direction, mesh.rotationQuaternion);
  }

  private ensureBall(ball: BallState): BallVisual {
    const existing = this.balls.get(ball.id);
    if (existing) return existing;

    const mesh = createBallMesh(this.scene, `networkBall_${ball.id}`, toVector3(ball.position), ballVariantForState(ball));
    if (isNetworkRenderDebugEnabled()) {
      console.log(`[net/ball] created id=${ball.id} phase=${ball.phase} variant=${ballVariantForState(ball)}`);
    }
    const visual = { mesh };
    this.balls.set(ball.id, visual);
    return visual;
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
}

function emptyDebugStats(): NetworkRendererDebugStats {
  return {
    remoteInterpolationBufferSize: 0,
    ballInterpolationBufferSize: 0,
    renderDelayMs: INTERPOLATION_DELAY_MS,
    latestSnapshotAgeMs: 0,
    bufferUnderrunsPerSec: 0,
    bufferOverrunsPerSec: 0,
    avgSnapshotIntervalMs: 0,
    maxSnapshotIntervalMs: 0
  };
}

function toVector3(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

function flatForwardFrom(forward: Vector3): Vector3 {
  const flat = new Vector3(forward.x, 0, forward.z);
  return flat.lengthSquared() > 0.0001 ? flat.normalize() : new Vector3(0, 0, 1);
}

function orientYaw(mesh: Mesh, forward: Vector3): void {
  mesh.rotationQuaternion = mesh.rotationQuaternion ?? new Quaternion();
  Quaternion.FromUnitVectorsToRef(new Vector3(0, 0, 1), forward, mesh.rotationQuaternion);
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
  if (!sameBallContinuity(ballContinuity(before), ballContinuity(after))) {
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

function sameBallContinuity(a: BallRenderContinuity, b: BallRenderContinuity): boolean {
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
