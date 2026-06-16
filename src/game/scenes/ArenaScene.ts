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
import type { ServerSnapshot } from '../../../shared/protocol';
import type { DashState, MovementInternalState, PlayerInput, PlayerMovementState, PlayerState, Vec3 } from '../../../shared/types';
import { stepMovement, facingFromAngles } from '../../../shared/simulation/MovementSim';
import { createGymCollisionBoxes, type AABB } from '../../../shared/simulation/MapGeometry';
import { sweptBallHitsBody } from '../../../shared/simulation/CollisionMath';

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
  private lastOnlineScoreByTeamId: Record<string, number> = {};

  // --- Client-side prediction & reconciliation (#3) ---
  // The local player is simulated immediately via the SAME shared movement sim the server runs,
  // at a fixed timestep with sequence-numbered inputs. Each snapshot reconciles: adopt the
  // authoritative state, then replay inputs the server hasn't acknowledged yet.
  private readonly netCollisionBoxes: AABB[] = createGymCollisionBoxes();
  private static readonly NET_FIXED_DT = 1 / 30;
  private netAccumulator = 0;
  private inputSeq = 0;
  private pendingInputs: { seq: number; input: PlayerInput; prev: PlayerInput }[] = [];
  private predictedMovement: PlayerMovementState | null = null;
  private predictedInternal: MovementInternalState | null = null;
  private predictedDash: DashState | null = null;
  private lastSentInput: PlayerInput = neutralNetInput(0);
  // Authoritative server position stored for debug diff — never applied to the local mesh.
  private debugServerPos: { x: number; y: number; z: number } | null = null;
  private debugLogTimer = 0;

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
  private checkBotHitsPlayer(dt: number): void {
    const feet = this.player.root.position;
    const radius = TUNING.player.radius + TUNING.ball.radius;
    const base = { x: feet.x, y: feet.y, z: feet.z };
    const top = { x: feet.x, y: feet.y + TUNING.player.height, z: feet.z };

    for (const ball of this.ballManager.balls) {
      if (ball.state !== BallState.Live || ball.owner !== 'bot') continue;
      const b = ball.mesh.position;
      // Swept capsule (ball path this tick vs the player's body axis) so fast lobs that cross the
      // body between frames still register, and high throws count as head hits.
      const prev = { x: b.x - ball.velocity.x * dt, y: b.y - ball.velocity.y * dt, z: b.z - ball.velocity.z * dt };
      if (!sweptBallHitsBody(prev, b, base, top, radius)) continue;

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
    this.checkBotHitsPlayer(dt);

    // Each landed hit grants the thrower one dash charge (locked rule).
    const hits = this.rules.scoring.updateAgainstDummies(this.ballManager.balls, this.targetDummies, dt);
    for (let i = 0; i < hits; i += 1) {
      this.player.dash.addChargeFromHit();
      this.effects.onDummyHit();
    }
    if (hits > 0) {
      this.hud.showScoreEvent(`HIT +${hits}`, `${this.rules.scoring.playerHits} / ${TUNING.match.scoreLimit}`, 'good');
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

    // Run the full local movement controller — identical to offline mode.
    // Server state is intentionally NOT applied to the local player's position or camera.
    // The server still simulates our player from the inputs we send (authority is preserved),
    // but we never snap the local mesh to the server position.
    // TODO: Replace with client-side prediction + reconciliation once the basic feel is confirmed.
    const wasSliding = this.prevSliding;
    const wasBackflipActive = this.prevBackflipActive;
    this.player.update(dt); // handles mouse look, physics, viewmodel — same as step()
    const snap = this.player.lastMovementSnapshot;
    if (!wasSliding && snap.sliding) this.effects.onSlide();
    if (snap.dashingThisFrame) this.effects.onDash();
    if (!wasBackflipActive && this.player.backflip.active) this.effects.onBackflip();
    this.prevSliding = snap.sliding;
    this.prevBackflipActive = this.player.backflip.active;

    // Sync aim from the player controller so the input packets carry correct look angles.
    this.networkYaw = this.player.root.rotation.y;
    this.networkPitch = this.player.camera.rotation.x;

    // Send a full input packet every frame. Server queues them and processes one per tick.
    this.inputSeq += 1;
    const input = this.buildNetworkInput(true);
    this.multiplayer.sendInput(input);
    this.lastSentInput = input;

    const snapshot = this.multiplayer.latestSnapshot;
    const local = snapshot?.room.players[this.multiplayer.localPlayerId] ?? null;

    // Hand/pickup/throw/reset go to the server. Local ball manager is cleared in online mode
    // so player.update()'s internal hand logic above is a harmless no-op.
    if (this.input.wasKeyPressed(CONTROL_KEYS.interact)) this.multiplayer.requestPickup();
    if (this.input.wasKeyPressed(CONTROL_KEYS.drop)) this.multiplayer.requestDrop();
    if (this.input.wasKeyPressed(CONTROL_KEYS.resetMatch)) this.multiplayer.requestReset();
    if (local) this.sendOnlineHandActions(dt, local);
    if (this.input.wasKeyPressed(CONTROL_KEYS.fakeThrow)) {
      this.onlineCharging.left = false;
      this.onlineCharging.right = false;
      this.onlineChargeSeconds.left = 0;
      this.onlineChargeSeconds.right = 0;
    }

    // Remote players and all balls follow server state. NetworkRenderer skips localPlayerId
    // so the local mesh is never touched here.
    if (snapshot) {
      this.networkRenderer.update(snapshot, this.multiplayer.localPlayerId);
      this.handleOnlineScoreEvents(snapshot);
    }

    // Cache server position for debug only — not applied to the mesh.
    if (local) this.debugServerPos = local.movement.position;

    // Throttled debug: local vs server position error + movement key state every 0.5 s.
    // Use this to confirm: (a) the shaking stopped, (b) advanced keys are being sent.
    this.debugLogTimer += dt;
    if (this.debugLogTimer >= 0.5 && this.debugServerPos) {
      this.debugLogTimer = 0;
      const lp = this.player.root.position;
      const sp = this.debugServerPos;
      const ex = lp.x - sp.x, ey = lp.y - sp.y, ez = lp.z - sp.z;
      console.log(
        `[net] pos err=${Math.sqrt(ex * ex + ey * ey + ez * ez).toFixed(3)}m` +
        ` local=(${lp.x.toFixed(2)},${lp.y.toFixed(2)},${lp.z.toFixed(2)})` +
        ` server=(${sp.x.toFixed(2)},${sp.y.toFixed(2)},${sp.z.toFixed(2)})`
      );
      console.log(
        `[net] input jump=${Number(input.jumpPressed)}/${Number(input.jumpHeld)}` +
        ` dash=${Number(input.dashPressed)} slide=${Number(input.slidePressed)}` +
        ` crouch=${Number(input.crouchHeld)} backflip=${Number(input.backflipPressed)}` +
        ` yaw=${input.lookYawRadians.toFixed(2)} pitch=${input.lookPitchRadians.toFixed(2)}`
      );
    }

    this.effects.update(dt);
    this.gym.update(this.elapsed);
  }

  /** Adopt the authoritative snapshot, drop acknowledged inputs, then replay the unacked ones. */
  private reconcile(local: PlayerState): void {
    this.predictedMovement = cloneMovement(local.movement);
    this.predictedInternal = { ...local.movementInternal };
    this.predictedDash = { ...local.dash };

    const ack = local.lastProcessedInputSeq;
    while (this.pendingInputs.length > 0 && this.pendingInputs[0].seq <= ack) {
      this.pendingInputs.shift();
    }

    for (const entry of this.pendingInputs) {
      const res = stepMovement(
        this.predictedMovement,
        this.predictedInternal,
        this.predictedDash,
        entry.input,
        entry.prev,
        ArenaScene.NET_FIXED_DT,
        this.netCollisionBoxes,
        this.deriveCatchStance(local, entry.input)
      );
      this.predictedMovement = res.movement;
      this.predictedInternal = res.internal;
      this.predictedDash = res.dash;
    }
  }

  private deriveCatchStance(local: PlayerState | null, input: PlayerInput): boolean {
    const hands = local?.hands;
    const leftEmpty = !hands?.left.heldBallId;
    const rightEmpty = !hands?.right.heldBallId;
    return (leftEmpty && input.leftHandHeld) || (rightEmpty && input.rightHandHeld);
  }

  // Kept for when client-side prediction is re-introduced. Not called in the current
  // prototype build — local player position comes from PlayerController.update() directly.
  private applyPredicted(movement: PlayerMovementState, internal: MovementInternalState): void {
    const p = movement.position;
    const v = movement.velocity;
    this.player.root.position.set(p.x, p.y, p.z);
    this.player.root.rotation.y = this.networkYaw;
    this.player.camera.rotation.x = this.networkPitch;
    this.player.camera.rotation.y = 0;
    this.player.camera.rotation.z = 0;
    this.player.movement.velocity.set(v.x, v.y, v.z);
    this.player.movement.grounded = movement.grounded;
    this.player.movement.crouching = movement.crouching;
    this.player.movement.sliding = movement.sliding;
    this.player.movement.wallRunning = movement.wallRunning;
    this.player.movement.dashingThisFrame = movement.dashingThisFrame;
    this.player.lastMovementSnapshot = {
      position: new Vector3(p.x, p.y, p.z),
      velocity: new Vector3(v.x, v.y, v.z),
      grounded: movement.grounded,
      sliding: movement.sliding,
      crouching: movement.crouching,
      wallRunning: movement.wallRunning,
      dashingThisFrame: movement.dashingThisFrame,
      speed: movement.speed,
      bhopGraceTimer: internal.jumpGraceTimer,
      wallRunTimer: internal.wallRunTimer,
      frictionMode: !movement.grounded
        ? 'air'
        : internal.dashActiveTimer > 0 && !movement.sliding
          ? 'dashSuppressed'
          : movement.sliding
            ? 'slide'
            : 'normal'
    };
    this.player.camera.getViewMatrix(true);
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
    this.resetPrediction();
    this.player.hands.clearHands();
    this.bot.reset();
    this.setPracticePropsEnabled(false);
    this.ballManager.clear();
    this.lastOnlineScoreByTeamId = {};
  }

  private exitOnlineMode(): void {
    if (!this.onlineModeActive) return;
    this.onlineModeActive = false;
    this.networkRenderer.clear();
    this.onlineCharging.left = false;
    this.onlineCharging.right = false;
    this.onlineChargeSeconds.left = 0;
    this.onlineChargeSeconds.right = 0;
    this.resetPrediction();
    this.debugServerPos = null;
    this.debugLogTimer = 0;
    this.lastOnlineScoreByTeamId = {};
    this.player.hands.clearHands();
    this.player.resetPosition();
    this.bot.reset();
    this.setPracticePropsEnabled(true);
    this.ballManager.spawnCenterLineBalls();
  }

  private resetPrediction(): void {
    this.netAccumulator = 0;
    this.inputSeq = 0;
    this.pendingInputs = [];
    this.predictedMovement = null;
    this.predictedInternal = null;
    this.predictedDash = null;
    this.lastSentInput = neutralNetInput(this.networkYaw);
  }

  private handleOnlineScoreEvents(snapshot: ServerSnapshot): void {
    const scores = snapshot.room.match.scoreByTeamId;
    if (Object.keys(this.lastOnlineScoreByTeamId).length === 0) {
      this.lastOnlineScoreByTeamId = { ...scores };
      return;
    }

    for (const [teamId, score] of Object.entries(scores)) {
      const previous = this.lastOnlineScoreByTeamId[teamId] ?? score;
      const delta = score - previous;
      if (delta > 0) this.showOnlineScoreEvent(snapshot, teamId, score, delta);
    }

    this.lastOnlineScoreByTeamId = { ...scores };
  }

  private showOnlineScoreEvent(snapshot: ServerSnapshot, scoringTeamId: string, score: number, delta: number): void {
    const local = snapshot.room.players[this.multiplayer.localPlayerId];
    const scorer = Object.values(snapshot.room.players).find((player) => player.teamId === scoringTeamId);
    const scorerName = scorer?.name ?? scoringTeamId.toUpperCase();
    const localScored = local?.teamId === scoringTeamId;
    const boundaryEvent = snapshot.room.match.boundary.lastEvent;
    const wasPenalty = boundaryEvent.type === 'half-court-penalty' && boundaryEvent.opponentTeamId === scoringTeamId;

    if (wasPenalty) {
      this.hud.showScoreEvent(`PENALTY +${delta}`, `${scorerName} ${score} / ${snapshot.room.match.scoreLimit}`, localScored ? 'good' : 'bad');
      return;
    }

    if (localScored) {
      this.effects.onDummyHit();
      this.hud.showScoreEvent(`HIT +${delta}`, `${scorerName} ${score} / ${snapshot.room.match.scoreLimit}`, 'good');
      return;
    }

    this.effects.onPlayerHit(this.player.camera.globalPosition);
    this.hud.showScoreEvent('HIT TAKEN', `${scorerName} ${score} / ${snapshot.room.match.scoreLimit}`, 'bad');
  }

  private setPracticePropsEnabled(enabled: boolean): void {
    this.bot.setEnabled(enabled);
    for (const dummy of this.targetDummies) {
      dummy.setEnabled(enabled);
      for (const child of dummy.getChildMeshes(false)) {
        child.setEnabled(enabled);
      }
    }
  }

  // Build one network input packet. Held actions are sent as held booleans so the server can
  // derive consecutive-frame edges. Press edges (jump/dash/slide/backflip/pickup/drop) are only
  // set true on the frame the key went down so they are never double-counted across ticks.
  private buildNetworkInput(includeEdges: boolean): PlayerInput {
    const crouchDown = this.input.isKeyDown(CONTROL_KEYS.crouch) || this.input.isKeyDown(CONTROL_KEYS.crouchAlt);
    const moveX = (this.input.isKeyDown(CONTROL_KEYS.right) ? 1 : 0) - (this.input.isKeyDown(CONTROL_KEYS.left) ? 1 : 0);
    const moveZ = (this.input.isKeyDown(CONTROL_KEYS.forward) ? 1 : 0) - (this.input.isKeyDown(CONTROL_KEYS.backward) ? 1 : 0);
    const yaw = this.networkYaw;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const dashDirection = moveX !== 0 || moveZ !== 0
      ? { x: moveX * cos + moveZ * sin, y: 0, z: -moveX * sin + moveZ * cos }
      : { x: 0, y: 0, z: 0 };

    return {
      sequence: this.inputSeq,
      clientTimeMs: Date.now(),
      moveX,
      moveZ,
      dashDirection,
      lookYawRadians: yaw,
      lookPitchRadians: this.networkPitch,
      jumpPressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.jump),
      jumpHeld: this.input.isKeyDown(CONTROL_KEYS.jump),
      dashPressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.dash),
      crouchPressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.crouch),
      crouchHeld: crouchDown,
      slidePressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.slide),
      slideHeld: this.input.isKeyDown(CONTROL_KEYS.slide),
      backflipPressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.backflip),
      pickupPressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.interact),
      dropPressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.drop),
      fakeThrowPressed: includeEdges && this.input.wasKeyPressed(CONTROL_KEYS.fakeThrow),
      fakeThrowHeld: this.input.isKeyDown(CONTROL_KEYS.fakeThrow),
      leftHandPressed: includeEdges && this.input.wasMousePressed(MOUSE_BUTTON.leftHand),
      leftHandHeld: this.input.isMouseDown(MOUSE_BUTTON.leftHand),
      rightHandPressed: includeEdges && this.input.wasMousePressed(MOUSE_BUTTON.rightHand),
      rightHandHeld: this.input.isMouseDown(MOUSE_BUTTON.rightHand),
      leftHandReleased: includeEdges && this.input.wasMouseReleased(MOUSE_BUTTON.leftHand),
      rightHandReleased: includeEdges && this.input.wasMouseReleased(MOUSE_BUTTON.rightHand)
    };
  }

  private sendOnlineHandActions(dt: number, local: PlayerState): void {
    const facing = facingFromAngles(this.networkYaw, this.networkPitch);
    this.updateOnlineHandAction('left', MOUSE_BUTTON.leftHand, dt, this.input.isMouseDown(MOUSE_BUTTON.leftHand), facing, local);
    this.updateOnlineHandAction('right', MOUSE_BUTTON.rightHand, dt, this.input.isMouseDown(MOUSE_BUTTON.rightHand), facing, local);
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

function cloneMovement(movement: PlayerMovementState): PlayerMovementState {
  return {
    ...movement,
    position: { ...movement.position },
    velocity: { ...movement.velocity },
    facing: { ...movement.facing }
  };
}

function neutralNetInput(yawRadians: number): PlayerInput {
  return {
    sequence: 0,
    clientTimeMs: 0,
    moveX: 0,
    moveZ: 0,
    dashDirection: { x: 0, y: 0, z: 0 },
    lookYawRadians: yawRadians,
    lookPitchRadians: 0,
    jumpPressed: false,
    jumpHeld: false,
    dashPressed: false,
    crouchPressed: false,
    crouchHeld: false,
    slidePressed: false,
    slideHeld: false,
    backflipPressed: false,
    pickupPressed: false,
    dropPressed: false,
    fakeThrowPressed: false,
    fakeThrowHeld: false,
    leftHandPressed: false,
    leftHandHeld: false,
    rightHandPressed: false,
    rightHandHeld: false,
    leftHandReleased: false,
    rightHandReleased: false
  };
}
