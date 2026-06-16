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
import { CONTROL_KEYS, MOUSE_BUTTON } from '../config/controls';
import { SoundManager } from '../audio/SoundManager';
import { Effects } from '../effects/Effects';
import { PracticeBot } from '../bot/PracticeBot';
import { settings } from '../config/Settings';
import { MultiplayerClient } from '../network/MultiplayerClient';
import { MultiplayerOverlay } from '../network/MultiplayerOverlay';
import { NetworkRenderer } from '../network/NetworkRenderer';
import type { PlayerInput, PlayerState, Vec3 } from '../../../shared/types';

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
  private readonly gym: GymArena;
  private readonly multiplayer = new MultiplayerClient();
  private readonly multiplayerOverlay: MultiplayerOverlay;
  private readonly networkRenderer: NetworkRenderer;

  // Accumulated scene time (seconds) — drives moving dummy oscillation.
  private elapsed = 0;
  // Previous-frame state for edge-triggered effect callbacks.
  private prevSliding = false;
  private prevBackflipActive = false;
  private onlineModeActive = false;
  private networkYaw = 0;
  private networkPitch = 0;
  private readonly onlineCharging: Record<'left' | 'right', boolean> = { left: false, right: false };
  private readonly onlineChargeSeconds: Record<'left' | 'right', number> = { left: 0, right: 0 };

  constructor(engine: Engine, canvas: HTMLCanvasElement) {
    this.scene = new Scene(engine);
    this.scene.clearColor.set(0.04, 0.05, 0.065, 1);
    this.input = new InputManager(canvas);

    this.createLighting();

    const loader = new ModelLoader(this.scene);
    this.gym = new GymArena(this.scene, loader);
    this.gym.build();
    // All meshes with targetDummy metadata — includes both static and the moving dummy.
    this.targetDummies = this.scene.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && !!mesh.metadata?.targetDummy);

    this.ballManager = new BallManager(loader, this.gym.collision);
    this.ballManager.spawnCenterLineBalls();

    this.sound = new SoundManager();
    this.effects = new Effects(this.scene, this.sound);

    this.player = new PlayerController(this.scene, this.input, this.ballManager, this.gym.collision, this.effects);
    this.bot = new PracticeBot(loader, this.ballManager);

    const hudRoot = document.getElementById('hud-root');
    if (!hudRoot) throw new Error('Missing HUD root.');
    this.hud = new Hud(hudRoot);
    this.settingsPanel = new SettingsPanel();
    this.multiplayerOverlay = new MultiplayerOverlay(this.multiplayer);
    this.networkRenderer = new NetworkRenderer(this.scene);
  }

  update(): void {
    const engine = this.scene.getEngine();
    // One simulation step per rendered frame. dt is clamped so a long hitch (alt-tab, GC)
    // can't produce a huge step that tunnels through collision. Because input edges are
    // consumed in this same single step, no clicks/presses get dropped (unlike the old
    // fixed-step substep loop, which discarded edges on frames that ran zero substeps).
    const frameMs = engine.getDeltaTime();
    const dt = Math.min(frameMs / 1000, TUNING.simulation.maxDeltaSeconds);

    this.multiplayerOverlay.update();
    if (this.multiplayer.connected) {
      this.enterOnlineMode();
      this.stepOnline(dt);
      if (this.multiplayer.latestSnapshot) {
        this.hud.updateNetwork(
          this.multiplayer.latestSnapshot,
          this.multiplayer.localPlayerId,
          engine.getFps(),
          frameMs,
          this.multiplayer.pingMs
        );
      }
    } else {
      this.exitOnlineMode();
      this.step(dt);
      this.hud.update(this.player, this.rules, this.ballManager, engine.getFps(), frameMs);
    }
    this.input.endFrame();
  }

  dispose(): void {
    this.input.dispose();
    this.hud.dispose();
    this.multiplayerOverlay.dispose();
    this.multiplayer.dispose();
    this.networkRenderer.dispose();
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
    this.elapsed += dt;

    // Snapshot previous states before the update so we can detect edges.
    const wasSliding = this.prevSliding;
    const wasBackflipActive = this.prevBackflipActive;

    this.player.update(dt);

    const snap = this.player.lastMovementSnapshot;

    // Fire one-shot effects on state transitions so every slide/dash/backflip has audio+visual.
    if (!wasSliding && snap.sliding) this.effects.onSlide();
    if (snap.dashingThisFrame) this.effects.onDash();
    if (!wasBackflipActive && this.player.backflip.active) this.effects.onBackflip();

    this.prevSliding = snap.sliding;
    this.prevBackflipActive = this.player.backflip.active;

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

    // Advance the moving dummy's oscillation.
    this.gym.update(this.elapsed);

    if (this.rules.scoring.isWin()) {
      this.rules.boundary.lastMessage = 'You reached 5 hits. Reset with K.';
    }

    if (this.input.wasKeyPressed(CONTROL_KEYS.toggleDebug)) {
      this.hud.toggleDebug();
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

  private stepOnline(dt: number): void {
    this.elapsed += dt;
    const networkInput = this.buildNetworkInput(dt);
    this.sendOnlineActions(dt, networkInput);
    this.multiplayer.sendInput(networkInput);

    const snapshot = this.multiplayer.latestSnapshot;
    const local = snapshot?.room.players[this.multiplayer.localPlayerId];
    if (snapshot && local) {
      this.applyNetworkLocalPlayer(local);
      this.networkRenderer.update(snapshot, this.multiplayer.localPlayerId);
    }

    this.effects.update(dt);
    this.gym.update(this.elapsed);
  }

  private enterOnlineMode(): void {
    if (this.onlineModeActive) return;
    this.onlineModeActive = true;
    this.networkYaw = this.player.root.rotation.y;
    this.networkPitch = this.player.camera.rotation.x;
    this.onlineCharging.left = false;
    this.onlineCharging.right = false;
    this.onlineChargeSeconds.left = 0;
    this.onlineChargeSeconds.right = 0;
    this.player.hands.clearHands();
    this.bot.reset();
    this.ballManager.clear();
  }

  private exitOnlineMode(): void {
    if (!this.onlineModeActive) return;
    this.onlineModeActive = false;
    this.networkRenderer.clear();
    this.onlineCharging.left = false;
    this.onlineCharging.right = false;
    this.onlineChargeSeconds.left = 0;
    this.onlineChargeSeconds.right = 0;
    this.player.hands.clearHands();
    this.player.resetPosition();
    this.ballManager.spawnCenterLineBalls();
  }

  private buildNetworkInput(_dt: number): PlayerInput {
    const { dx, dy } = this.input.consumeMouseDelta();
    this.networkYaw += dx * settings.mouseSensitivity;
    this.networkPitch += dy * settings.mouseSensitivity;
    this.networkPitch = Math.max(-1.45, Math.min(1.45, this.networkPitch));

    const leftHand = this.input.isMouseDown(MOUSE_BUTTON.leftHand);
    const rightHand = this.input.isMouseDown(MOUSE_BUTTON.rightHand);

    return {
      moveX: (this.input.isKeyDown(CONTROL_KEYS.right) ? 1 : 0) - (this.input.isKeyDown(CONTROL_KEYS.left) ? 1 : 0),
      moveZ: (this.input.isKeyDown(CONTROL_KEYS.forward) ? 1 : 0) - (this.input.isKeyDown(CONTROL_KEYS.backward) ? 1 : 0),
      lookYawRadians: this.networkYaw,
      lookPitchRadians: this.networkPitch,
      jump: this.input.isKeyDown(CONTROL_KEYS.jump),
      crouch: this.input.isKeyDown(CONTROL_KEYS.crouch) || this.input.isKeyDown(CONTROL_KEYS.crouchAlt),
      slide: this.input.isKeyDown(CONTROL_KEYS.slide),
      dash: this.input.isKeyDown(CONTROL_KEYS.dash),
      backflip: this.input.isKeyDown(CONTROL_KEYS.backflip),
      interact: this.input.isKeyDown(CONTROL_KEYS.interact),
      drop: this.input.isKeyDown(CONTROL_KEYS.drop),
      fakeThrow: this.input.isKeyDown(CONTROL_KEYS.fakeThrow),
      leftHand,
      rightHand,
      leftHandPressed: this.input.wasMousePressed(MOUSE_BUTTON.leftHand),
      rightHandPressed: this.input.wasMousePressed(MOUSE_BUTTON.rightHand),
      leftHandReleased: this.input.wasMouseReleased(MOUSE_BUTTON.leftHand),
      rightHandReleased: this.input.wasMouseReleased(MOUSE_BUTTON.rightHand)
    };
  }

  private sendOnlineActions(dt: number, networkInput: PlayerInput): void {
    const snapshot = this.multiplayer.latestSnapshot;
    const local = snapshot?.room.players[this.multiplayer.localPlayerId];
    const facing = facingFromAngles(this.networkYaw, this.networkPitch);

    if (this.input.wasKeyPressed(CONTROL_KEYS.interact)) {
      this.multiplayer.requestPickup();
    }

    if (this.input.wasKeyPressed(CONTROL_KEYS.drop)) {
      this.multiplayer.requestDrop();
    }

    if (this.input.wasKeyPressed(CONTROL_KEYS.resetMatch)) {
      this.multiplayer.requestReset();
    }

    if (!local) return;

    this.updateOnlineHandAction('left', MOUSE_BUTTON.leftHand, dt, networkInput.leftHand, facing, local);
    this.updateOnlineHandAction('right', MOUSE_BUTTON.rightHand, dt, networkInput.rightHand, facing, local);

    if (this.input.wasKeyPressed(CONTROL_KEYS.fakeThrow)) {
      this.onlineCharging.left = false;
      this.onlineCharging.right = false;
      this.onlineChargeSeconds.left = 0;
      this.onlineChargeSeconds.right = 0;
    }
  }

  private updateOnlineHandAction(
    side: 'left' | 'right',
    button: number,
    dt: number,
    mouseDown: boolean,
    facing: Vec3,
    local: PlayerState
  ): void {
    const hand = local.hands[side];
    const pressed = this.input.wasMousePressed(button);
    const released = this.input.wasMouseReleased(button);

    if (!hand.heldBallId) {
      this.onlineCharging[side] = false;
      this.onlineChargeSeconds[side] = 0;
      if (pressed) this.multiplayer.requestCatchParry(side, facing);
      return;
    }

    if (pressed) {
      this.onlineCharging[side] = true;
      this.onlineChargeSeconds[side] = 0;
    }

    if (this.onlineCharging[side] && mouseDown) {
      this.onlineChargeSeconds[side] = Math.min(TUNING.ball.maxChargeSeconds, this.onlineChargeSeconds[side] + dt);
    }

    if (this.onlineCharging[side] && released) {
      const charge01 = Math.min(1, this.onlineChargeSeconds[side] / TUNING.ball.maxChargeSeconds);
      this.multiplayer.requestThrow(side, facing, charge01);
      this.onlineCharging[side] = false;
      this.onlineChargeSeconds[side] = 0;
    }
  }

  private applyNetworkLocalPlayer(player: PlayerState): void {
    const p = player.movement.position;
    const v = player.movement.velocity;
    this.networkYaw = player.movement.yawRadians;
    this.networkPitch = player.movement.pitchRadians;
    this.player.root.position.set(p.x, p.y, p.z);
    this.player.root.rotation.y = player.movement.yawRadians;
    this.player.camera.rotation.x = player.movement.pitchRadians;
    this.player.camera.rotation.y = 0;
    this.player.camera.rotation.z = 0;
    this.player.movement.velocity.set(v.x, v.y, v.z);
    this.player.movement.grounded = player.movement.grounded;
    this.player.movement.crouching = player.movement.crouching;
    this.player.movement.sliding = player.movement.sliding;
    this.player.movement.wallRunning = player.movement.wallRunning;
    this.player.movement.dashingThisFrame = player.movement.dashingThisFrame;
    this.player.lastMovementSnapshot = {
      position: new Vector3(p.x, p.y, p.z),
      velocity: new Vector3(v.x, v.y, v.z),
      grounded: player.movement.grounded,
      sliding: player.movement.sliding,
      crouching: player.movement.crouching,
      wallRunning: player.movement.wallRunning,
      dashingThisFrame: player.movement.dashingThisFrame,
      speed: player.movement.speed,
      bhopGraceTimer: 0,
      wallRunTimer: 0,
      frictionMode: player.movement.grounded ? 'normal' : 'air'
    };
    this.player.camera.getViewMatrix(true);
  }

  private resetBalls(): void {
    // Detach hands and the bot first so neither references the about-to-be-disposed ball meshes.
    this.player.hands.clearHands();
    this.bot.reset();
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
    light.intensity = 1.15;
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

function facingFromAngles(yawRadians: number, pitchRadians: number): Vec3 {
  const pitchCos = Math.cos(pitchRadians);
  const x = Math.sin(yawRadians) * pitchCos;
  const y = Math.sin(pitchRadians);
  const z = Math.cos(yawRadians) * pitchCos;
  const len = Math.sqrt(x * x + y * y + z * z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}
