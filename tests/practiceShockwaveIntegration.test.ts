import { MeshBuilder, NullEngine, Scene, Vector3 } from '@babylonjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { ModelLoader } from '../src/game/assets/ModelLoader';
import { Ball } from '../src/game/ball/Ball';
import { BallManager } from '../src/game/ball/BallManager';
import { PracticeOpponent } from '../src/game/bot/PracticeOpponent';
import { CollisionWorld } from '../src/game/map/Collider';
import { PracticePowerupSpawner } from '../src/game/practice/PracticePowerupSpawner';
import { ArenaScene } from '../src/game/scenes/ArenaScene';

const PLAYER_EYE = new Vector3(0, 1.55, -8);

interface ShockwaveRuntime {
  resolvePracticeOpponentBall(ball: Ball, start: Vector3, end: Vector3): void;
  updatePracticePowerupBalls(dt: number): void;
}

function setup(creator: boolean) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  const collision = new CollisionWorld();
  const balls = new BallManager({ scene } as ModelLoader, collision);
  const gymBot = new PracticeOpponent(scene, balls, { collision });
  const creatorBot = creator ? new PracticeOpponent(scene, balls, { collision }) : null;
  if (creator) gymBot.setEnabled(false);
  const bot = creatorBot ?? gymBot;
  const powerups = new PracticePowerupSpawner();
  const playerVelocity = Vector3.Zero();
  const player = {
    root: { position: new Vector3(2, 0, 9), rotation: { y: 0 } },
    movement: { velocity: playerVelocity, grounded: true, sliding: false, wallRunning: false },
    hands: { removeBall: vi.fn() }
  };
  // Exercise the real ArenaScene observer/fuse/detonation methods without constructing its browser UI.
  const runtime = Object.assign(Object.create(ArenaScene.prototype) as object, {
    onlineModeActive: false,
    movementSandbox: null,
    practiceOpponent: gymBot,
    creatorBots: creatorBot ? [creatorBot] : [],
    ballManager: balls,
    practicePowerups: powerups,
    practicePowerupRoom: { resetVote: { resetSerial: 0 } },
    player
  }) as unknown as ShockwaveRuntime;

  const grenade = new Ball(MeshBuilder.CreateSphere('shock', { diameter: 0.4 }, scene), new Vector3(0, 1.2, 8.25));
  grenade.powerupKind = 'shock';
  balls.balls.push(grenade);
  grenade.throw('player', new Vector3(0, 0, 20), false, 0);

  const dispose = () => {
    creatorBot?.dispose();
    gymBot.dispose();
    balls.clear();
    scene.dispose();
    engine.dispose();
  };
  return { balls, bot, grenade, collision, player, powerups, runtime, dispose };
}

describe('offline shockwave from a grenade stuck to an opponent', () => {
  for (const creator of [false, true]) {
    it(`arms, detonates, and launches ${creator ? 'a Creator bot' : 'the gym opponent'} and nearby player`, () => {
      const rig = setup(creator);
      try {
        const botBefore = rig.bot.feetPosition;
        // BallManager uses this same Ball.update callback for its swept scene observer. Calling
        // the physics update directly avoids initializing browser-only powerup textures in Node.
        rig.grenade.update(0.05, rig.collision,
          (ball, start, end) => rig.runtime.resolvePracticeOpponentBall(ball, start, end));
        // Ball.update can turn a zero-speed Dead grenade Loose in this same frame; the fuse must
        // already be armed by the scene's swept-contact observer before that state transition.
        expect(rig.grenade.fuseSeconds).toBeDefined();
        expect(rig.powerups.drainEvents().map(event => event.effect)).toContain('stick');

        rig.runtime.updatePracticePowerupBalls(0.65);
        expect(rig.balls.balls).not.toContain(rig.grenade);
        expect(rig.powerups.drainEvents().map(event => event.effect)).toContain('shock');
        expect(rig.player.movement.velocity.length()).toBeGreaterThan(1);

        for (let frame = 0; frame < 12; frame += 1) rig.bot.update(1 / 60, PLAYER_EYE);
        const botAfter = rig.bot.feetPosition;
        expect(Math.hypot(botAfter.x - botBefore.x, botAfter.z - botBefore.z)).toBeGreaterThan(2);
        expect(botAfter.z).toBeGreaterThan(0.8);
        expect(rig.bot.mesh.position.y).toBeGreaterThan(0.92);
      } finally {
        rig.dispose();
      }
    });
  }
});
