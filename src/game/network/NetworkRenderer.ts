import { Color3, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import type { ServerSnapshot } from '../../../shared/protocol';
import type { BallState, PlayerState } from '../../../shared/types';
import { TUNING } from '../config/tuning';

interface PlayerVisual {
  root: TransformNode;
  body: Mesh;
  facing: Mesh;
}

interface BallVisual {
  mesh: Mesh;
}

export class NetworkRenderer {
  private readonly players = new Map<string, PlayerVisual>();
  private readonly balls = new Map<string, BallVisual>();
  private readonly materials = new Map<string, StandardMaterial>();

  constructor(private readonly scene: Scene) {}

  update(snapshot: ServerSnapshot, localPlayerId: string): void {
    this.updatePlayers(Object.values(snapshot.room.players), localPlayerId);
    this.updateBalls(Object.values(snapshot.room.balls));
  }

  clear(): void {
    for (const visual of this.players.values()) {
      visual.root.dispose();
    }
    for (const visual of this.balls.values()) {
      visual.mesh.dispose();
    }
    this.players.clear();
    this.balls.clear();
  }

  dispose(): void {
    this.clear();
    for (const material of this.materials.values()) {
      material.dispose();
    }
    this.materials.clear();
  }

  private updatePlayers(players: PlayerState[], localPlayerId: string): void {
    const seen = new Set<string>();

    for (const player of players) {
      if (player.id === localPlayerId) continue;
      seen.add(player.id);
      const visual = this.ensurePlayer(player);
      const target = toVector3(player.movement.position);
      visual.root.position = Vector3.Lerp(visual.root.position, target, 0.35);
      visual.root.rotation.y = player.movement.yawRadians;
    }

    for (const [id, visual] of this.players) {
      if (seen.has(id)) continue;
      visual.root.dispose();
      this.players.delete(id);
    }
  }

  private updateBalls(balls: BallState[]): void {
    const seen = new Set<string>();

    for (const ball of balls) {
      seen.add(ball.id);
      const visual = this.ensureBall(ball);
      const target = toVector3(ball.position);
      const blend = ball.phase === 'live' || ball.phase === 'deflected' ? 0.65 : 1;
      visual.mesh.position = Vector3.Lerp(visual.mesh.position, target, blend);
      visual.mesh.material = this.material(this.ballMaterialKey(ball));
      visual.mesh.setEnabled(true);
    }

    for (const [id, visual] of this.balls) {
      if (seen.has(id)) continue;
      visual.mesh.dispose();
      this.balls.delete(id);
    }
  }

  private ensurePlayer(player: PlayerState): PlayerVisual {
    const existing = this.players.get(player.id);
    if (existing) return existing;

    const root = new TransformNode(`remotePlayer_${player.id}`, this.scene);
    root.position = toVector3(player.movement.position);
    root.rotation.y = player.movement.yawRadians;

    const body = MeshBuilder.CreateCapsule(
      `remotePlayerBody_${player.id}`,
      { height: TUNING.player.height, radius: TUNING.player.radius },
      this.scene
    );
    body.parent = root;
    body.position.y = TUNING.player.height * 0.5;
    body.material = this.material(player.teamId === 'red' ? 'playerRed' : 'playerBlue');

    const facing = MeshBuilder.CreateBox(
      `remotePlayerFacing_${player.id}`,
      { width: 0.22, height: 0.18, depth: 0.42 },
      this.scene
    );
    facing.parent = root;
    facing.position.set(0, 1.25, 0.44);
    facing.material = this.material('playerFacing');

    const visual = { root, body, facing };
    this.players.set(player.id, visual);
    return visual;
  }

  private ensureBall(ball: BallState): BallVisual {
    const existing = this.balls.get(ball.id);
    if (existing) return existing;

    const mesh = MeshBuilder.CreateSphere(
      `networkBall_${ball.id}`,
      { diameter: TUNING.ball.radius * 2, segments: 16 },
      this.scene
    );
    mesh.position = toVector3(ball.position);
    mesh.material = this.material(this.ballMaterialKey(ball));
    const visual = { mesh };
    this.balls.set(ball.id, visual);
    return visual;
  }

  private ballMaterialKey(ball: BallState): string {
    if (ball.phase === 'deflected' || ball.isSuper) return 'ballDeflected';
    if (ball.phase === 'held') return 'ballHeld';
    if (ball.phase === 'dead') return 'ballDead';
    return 'ballLive';
  }

  private material(key: string): StandardMaterial {
    const existing = this.materials.get(key);
    if (existing) return existing;

    const material = new StandardMaterial(`${key}_material`, this.scene);
    const color = materialColor(key);
    material.diffuseColor = color.diffuse;
    material.emissiveColor = color.emissive;
    this.materials.set(key, material);
    return material;
  }
}

function toVector3(v: { x: number; y: number; z: number }): Vector3 {
  return new Vector3(v.x, v.y, v.z);
}

function materialColor(key: string): { diffuse: Color3; emissive: Color3 } {
  switch (key) {
    case 'playerRed':
      return { diffuse: new Color3(0.95, 0.18, 0.14), emissive: new Color3(0.08, 0, 0) };
    case 'playerBlue':
      return { diffuse: new Color3(0.15, 0.42, 0.95), emissive: new Color3(0, 0.02, 0.08) };
    case 'playerFacing':
      return { diffuse: new Color3(1, 0.95, 0.78), emissive: new Color3(0.08, 0.06, 0.02) };
    case 'ballHeld':
      return { diffuse: new Color3(1, 0.38, 0.08), emissive: new Color3(0.22, 0.04, 0) };
    case 'ballDeflected':
      return { diffuse: new Color3(1, 0.9, 0.12), emissive: new Color3(0.45, 0.28, 0.03) };
    case 'ballDead':
      return { diffuse: new Color3(0.45, 0.12, 0.1), emissive: new Color3(0.03, 0, 0) };
    case 'ballLive':
    default:
      return { diffuse: new Color3(0.96, 0.12, 0.05), emissive: new Color3(0.22, 0.02, 0) };
  }
}
