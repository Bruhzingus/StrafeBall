import { Engine, HemisphericLight, Mesh, Scene, Vector3 } from '@babylonjs/core';
import { InputManager } from '../input/InputManager';
import { PlayerController } from '../player/PlayerController';
import { GymArena } from '../map/GymArena';
import { ModelLoader } from '../assets/ModelLoader';
import { BallManager } from '../ball/BallManager';
import { BallState } from '../ball/BallState';
import { Hud } from '../ui/Hud';
import { SettingsPanel } from '../ui/SettingsPanel';
import { MatchRules } from '../rules/MatchRules';
import { TUNING } from '../config/tuning';
import { CONTROL_KEYS } from '../config/controls';
import { SoundManager } from '../audio/SoundManager';
import { Effects } from '../effects/Effects';
import { PracticeBot } from '../bot/PracticeBot';

export class ArenaScene {
  public readonly scene: Scene;

  private readonly input: InputManager;
  private readonly ballManager: BallManager;
  private readonly player: PlayerController;
  private readonly hud: Hud;
  private readonly rules = new MatchRules();
  private readonly targetDummies: Mesh[] = [];
  private readonly sound: SoundManager;
  private readonly effects: Effects;
  private readonly bot: PracticeBot;
  private readonly settingsPanel: SettingsPanel;

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

    this.sound = new SoundManager();
    this.effects = new Effects(this.scene, this.sound);

    this.player = new PlayerController(this.scene, this.input, this.ballManager, gym.collision, this.effects);
    this.bot = new PracticeBot(loader, this.ballManager);

    const hudRoot = document.getElementById('hud-root');
    if (!hudRoot) throw new Error('Missing HUD root.');
    this.hud = new Hud(hudRoot);
    this.settingsPanel = new SettingsPanel();
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
    this.settingsPanel.dispose();
    this.bot.dispose();
    this.effects.dispose();
    this.sound.dispose();
  }

  /**
   * A bot-thrown ball that reaches the player (i.e. the player failed to catch or block it)
   * counts as a hit: kill the ball and fire hit feedback. The player is approximated as an
   * upright capsule of radius `player.radius` from the feet (root) up to `player.height`.
   * Caught/parried balls leave the Live state before reaching here, so they never register.
   */
  private checkBotHitsPlayer(): void {
    const feet = this.player.root.position;
    const reach = TUNING.player.radius + TUNING.ball.radius;
    const reachSq = reach * reach;

    for (const ball of this.ballManager.balls) {
      if (ball.state !== BallState.Live || ball.owner !== 'bot') continue;
      const b = ball.mesh.position;
      if (b.y < feet.y + 0.2 || b.y > feet.y + TUNING.player.height) continue;
      const dx = b.x - feet.x;
      const dz = b.z - feet.z;
      if (dx * dx + dz * dz > reachSq) continue;

      ball.makeDead();
      this.effects.onPlayerHit(b);
    }
  }

  private step(dt: number): void {
    this.player.update(dt);

    // Practice bot lobs a map ball at the player's head each interval (for catch/block drills).
    if (this.bot.update(dt, this.player.camera.globalPosition)) {
      this.effects.botThrow();
    }

    this.ballManager.update(dt);
    this.checkBotHitsPlayer();

    // Each landed hit grants the thrower one dash charge (locked rule).
    const hits = this.rules.scoring.updateAgainstDummies(this.ballManager.balls, this.targetDummies);
    for (let i = 0; i < hits; i += 1) {
      this.player.dash.addChargeFromHit();
      this.effects.onDummyHit();
    }

    this.rules.boundary.update(dt, this.player.root.position);
    this.effects.update(dt);

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
