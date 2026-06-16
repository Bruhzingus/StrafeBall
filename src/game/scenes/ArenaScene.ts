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
  private lastResetSerial = -1;
  private lastResetVoteKey = '';

  // --- Client-side prediction & reconciliation ---
  // The local player is simulated via the SAME shared movement sim the server runs, at a fixed
  // timestep with sequence-numbered inputs. Each snapshot reconciles: adopt the authoritative
  // state, then replay inputs the server hasn't acknowledged yet.
  private readonly netCollisionBoxes: AABB[] = createGymCollisionBoxes();
  private static readonly NET_FIXED_DT = 1 / 30;
  private netAccumulator = 0;
  private inputSeq = 0;
  private pendingInputs: { seq: number; input: PlayerInput; prev: PlayerInput }[] = [];
  private predictedMovement: PlayerMovementState | null = null;
  private predictedInternal: MovementInternalState | null = null;
  private predictedDash: DashState | null = null;
  private lastSentInput: PlayerInput = neutralNetInput(0);
  private lastReconciledTick = -1;
  private debugLogTimer = 0;

  // --- Debug / diagnostics ---
  private snapshotReceiveCount = 0;
  private snapshotRateTimer = 0;
  private snapshotRateHz = 0;
  private predictionErrorM = 0;
  private residualAfterReplayM = 0;
  private expectedLeadM = 0;
  private lastAckedSeq = 0;
  private lastAckedInputClientTimeMs = 0;
  private lastAckReceiveMs = 0;
  private readonly sentInputClientTimeBySeq = new Map<number, number>();
  private readonly localPositionWritersThisSecond = new Set<string>();
  private localPositionWriterTimer = 0;
  private lastSeenSnapshotTick = -1;
  private onlineRateLogTimer = 0;
  private onlineRateLogFrameCount = 0;
  private onlineRateLogInputCount = 0;

  // Input latches: accumulate edge-triggered inputs across render frames so they survive to the
  // next fixed-step packet boundary (render may run faster than the 30 Hz send rate).
  private latchJumpPressed = false;
  private latchDashPressed = false;
  private latchSlidePressed = false;
  private latchBackflipPressed = false;
  private latchPickupPressed = false;
  private latchDropPressed = false;
  private latchCrouchPressed = false;
  private latchFakeThrowPressed = false;
  private latchLeftHandPressed = false;
  private latchRightHandPressed = false;
  private latchLeftHandReleased = false;
  private latchRightHandReleased = false;

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
          this.multiplayer.pingMs,
          {
            snapshotRateHz: this.snapshotRateHz,
            inputSeq: this.inputSeq,
            lastAckedSeq: this.multiplayer.latestSnapshot.room.players[this.multiplayer.localPlayerId]?.lastProcessedInputSeq ?? 0,
            pendingInputs: this.pendingInputs.length,
            predictionErrorM: this.predictionErrorM,
            residualAfterReplayM: this.residualAfterReplayM,
            expectedLeadM: this.expectedLeadM,
            ackAgeMs: this.ackAgeMs(),
            predictionActive: this.predictedMovement !== null,
          }
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
    this.onlineRateLogFrameCount += 1;

    // --- Latch edge-triggered inputs every render frame so none are lost between fixed ticks ---
    this.latchJumpPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.jump);
    this.latchDashPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.dash);
    this.latchSlidePressed ||= this.input.wasKeyPressed(CONTROL_KEYS.slide);
    this.latchBackflipPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.backflip);
    this.latchPickupPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.interact);
    this.latchDropPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.drop);
    this.latchCrouchPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.crouch);
    this.latchFakeThrowPressed ||= this.input.wasKeyPressed(CONTROL_KEYS.fakeThrow);
    this.latchLeftHandPressed ||= this.input.wasMousePressed(MOUSE_BUTTON.leftHand);
    this.latchRightHandPressed ||= this.input.wasMousePressed(MOUSE_BUTTON.rightHand);
    this.latchLeftHandReleased ||= this.input.wasMouseReleased(MOUSE_BUTTON.leftHand);
    this.latchRightHandReleased ||= this.input.wasMouseReleased(MOUSE_BUTTON.rightHand);

    // Mouse look + viewmodel only — physics and hand sim are server-authoritative.
    // Effect callbacks fire from predicted state after the fixed-step loop below.
    this.player.updateOnline(dt);

    if (this.latchFakeThrowPressed) {
      this.onlineCharging.left = false;
      this.onlineCharging.right = false;
      this.onlineChargeSeconds.left = 0;
      this.onlineChargeSeconds.right = 0;
    }

    // Look angles come from the offline controller (mouse-driven) — not predicted.
    this.networkYaw = this.player.root.rotation.y;
    this.networkPitch = this.player.camera.rotation.x;

    const snapshot = this.multiplayer.latestSnapshot;
    const local = snapshot?.room.players[this.multiplayer.localPlayerId] ?? null;

    // Track snapshot receive rate and prediction error for the debug HUD.
    if (snapshot && snapshot.tick !== this.lastSeenSnapshotTick) {
      this.lastSeenSnapshotTick = snapshot.tick;
      this.snapshotReceiveCount += 1;
    }
    this.snapshotRateTimer += dt;
    if (this.snapshotRateTimer >= 1.0) {
      this.snapshotRateHz = this.snapshotReceiveCount / this.snapshotRateTimer;
      this.snapshotReceiveCount = 0;
      this.snapshotRateTimer = 0;
    }
    this.updatePredictionDebugMetrics(local);

    // Initialise prediction from the first authoritative player state we receive.
    if (local && !this.predictedMovement) {
      this.predictedMovement = cloneMovement(local.movement);
      this.predictedInternal = { ...local.movementInternal };
      this.predictedDash = { ...local.dash };
    }

    // Reconcile when a new snapshot tick arrives: adopt server state, replay unacked inputs.
    if (local && snapshot && snapshot.tick > this.lastReconciledTick) {
      this.lastReconciledTick = snapshot.tick;
      this.reconcile(local);
    }

    // --- Fixed-step prediction: one packet per server tick (33 ms), same shared sim ---
    this.netAccumulator += dt;
    while (this.netAccumulator >= ArenaScene.NET_FIXED_DT && this.predictedMovement) {
      this.netAccumulator -= ArenaScene.NET_FIXED_DT;
      this.inputSeq += 1;

      const input = this.buildNetworkInput();
      const prev = this.lastSentInput;

      const res = stepMovement(
        this.predictedMovement, this.predictedInternal!, this.predictedDash!,
        input, prev, ArenaScene.NET_FIXED_DT, this.netCollisionBoxes,
        this.deriveCatchStance(local, input)
      );
      this.predictedMovement = res.movement;
      this.predictedInternal = res.internal;
      this.predictedDash = res.dash;

      this.pendingInputs.push({ seq: this.inputSeq, input, prev });
      if (this.pendingInputs.length > 120) this.pendingInputs.shift();

      // Clear latches after the packet is built; the immutable input object carries the edges.
      this.latchJumpPressed = false;
      this.latchDashPressed = false;
      this.latchSlidePressed = false;
      this.latchBackflipPressed = false;
      this.latchPickupPressed = false;
      this.latchDropPressed = false;
      this.latchCrouchPressed = false;
      this.latchFakeThrowPressed = false;
      this.latchLeftHandPressed = false;
      this.latchRightHandPressed = false;
      this.latchLeftHandReleased = false;
      this.latchRightHandReleased = false;

      // Per-packet debug log (throttled to ~1 s).
      this.debugLogTimer += ArenaScene.NET_FIXED_DT;
      if (this.debugLogTimer >= 1.0) {
        this.debugLogTimer = 0;
        this.updatePredictionDebugMetrics(local);
        const pm = this.predictedMovement;
        const ackAge = this.ackAgeMs();
        console.log(
          `[net/input/send] seq=${input.sequence} pending=${this.pendingInputs.length}` +
          ` lastSent=${input.sequence} lastAcked=${this.lastAckedSeq}` +
          ` ackAge=${ackAge === null ? 'n/a' : `${ackAge}ms`}` +
          ` move=(${input.moveX.toFixed(2)},${input.moveZ.toFixed(2)})` +
          ` jump=${Number(input.jumpPressed)}/${Number(input.jumpHeld)} dash=${Number(input.dashPressed)}` +
          ` slide=${Number(input.slidePressed)} backflip=${Number(input.backflipPressed)}` +
          ` pickup=${Number(input.pickupPressed)} drop=${Number(input.dropPressed)}` +
          ` yaw=${input.lookYawRadians.toFixed(2)} pitch=${input.lookPitchRadians.toFixed(2)}`
        );
        console.log(
          `[net/pos] rawServerLeadErr=${this.predictionErrorM.toFixed(3)}m` +
          ` pending=${this.pendingInputs.length}` +
          ` expectedLead~=${this.expectedLeadM.toFixed(3)}m` +
          ` residualAfterReplay=${this.residualAfterReplayM.toFixed(3)}m` +
          ` predicted=(${pm.position.x.toFixed(2)},${pm.position.y.toFixed(2)},${pm.position.z.toFixed(2)})`
        );
      }

      this.sentInputClientTimeBySeq.set(input.sequence, input.clientTimeMs);
      this.multiplayer.sendInput(input);
      this.onlineRateLogInputCount += 1;
      this.lastSentInput = input;
    }

    // Fire one-shot effects from predicted state transitions (replaces offline controller callbacks).
    if (this.predictedMovement && this.predictedInternal) {
      const nowSliding = this.predictedMovement.sliding;
      const nowBackflip = this.predictedInternal.backflipActive;
      if (!this.prevSliding && nowSliding) this.effects.onSlide();
      if (this.predictedMovement.dashingThisFrame) this.effects.onDash();
      if (!this.prevBackflipActive && nowBackflip) this.effects.onBackflip();
      this.prevSliding = nowSliding;
      this.prevBackflipActive = nowBackflip;
    }

    // Apply the shared-sim predicted position to the player root.
    // The camera is parented to root, so it follows automatically; look angles are untouched.
    if (this.predictedMovement && this.predictedInternal) {
      this.applyPredicted(this.predictedMovement, this.predictedInternal);
    }

    // Server-side actions (not in the movement input stream).
    if (this.input.wasKeyPressed(CONTROL_KEYS.reset) || this.input.wasKeyPressed(CONTROL_KEYS.resetMatch)) {
      this.multiplayer.requestReset();
    }
    if (local) this.sendOnlineHandActions(dt, local);

    // Remote players and balls: rendered from server state.
    if (snapshot) {
      this.handleOnlineResetEvents(snapshot);
      this.networkRenderer.update(snapshot, this.multiplayer.localPlayerId, dt);
      this.handleOnlineScoreEvents(snapshot);
    }

    this.effects.update(dt);
    this.gym.update(this.elapsed);
    this.logLocalPositionWriters(dt);
    this.logOnlineRates(dt);
  }

  private updatePredictionDebugMetrics(local: PlayerState | null): void {
    if (!local || !this.predictedMovement) {
      this.predictionErrorM = 0;
      this.residualAfterReplayM = 0;
      this.expectedLeadM = 0;
      return;
    }

    this.predictionErrorM = distanceVec3(this.predictedMovement.position, local.movement.position);
    const unacked = this.pendingInputs.filter((entry) => entry.seq > local.lastProcessedInputSeq);
    this.expectedLeadM = this.predictedMovement.speed * unacked.length * ArenaScene.NET_FIXED_DT;

    const replayed = this.replayUnackedFromServer(local, unacked);
    this.residualAfterReplayM = replayed
      ? distanceVec3(this.predictedMovement.position, replayed.movement.position)
      : 0;
  }

  private replayUnackedFromServer(
    local: PlayerState,
    unacked: { seq: number; input: PlayerInput; prev: PlayerInput }[]
  ): { movement: PlayerMovementState; internal: MovementInternalState; dash: DashState } | null {
    let movement = cloneMovement(local.movement);
    let internal = { ...local.movementInternal };
    let dash = { ...local.dash };

    for (const entry of unacked) {
      const res = stepMovement(
        movement,
        internal,
        dash,
        entry.input,
        entry.prev,
        ArenaScene.NET_FIXED_DT,
        this.netCollisionBoxes,
        this.deriveCatchStance(local, entry.input)
      );
      movement = res.movement;
      internal = res.internal;
      dash = res.dash;
    }

    return { movement, internal, dash };
  }

  /** Adopt the authoritative snapshot, drop acknowledged inputs, then replay the unacked ones. */
  private reconcile(local: PlayerState): void {
    this.predictedMovement = cloneMovement(local.movement);
    this.predictedInternal = { ...local.movementInternal };
    this.predictedDash = { ...local.dash };

    const ack = local.lastProcessedInputSeq;
    if (ack > this.lastAckedSeq) {
      this.lastAckedSeq = ack;
      this.lastAckReceiveMs = Date.now();
      const ackedClientTime = this.sentInputClientTimeBySeq.get(ack);
      if (ackedClientTime !== undefined) this.lastAckedInputClientTimeMs = ackedClientTime;
      for (const seq of this.sentInputClientTimeBySeq.keys()) {
        if (seq < ack - 120) this.sentInputClientTimeBySeq.delete(seq);
      }
    }
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

  private applyPredicted(movement: PlayerMovementState, internal: MovementInternalState): void {
    this.markLocalPositionWriter('applyPredicted');
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

  private markLocalPositionWriter(name: string): void {
    if (!this.onlineModeActive) return;
    this.localPositionWritersThisSecond.add(name);
  }

  private logLocalPositionWriters(dt: number): void {
    if (!this.onlineModeActive) return;
    this.localPositionWriterTimer += dt;
    if (this.localPositionWriterTimer < 1.0) return;
    this.localPositionWriterTimer = 0;

    const writers = [...this.localPositionWritersThisSecond].sort();
    console.log(`[net/local-writers] ${writers.length > 0 ? writers.join(',') : 'none'}`);
    this.localPositionWritersThisSecond.clear();
  }

  private logOnlineRates(dt: number): void {
    if (!this.onlineModeActive) return;
    this.onlineRateLogTimer += dt;
    if (this.onlineRateLogTimer < 1.0) return;

    const elapsed = this.onlineRateLogTimer;
    const snapshotDebug = this.multiplayer.snapshotDebug;
    const renderStats = this.networkRenderer.getDebugStats();
    const snapshotRate = snapshotDebug.receivedPerSecond;
    console.log(
      `[net/rates] snapshots=${snapshotRate.toFixed(1)}/s` +
      ` avgMs=${snapshotDebug.averageMsBetweenSnapshots.toFixed(1)}` +
      ` maxMs=${snapshotDebug.maxMsBetweenSnapshots.toFixed(1)}` +
      ` inputPackets=${(this.onlineRateLogInputCount / elapsed).toFixed(1)}/s` +
      ` renderFps=${(this.onlineRateLogFrameCount / elapsed).toFixed(1)}` +
      ` remoteBuffer=${renderStats.remoteInterpolationBufferSize}` +
      ` ballBuffer=${renderStats.ballInterpolationBufferSize}` +
      ` renderDelay=${renderStats.renderDelayMs}ms` +
      ` latestSnapshotAge=${renderStats.latestSnapshotAgeMs}ms`
    );

    if (snapshotRate >= 18 && snapshotRate <= 22) {
      console.log(`[net/rates] snapshot receive rate is ~20Hz (actual ${snapshotRate.toFixed(1)}/s)`);
    }

    this.onlineRateLogTimer = 0;
    this.onlineRateLogFrameCount = 0;
    this.onlineRateLogInputCount = 0;
  }

  private ackAgeMs(): number | null {
    if (this.lastAckedInputClientTimeMs <= 0) return this.lastAckReceiveMs > 0 ? Date.now() - this.lastAckReceiveMs : null;
    return Math.max(0, Date.now() - this.lastAckedInputClientTimeMs);
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
    this.resetPrediction('enter-online');
    this.player.hands.clearHands();
    this.bot.reset();
    this.setPracticePropsEnabled(false);
    this.ballManager.clear();
    this.lastOnlineScoreByTeamId = {};
    this.lastResetSerial = -1;
    this.lastResetVoteKey = '';
  }

  private exitOnlineMode(): void {
    if (!this.onlineModeActive) return;
    this.onlineModeActive = false;
    this.networkRenderer.clear();
    this.onlineCharging.left = false;
    this.onlineCharging.right = false;
    this.onlineChargeSeconds.left = 0;
    this.onlineChargeSeconds.right = 0;
    this.resetPrediction('exit-online');
    this.lastOnlineScoreByTeamId = {};
    this.lastResetSerial = -1;
    this.lastResetVoteKey = '';
    this.player.hands.clearHands();
    this.player.resetPosition();
    this.bot.reset();
    this.setPracticePropsEnabled(true);
    this.ballManager.spawnCenterLineBalls();
  }

  private resetPrediction(reason = 'reset'): void {
    if (this.inputSeq > 0 || this.pendingInputs.length > 0) {
      console.log(`[net/seq] reset reason=${reason} oldSeq=${this.inputSeq} oldPending=${this.pendingInputs.length}`);
    }
    this.netAccumulator = 0;
    this.inputSeq = 0;
    this.pendingInputs = [];
    this.predictedMovement = null;
    this.predictedInternal = null;
    this.predictedDash = null;
    this.lastSentInput = neutralNetInput(this.networkYaw, this.networkPitch);
    this.lastReconciledTick = -1;
    this.debugLogTimer = 0;
    this.lastAckedSeq = 0;
    this.lastAckedInputClientTimeMs = 0;
    this.lastAckReceiveMs = 0;
    this.sentInputClientTimeBySeq.clear();
    this.localPositionWritersThisSecond.clear();
    this.localPositionWriterTimer = 0;
    this.onlineRateLogTimer = 0;
    this.onlineRateLogFrameCount = 0;
    this.onlineRateLogInputCount = 0;
    this.snapshotReceiveCount = 0;
    this.snapshotRateTimer = 0;
    this.snapshotRateHz = 0;
    this.predictionErrorM = 0;
    this.lastSeenSnapshotTick = -1;
    this.latchJumpPressed = false;
    this.latchDashPressed = false;
    this.latchSlidePressed = false;
    this.latchBackflipPressed = false;
    this.latchPickupPressed = false;
    this.latchDropPressed = false;
    this.latchCrouchPressed = false;
    this.latchFakeThrowPressed = false;
    this.latchLeftHandPressed = false;
    this.latchRightHandPressed = false;
    this.latchLeftHandReleased = false;
    this.latchRightHandReleased = false;
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

  private handleOnlineResetEvents(snapshot: ServerSnapshot): void {
    const vote = snapshot.room.resetVote;
    if (this.lastResetSerial < 0) {
      this.lastResetSerial = vote.resetSerial;
    } else if (vote.resetSerial !== this.lastResetSerial) {
      this.lastResetSerial = vote.resetSerial;
      this.lastResetVoteKey = '';
      this.resetPrediction('server-reset');
      this.onlineCharging.left = false;
      this.onlineCharging.right = false;
      this.onlineChargeSeconds.left = 0;
      this.onlineChargeSeconds.right = 0;
      this.player.hands.clearHands();
      this.lastOnlineScoreByTeamId = {};
      this.hud.showScoreEvent('RESET', 'Room reset', 'neutral');
    }

    const voterIds = Object.keys(vote.votesByPlayerId).sort().join(',');
    const voteKey = `${vote.resetSerial}:${vote.voteCount}/${vote.requiredVotes}:${voterIds}`;
    if (voteKey === this.lastResetVoteKey) return;
    this.lastResetVoteKey = voteKey;

    if (vote.voteCount > 0 && vote.requiredVotes > 0) {
      this.hud.showScoreEvent('RESET VOTE', `${vote.voteCount}/${vote.requiredVotes}`, 'neutral');
    }
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

  // Build one network input packet for a fixed-step tick. Edge-triggered fields come from
  // latches (accumulated since the last send) so no key press is lost between ticks.
  private buildNetworkInput(): PlayerInput {
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
      jumpPressed: this.latchJumpPressed,
      jumpHeld: this.input.isKeyDown(CONTROL_KEYS.jump),
      dashPressed: this.latchDashPressed,
      crouchPressed: this.latchCrouchPressed,
      crouchHeld: crouchDown,
      slidePressed: this.latchSlidePressed,
      slideHeld: this.input.isKeyDown(CONTROL_KEYS.slide),
      backflipPressed: this.latchBackflipPressed,
      pickupPressed: this.latchPickupPressed,
      dropPressed: this.latchDropPressed,
      fakeThrowPressed: this.latchFakeThrowPressed,
      fakeThrowHeld: this.input.isKeyDown(CONTROL_KEYS.fakeThrow),
      leftHandPressed: this.latchLeftHandPressed,
      leftHandHeld: this.input.isMouseDown(MOUSE_BUTTON.leftHand),
      rightHandPressed: this.latchRightHandPressed,
      rightHandHeld: this.input.isMouseDown(MOUSE_BUTTON.rightHand),
      leftHandReleased: this.latchLeftHandReleased,
      rightHandReleased: this.latchRightHandReleased
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

function distanceVec3(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function neutralNetInput(yawRadians: number, pitchRadians = 0): PlayerInput {
  return {
    sequence: 0,
    clientTimeMs: 0,
    moveX: 0,
    moveZ: 0,
    dashDirection: { x: 0, y: 0, z: 0 },
    lookYawRadians: yawRadians,
    lookPitchRadians: pitchRadians,
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
