import { Color3, Mesh, MeshBuilder, PBRMaterial, Quaternion, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import type { ServerSnapshot } from '../../../shared/protocol';
import type { BallState, HandSide, PlayerState } from '../../../shared/types';
import { TUNING } from '../config/tuning';
import { computePlayerHandAnchor } from '../../../shared/simulation/HandAnchors';
import { lookVectorsFromAngles } from '../../../shared/simulation/AimMath';
import { ballVariantForState, createBallMesh, getBallMaterial } from '../ball/BallVisualFactory';

interface PlayerVisual {
  root: TransformNode;
  body: Mesh;
  head: Mesh;
  facing: Mesh;
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
  receivedAtMs: number;
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
  remoteInterpolationBufferSize: number;
  ballInterpolationBufferSize: number;
  renderDelayMs: number;
  latestSnapshotAgeMs: number;
}

export class NetworkRenderer {
  private static readonly INTERPOLATION_DELAY_MS = 100;
  static readonly BALL_EXTRAPOLATION_MAX_MS = 100;
  private static readonly MAX_BUFFER_MS = 1000;
  static readonly HUGE_ERROR_SNAP_METERS = 5;

  private readonly players = new Map<string, PlayerVisual>();
  private readonly playerDebug = new Map<string, RemotePlayerDebug>();
  private readonly balls = new Map<string, BallVisual>();
  private readonly materials = new Map<string, PBRMaterial>();
  private readonly snapshotBuffer: BufferedSnapshot[] = [];
  private readonly ballRenderContinuity = new Map<string, BallRenderContinuity>();
  private lastBufferedTick = -1;
  private lastBufferedResetSerial = -1;
  private latestSnapshotReceivedAtMs = 0;

  constructor(private readonly scene: Scene) {}

  update(snapshot: ServerSnapshot, localPlayerId: string, dt: number): void {
    this.bufferSnapshot(snapshot);
    const renderSnapshot = this.sampleBufferedSnapshot(Date.now() - NetworkRenderer.INTERPOLATION_DELAY_MS);
    if (!renderSnapshot) return;
    this.updatePlayers(renderSnapshot.players, localPlayerId, dt);
    this.updateBalls(renderSnapshot.balls);
  }

  getDebugStats(): NetworkRendererDebugStats {
    return {
      remoteInterpolationBufferSize: this.snapshotBuffer.length,
      ballInterpolationBufferSize: this.snapshotBuffer.length,
      renderDelayMs: NetworkRenderer.INTERPOLATION_DELAY_MS,
      latestSnapshotAgeMs: this.latestSnapshotReceivedAtMs > 0 ? Date.now() - this.latestSnapshotReceivedAtMs : 0
    };
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
    this.snapshotBuffer.length = 0;
    this.ballRenderContinuity.clear();
    this.lastBufferedTick = -1;
    this.lastBufferedResetSerial = -1;
    this.latestSnapshotReceivedAtMs = 0;
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
      this.snapshotBuffer.length = 0;
      this.ballRenderContinuity.clear();
      this.lastBufferedTick = -1;
      this.lastBufferedResetSerial = resetSerial;
    }

    if (snapshot.tick === this.lastBufferedTick) return;

    const now = Date.now();
    this.latestSnapshotReceivedAtMs = now;
    this.lastBufferedTick = snapshot.tick;
    this.snapshotBuffer.push({
      tick: snapshot.tick,
      resetSerial,
      receivedAtMs: now,
      players: Object.values(snapshot.room.players).map(clonePlayerState),
      balls: Object.values(snapshot.room.balls).map(cloneBallState)
    });

    while (
      this.snapshotBuffer.length > 2 &&
      now - this.snapshotBuffer[0].receivedAtMs > NetworkRenderer.MAX_BUFFER_MS
    ) {
      this.snapshotBuffer.shift();
    }
  }

  private sampleBufferedSnapshot(targetTimeMs: number): BufferedSnapshot | null {
    if (this.snapshotBuffer.length === 0) return null;
    if (this.snapshotBuffer.length === 1) return this.snapshotBuffer[0];

    let before: BufferedSnapshot | null = null;
    let after: BufferedSnapshot | null = null;

    for (const snapshot of this.snapshotBuffer) {
      if (snapshot.receivedAtMs <= targetTimeMs) before = snapshot;
      if (snapshot.receivedAtMs >= targetTimeMs) {
        after = snapshot;
        break;
      }
    }

    if (!before) return this.snapshotBuffer[0];
    if (!after) return extrapolateSnapshot(before, targetTimeMs - before.receivedAtMs);
    if (before === after) return before;

    const spanMs = Math.max(1, after.receivedAtMs - before.receivedAtMs);
    const t = clamp01((targetTimeMs - before.receivedAtMs) / spanMs);
    return interpolateSnapshots(before, after, t, targetTimeMs);
  }

  private updatePlayers(players: PlayerState[], localPlayerId: string, dt: number): void {
    const seen = new Set<string>();

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

  private updateBalls(balls: BallState[]): void {
    const seen = new Set<string>();

    for (const ball of balls) {
      seen.add(ball.id);
      const visual = this.ensureBall(ball);
      const target = toVector3(ball.position);
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
      { height: TUNING.player.height, radius: TUNING.player.radius },
      this.scene
    );
    body.parent = root;
    body.position.y = TUNING.player.height * 0.5;
    body.material = this.material(player.teamId === 'red' ? 'playerRed' : 'playerBlue');

    const head = MeshBuilder.CreateSphere(
      `remotePlayerHead_${player.id}`,
      { diameter: 0.38, segments: 14 },
      this.scene
    );
    head.parent = root;
    head.position.y = TUNING.player.eyeHeight;
    head.scaling.set(1, 0.86, 1.08);
    head.material = this.material('playerHead');

    const facing = MeshBuilder.CreateCylinder(
      `remotePlayerFacing_${player.id}`,
      { height: 0.52, diameter: 0.07, tessellation: 10 },
      this.scene
    );
    facing.parent = root;
    facing.material = this.material('playerFacing');

    const visual = {
      root,
      body,
      head,
      facing,
      leftArm: this.buildArm(player.id, 'left', root),
      rightArm: this.buildArm(player.id, 'right', root)
    };
    this.players.set(player.id, visual);
    this.playerDebug.set(player.id, { logTimer: 0 });
    return visual;
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
    const eye = base.add(new Vector3(0, TUNING.player.eyeHeight, 0));
    const aimEnd = eye.add(forwardV.scale(0.5));

    visual.head.position.copyFrom(eye.subtract(root));
    this.poseSegment(visual.facing, eye, aimEnd, root);
    this.poseArm(renderPlayer, visual.leftArm, 'left', root, forwardV, rightV);
    this.poseArm(renderPlayer, visual.rightArm, 'right', root, forwardV, rightV);
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
    const shoulder = base
      .add(new Vector3(0, 1.22, 0))
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
    this.materials.set(key, material);
    return material;
  }
}

function toVector3(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
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
  const playersBefore = new Map(before.players.map((player) => [player.id, player]));
  const ballsBefore = new Map(before.balls.map((ball) => [ball.id, ball]));

  return {
    tick: after.tick,
    resetSerial: after.resetSerial,
    receivedAtMs: targetTimeMs,
    players: after.players.map((player) => {
      const previous = playersBefore.get(player.id);
      return previous ? interpolatePlayerState(previous, player, t) : clonePlayerState(player);
    }),
    balls: after.balls.map((ball) => {
      const previous = ballsBefore.get(ball.id);
      return previous ? interpolateBallState(previous, ball, t) : cloneBallState(ball);
    })
  };
}

function extrapolateSnapshot(snapshot: BufferedSnapshot, deltaMs: number): BufferedSnapshot {
  const dt = Math.min(NetworkRenderer.BALL_EXTRAPOLATION_MAX_MS, Math.max(0, deltaMs)) / 1000;
  return {
    tick: snapshot.tick,
    resetSerial: snapshot.resetSerial,
    receivedAtMs: snapshot.receivedAtMs + deltaMs,
    players: snapshot.players.map(clonePlayerState),
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

function materialColor(key: string): { diffuse: Color3; emissive: Color3; metallic: number; roughness: number } {
  switch (key) {
    case 'playerRed':
      return { diffuse: new Color3(0.95, 0.18, 0.14), emissive: new Color3(0.025, 0, 0), metallic: 0, roughness: 0.4 };
    case 'playerBlue':
      return { diffuse: new Color3(0.15, 0.42, 0.95), emissive: new Color3(0, 0.01, 0.035), metallic: 0, roughness: 0.4 };
    case 'playerHead':
      return { diffuse: new Color3(0.82, 0.58, 0.46), emissive: new Color3(0.025, 0.012, 0.008), metallic: 0, roughness: 0.46 };
    case 'playerArm':
      return { diffuse: new Color3(0.78, 0.52, 0.4), emissive: new Color3(0.018, 0.008, 0.006), metallic: 0, roughness: 0.5 };
    case 'leftHand':
      return { diffuse: new Color3(0.95, 0.82, 0.32), emissive: new Color3(0.04, 0.025, 0.004), metallic: 0, roughness: 0.42 };
    case 'rightHand':
      return { diffuse: new Color3(0.5, 0.9, 0.78), emissive: new Color3(0.006, 0.035, 0.025), metallic: 0, roughness: 0.42 };
    case 'playerFacing':
      return { diffuse: new Color3(1, 0.95, 0.78), emissive: new Color3(0.04, 0.03, 0.008), metallic: 0.05, roughness: 0.32 };
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
