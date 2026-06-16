import { Engine, HemisphericLight, Mesh, Scene, Vector3 } from '@babylonjs/core';
import { InputManager } from '../input/InputManager';
import { PlayerController } from '../player/PlayerController';
import { GymArena } from '../map/GymArena';
import { ModelLoader } from '../assets/ModelLoader';
import { BallManager } from '../ball/BallManager';
import { Hud } from '../ui/Hud';
import { MatchRules } from '../rules/MatchRules';
import { TUNING } from '../config/tuning';
import { CONTROL_KEYS } from '../config/controls';

export class ArenaScene {
  public readonly scene: Scene;

  private readonly input: InputManager;
  private readonly ballManager: BallManager;
  private readonly player: PlayerController;
  private readonly hud: Hud;
  private readonly rules = new MatchRules();
  private readonly targetDummies: Mesh[] = [];

  constructor(engine: Engine, canvas: HTMLCanvasElement) {
    this.scene = new Scene(engine);
    this.scene.clearColor.set(0.04, 0.05, 0.065, 1);
    this.input = new InputManager(canvas);

    this.createLighting();

    const loader = new ModelLoader(this.scene);
    const gym = new GymArena(this.scene, loader);
    gym.build();
    this.targetDummies = this.scene.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && !!mesh.metadata?.targetDummy);

    this.ballManager = new BallManager(loader, gym.collision);
    this.ballManager.spawnCenterLineBalls();

    this.player = new PlayerController(this.scene, this.input, this.ballManager, gym.collision);

    const hudRoot = document.getElementById('hud-root');
    if (!hudRoot) throw new Error('Missing HUD root.');
    this.hud = new Hud(hudRoot);
  }

  update(): void {
    const engine = this.scene.getEngine();
    // One simulation step per rendered frame. dt is clamped so a long hitch (alt-tab, GC)
    // can't produce a huge step that tunnels through collision. Because input edges are
    // consumed in this same single step, no clicks/presses get dropped (unlike the old
    // fixed-step substep loop, which discarded edges on frames that ran zero substeps).
    const frameMs = engine.getDeltaTime();
    const dt = Math.min(frameMs / 1000, TUNING.simulation.maxDeltaSeconds);

    this.step(dt);

    this.hud.update(this.player, this.rules, this.ballManager, engine.getFps(), frameMs);
    this.input.endFrame();
  }

  dispose(): void {
    this.input.dispose();
    this.hud.dispose();
  }

  private step(dt: number): void {
    this.player.update(dt);
    this.ballManager.update(dt);

    // Each landed hit grants the thrower one dash charge (locked rule).
    const hits = this.rules.scoring.updateAgainstDummies(this.ballManager.balls, this.targetDummies);
    for (let i = 0; i < hits; i += 1) {
      this.player.dash.addChargeFromHit();
    }

    this.rules.boundary.update(dt, this.player.root.position);

    if (this.rules.scoring.isWin()) {
      this.rules.boundary.lastMessage = 'You reached 5 hits. Reset with K.';
    }

    if (this.input.wasKeyPressed(CONTROL_KEYS.debugBallLauncher)) {
      this.launchTestBallAtPlayer();
    }

    if (this.input.wasKeyPressed(CONTROL_KEYS.resetBalls)) {
      this.resetBalls();
    }

    if (this.input.wasKeyPressed(CONTROL_KEYS.resetMatch)) {
      this.resetMatch();
    }
  }

  private resetBalls(): void {
    // Detach hands first so they don't reference the about-to-be-disposed ball meshes.
    this.player.hands.clearHands();
    this.ballManager.spawnCenterLineBalls();
  }

  private resetMatch(): void {
    this.rules.reset();
    for (const dummy of this.targetDummies) {
      if (dummy.metadata) dummy.metadata.hitCount = 0;
    }
  }

  private createLighting(): void {
    const light = new HemisphericLight('gym_hemi_light', new Vector3(0.25, 1, 0.35), this.scene);
    light.intensity = 0.95;
  }

  private launchTestBallAtPlayer(): void {
    // Reuse a free (never held) ball so we don't yank a ball out of the player's hand.
    const ball = this.ballManager.findFreeBall();
    if (!ball) return;
    const origin = new Vector3(0, 1.35, 10);
    const target = this.player.camera.globalPosition;
    const direction = target.subtract(origin).normalizeToNew();
    this.ballManager.throwBall(ball, origin, direction, 22, 'launcher', false);
  }
}
