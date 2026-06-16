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
import { backflipPitchOffset } from '../../../shared/simulation/AimMath';
import { CLIENT_FIXED_DT, PENDING_INPUT_LIMIT, MAX_ACCUMULATOR_STEPS, PERF_REPORT_INTERVAL_MS } from '../../../shared/netConfig';
import { createPlayerCollisionBoxes, type AABB } from '../../../shared/simulation/MapGeometry';
import { sweptBallHitsBody } from '../../../shared/simulation/CollisionMath';
import { playerBallHitRadius, playerHitCapsule } from '../../../shared/simulation/PlayerHitbox';

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
  // Catch-attempt ids (server-authoritative timed catch). A click on an EMPTY hand assigns a fresh
  // id; the latched id is stamped on every input packet (so the trigger survives packet loss) until
  // the server's hand.lastCatchAttemptId catches up, at which point we stop re-sending it.
  private nextCatchAttemptId = 1;
  private readonly pendingCatchAttemptId: Record<'left' | 'right', number> = { left: 0, right: 0 };
  // True while the authoritative match is in its pre-round countdown: local input is frozen to look
  // only (movement/combat zeroed) and the HUD shows the countdown. Driven by the snapshot.
  private countdownActive = false;
  private lastOnlineScoreByTeamId: Record<string, number> = {};
  private lastResetSerial = -1;
  private lastResetVoteKey = '';

  // --- Client-side prediction & reconciliation ---
  // The local player is simulated via the SAME shared movement sim the server runs, at a fixed
  // timestep with sequence-numbered inputs. Each snapshot reconciles: adopt the authoritative
  // state, then replay inputs the server hasn't acknowledged yet.
  // Client prediction collision set. Mirrors the server's player collision (bleachers + standing
  // mats); rebuilt from snapshot mat state when a mat is knocked over so prediction stays in sync.
  private netCollisionBoxes: AABB[] = createPlayerCollisionBoxes();
  // Set of mat ids currently reflected in netCollisionBoxes — avoids rebuilding every frame.
  private readonly knockedNetMatIds = new Set<string>();
  // Fixed timestep for input send + prediction + reconciliation replay. Driven entirely by the
  // shared net config (must equal the server's fixed dt for reconciliation residual ≈ 0). At the
  // active A_72_72_60 mode this is 1/72; the fixed-step loop below then sends at 72Hz.
  private static readonly NET_FIXED_DT = CLIENT_FIXED_DT;
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
  // Separate 5s window for the always-on client [perf] line (mirrors the server PERF_DEBUG report).
  private perfReportTimer = 0;
  private perfReportFrameCount = 0;
  private perfReportInputCount = 0;
  private perfReportFrameMsTotal = 0;

  // Input latches: accumulate edge-triggered inputs across render frames so they survive to the
  // next fixed-step packet boundary. They survive whether render runs faster OR slower than the
  // input rate: on a frame that emits zero fixed steps the latches are NOT cleared (cleared only
  // inside the while loop after a packet is built), so no edge is dropped at e.g. 50fps vs 60Hz.
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

    // Balls collide with bleachers only (mats are immune to balls — they pass through).
    this.ballManager = new BallManager(loader, this.gym.ballCollision);
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
    this.gym.dispose();
    this.sound.dispose();
  }

  /**
   * A bot-thrown ball that reaches the player (i.e. the player failed to catch or block it)
   * counts as a hit: kill the ball and fire hit feedback. The player is approximated as an
   * upright capsule of radius `player.radius` from the feet (root) up to `player.height`.
   * Caught/parried balls leave the Live state before reaching here, so they never register.
   */
  private checkBotHitsPlayer(dt: number): void {
    const hitbox = playerHitCapsule({
      movement: {
        position: vector3ToVec3(this.player.root.position),
        velocity: vector3ToVec3(this.player.movement.velocity),
        yawRadians: this.player.root.rotation.y,
        pitchRadians: this.player.camera.rotation.x,
        facing: { x: 0, y: 0, z: 1 },
        grounded: this.player.movement.grounded,
        crouching: this.player.movement.crouching,
        sliding: this.player.movement.sliding,
        wallRunning: this.player.movement.wallRunning,
        dashingThisFrame: this.player.movement.dashingThisFrame,
        speed: this.player.lastMovementSnapshot.speed
      }
    });
    const radius = playerBallHitRadius();

    for (const ball of this.ballManager.balls) {
      if (ball.state !== BallState.Live || ball.owner !== 'bot') continue;
      const b = ball.mesh.position;
      // Swept capsule (ball path this tick vs the player's body axis) so fast lobs that cross the
      // body between frames still register, and high throws count as head hits.
      const prev = { x: b.x - ball.velocity.x * dt, y: b.y - ball.velocity.y * dt, z: b.z - ball.velocity.z * dt };
      if (!sweptBallHitsBody(prev, b, hitbox.base, hitbox.top, radius)) continue;

      ball.makeDead();
      this.effects.onPlayerHit(b);
    }
  }

  /**
   * Offline: knock a standing mat flat when the local player walks into it (mirrors the server's
   * contact-based rule). A downed mat's collision box is spliced out of the PLAYER collision world
   * so it becomes walkable; balls already ignore mats (separate ballCollision world).
   */
  private updateOfflineMats(): void {
    const p = this.player.root.position;
    const v = this.player.movement.velocity;
    const r = TUNING.player.radius;
    const reach = r + 0.12;

    for (const mat of this.gym.mats) {
      if (mat.knockedOver) continue;
      const box = mat.getAABB();
      if (p.y > box.maxY || p.y + TUNING.player.height < box.minY) continue;
      const cx = Math.max(box.minX, Math.min(p.x, box.maxX));
      const cz = Math.max(box.minZ, Math.min(p.z, box.maxZ));
      const dx = p.x - cx;
      const dz = p.z - cz;
      if (dx * dx + dz * dz > reach * reach) continue;
      const toMatX = (box.minX + box.maxX) * 0.5 - p.x;
      const toMatZ = (box.minZ + box.maxZ) * 0.5 - p.z;
      if (v.x * toMatX + v.z * toMatZ <= 0.01) continue;

      const dir = new Vector3(v.x, 0, v.z);
      // Remove the box BEFORE laying the mat flat (getAABB returns the standing footprint, which is
      // what was added to the collision world). Then it no longer blocks movement.
      this.gym.removeMatCollision(mat);
      mat.knockOver(dir.lengthSquared() > 1e-4 ? dir : new Vector3(toMatX, 0, toMatZ));
    }
  }

  /**
   * Online: drive the gym mat visuals from authoritative snapshot mat state. The server decides
   * when a mat is knocked over (and the direction); the client just tips the matching visual.
   */
  private applyOnlineMats(snapshot: ServerSnapshot): void {
    const mats = snapshot.room.mats;
    if (!mats) return;
    let knockedChanged = false;

    for (const mat of this.gym.mats) {
      const state = mats[mat.id];
      if (!state) continue;
      if (state.knockedOver && !mat.knockedOver) {
        mat.knockOver(new Vector3(state.knockDirection.x, 0, state.knockDirection.z));
        this.knockedNetMatIds.add(mat.id);
        knockedChanged = true;
      } else if (!state.knockedOver && mat.knockedOver) {
        // Server reset the mat (e.g. room reset): stand it back up.
        mat.reset();
        this.knockedNetMatIds.delete(mat.id);
        knockedChanged = true;
      }
    }

    // Keep the prediction collision set in sync with the server: a downed mat stops blocking.
    if (knockedChanged) {
      this.netCollisionBoxes = createPlayerCollisionBoxes(this.knockedNetMatIds);
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
    this.updateOfflineMats();

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

    // Advance the moving dummy's oscillation + the live 3D scoreboards (offline shows practice score:
    // your dummy hits as BLUE, opponent penalty as RED; setScores buzzes them when a number ticks up).
    this.gym.update(this.elapsed);
    this.gym.setScoreboardScores(this.rules.scoring.playerHits, this.rules.boundary.opponentPenaltyHits);
    this.gym.updateScoreboards(dt);

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
    this.perfReportFrameCount += 1;
    this.perfReportFrameMsTotal += dt * 1000;

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

    const snapshot = this.multiplayer.latestSnapshot;
    const local = snapshot?.room.players[this.multiplayer.localPlayerId] ?? null;
    // Pre-round countdown gate: while the authoritative match is counting down, local input is
    // frozen to look-only (built in buildNetworkInput) so the player can't move/throw until GO.
    this.countdownActive = snapshot?.room.match.status === 'countdown';

    // Hand edges are folded into the fixed input stream. Process them before building packets so
    // catch ids and throw releases ride the same ordered tick as crouch/look/charge state.
    if (local && !this.countdownActive) this.sendOnlineHandActions(dt, local);
    this.syncOnlineViewmodelHands(local);

    // Mouse look + viewmodel only — physics and hand sim are server-authoritative.
    // Effect callbacks fire from predicted state after the fixed-step loop below.
    this.player.updateOnline(dt);

    // Look angles come from the offline controller (mouse-driven) — not predicted.
    this.networkYaw = this.player.root.rotation.y;
    this.networkPitch = this.player.camera.rotation.x;

    // Detect a server room reset BEFORE prediction/reconcile this frame. The reset is keyed on
    // resetSerial (not tick), so it is robust even if the tick were ever non-monotonic. Clearing
    // prediction here — before the reconcile block below — guarantees the very next reconcile
    // adopts the fresh spawn state instead of replaying stale pre-reset inputs against it (the old
    // ordering ran reconcile first and only cleared afterward, which is what made reset glitchy).
    if (snapshot) this.detectServerReset(snapshot);

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

    // --- Fixed-step prediction: one packet per server tick, same shared sim, at CLIENT_FIXED_DT ---
    // Spiral-of-death guard (mirrors the server's MAX_ACCUMULATOR_STEPS): a single slow render
    // frame (hitch / GC / alt-tab) could otherwise dump many input packets at once. Cap the
    // iterations per frame and drop the backlog by clamping the accumulator afterwards.
    this.netAccumulator += dt;
    let fixedSteps = 0;
    while (
      this.netAccumulator >= ArenaScene.NET_FIXED_DT &&
      this.predictedMovement &&
      fixedSteps < MAX_ACCUMULATOR_STEPS
    ) {
      this.netAccumulator -= ArenaScene.NET_FIXED_DT;
      fixedSteps += 1;
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
      if (this.pendingInputs.length > PENDING_INPUT_LIMIT) this.pendingInputs.shift();

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

      // Per-packet debug log (throttled to ~1 s, and off unless strafeball.debug.net === '1').
      // The timer resets on every threshold crossing regardless of the flag so it can't grow
      // unbounded while debug is off; the logging itself is gated.
      this.debugLogTimer += ArenaScene.NET_FIXED_DT;
      if (this.debugLogTimer >= 1.0) {
        this.debugLogTimer = 0;
        if (isNetDebugEnabled()) {
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
      }

      this.sentInputClientTimeBySeq.set(input.sequence, input.clientTimeMs);
      this.multiplayer.sendInput(input);
      this.onlineRateLogInputCount += 1;
      this.perfReportInputCount += 1;
      this.lastSentInput = input;
    }

    // Spiral guard: if we hit the per-frame step cap there was a large backlog (hitch). Drop it by
    // clamping the leftover accumulator to at most one fixed step so the next frame starts fresh
    // instead of trying to catch up dozens of ticks (which would dump a burst of packets).
    if (fixedSteps >= MAX_ACCUMULATOR_STEPS && this.netAccumulator > ArenaScene.NET_FIXED_DT) {
      this.netAccumulator = ArenaScene.NET_FIXED_DT;
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

    // Server-side actions outside the movement input stream. Reset votes are always allowed.
    if (this.input.wasKeyPressed(CONTROL_KEYS.reset) || this.input.wasKeyPressed(CONTROL_KEYS.resetMatch)) {
      this.multiplayer.requestReset();
    }

    // Remote players and balls: rendered from server state. Pass the local PREDICTED movement so a
    // ball held by the local player attaches to the present-time hand (no strafe drag) rather than
    // the interpolation-delayed network position.
    if (snapshot) {
      this.handleOnlineResetEvents(snapshot);
      // Seed live-ball visual prediction from any throw events that arrived this frame BEFORE the
      // renderer update so a freshly-thrown ball predicts from its very first rendered frame.
      this.networkRenderer.applyThrowEvents(this.multiplayer.drainThrowEvents());
      this.networkRenderer.update(snapshot, this.multiplayer.localPlayerId, dt, this.predictedMovement);
      this.applyOnlineMats(snapshot);
      this.handleOnlineScoreEvents(snapshot);
      this.updateOnlineScoreboards(snapshot);
    }

    this.effects.update(dt);
    this.gym.update(this.elapsed);
    this.gym.updateScoreboards(dt);
    this.logLocalPositionWriters(dt);
    this.logOnlineRates(dt);
    this.logClientPerf(dt);
  }

  /**
   * Always-on (unless silenced) client [perf] line, every PERF_REPORT_INTERVAL_MS. Mirrors the
   * server [perf] report so before/after comparisons line up. Distinct from logOnlineRates, which
   * is the verbose 1 s NET_DEBUG diagnostic. The counters reset every window regardless of the gate
   * so they never accumulate across an off period.
   */
  private logClientPerf(dt: number): void {
    if (!this.onlineModeActive) return;
    this.perfReportTimer += dt;
    if (this.perfReportTimer < PERF_REPORT_INTERVAL_MS / 1000) return;

    if (isPerfDebugEnabled()) {
      const elapsed = this.perfReportTimer;
      const snap = this.multiplayer.snapshotDebug;
      const render = this.networkRenderer.getDebugStats();
      const avgFrameMs = this.perfReportFrameCount > 0 ? this.perfReportFrameMsTotal / this.perfReportFrameCount : 0;
      const fps = avgFrameMs > 0 ? 1000 / avgFrameMs : 0;
      const activeMeshes = this.scene.getActiveMeshes ? this.scene.getActiveMeshes().length : this.scene.meshes.length;
      console.log(
        `[perf] fps=${fps.toFixed(1)} avgFrameMs=${avgFrameMs.toFixed(2)}` +
        ` snapshots=${snap.receivedPerSecond.toFixed(1)}/s` +
        ` snapMs avg=${snap.averageMsBetweenSnapshots.toFixed(1)} max=${snap.maxMsBetweenSnapshots.toFixed(1)}` +
        ` inputPackets=${(this.perfReportInputCount / elapsed).toFixed(1)}/s` +
        ` pendingInputs=${this.pendingInputs.length}` +
        ` residualAfterReplay=${this.residualAfterReplayM.toFixed(3)}m` +
        ` remoteUnderruns=${render.bufferUnderrunsPerSec.toFixed(1)}/s` +
        ` ballBuffer=${render.ballInterpolationBufferSize}` +
        ` activeMeshes=${activeMeshes}`
      );
    }

    this.perfReportTimer = 0;
    this.perfReportFrameCount = 0;
    this.perfReportInputCount = 0;
    this.perfReportFrameMsTotal = 0;
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
      // Prune ack-time bookkeeping for seqs older than the pending buffer window.
      for (const seq of this.sentInputClientTimeBySeq.keys()) {
        if (seq < ack - PENDING_INPUT_LIMIT) this.sentInputClientTimeBySeq.delete(seq);
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
    // Backflip view animation: add a full backward pitch rotation over the flip so the first-person
    // view tumbles with the move. Driven by the predicted backflip timer so it stays in sync with
    // the authoritative state. Offline mode applies the same offset in PlayerController.updateLook.
    this.player.camera.rotation.x = this.networkPitch + backflipPitchOffset(internal.backflipActive, internal.backflipTimer);
    this.player.camera.rotation.y = 0;
    this.player.camera.rotation.z = 0;
    // Crouch/slide lowers the eye height so the view follows the (shortened) body. Online mode
    // skips the offline MovementController, so the camera Y must be driven here from the predicted
    // crouch state. Smoothed exponentially toward the target so it dips/rises instead of snapping.
    this.applyCrouchCameraHeight(movement.crouching || movement.sliding);
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

  /**
   * Smoothly move the local camera's local-Y between standing and crouched eye height. Uses an
   * exponential approach with the real frame delta so the dip is framerate-independent and reads as
   * a quick, natural crouch rather than a teleport.
   */
  private applyCrouchCameraHeight(lowered: boolean): void {
    const stand = TUNING.player.eyeHeight;
    const crouch = TUNING.player.eyeHeight * TUNING.player.crouchHeightMultiplier;
    const target = lowered ? crouch : stand;
    const frameDt = Math.min(this.scene.getEngine().getDeltaTime() / 1000, TUNING.simulation.maxDeltaSeconds);
    // ~18/s smoothing rate matches the viewmodel's feel; 1 - e^(-k*dt) is the stable per-frame step.
    const k = 1 - Math.exp(-18 * frameDt);
    const current = this.player.camera.position.y;
    this.player.camera.position.y = current + (target - current) * k;
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

    // Dev diagnostic — gated behind strafeball.debug.net so playtests stay quiet.
    if (isNetDebugEnabled()) {
      const writers = [...this.localPositionWritersThisSecond].sort();
      console.log(`[net/local-writers] ${writers.length > 0 ? writers.join(',') : 'none'}`);
    }
    this.localPositionWritersThisSecond.clear();
  }

  private logOnlineRates(dt: number): void {
    if (!this.onlineModeActive) return;
    this.onlineRateLogTimer += dt;
    if (this.onlineRateLogTimer < 1.0) return;

    // Gated behind strafeball.debug.net so playtests stay quiet. The counters below are still
    // reset every second regardless so they never accumulate across the off period.
    if (isNetDebugEnabled()) {
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
        ` latestSnapshotAge=${renderStats.latestSnapshotAgeMs}ms` +
        ` underruns=${renderStats.bufferUnderrunsPerSec.toFixed(1)}/s` +
        ` overruns=${renderStats.bufferOverrunsPerSec.toFixed(1)}/s` +
        ` interpAvgMs=${renderStats.avgSnapshotIntervalMs.toFixed(1)}` +
        ` interpMaxMs=${renderStats.maxSnapshotIntervalMs.toFixed(1)}`
      );
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
    // Mats start upright online; server mat state then drives them via applyOnlineMats.
    this.gym.resetMats();
    this.knockedNetMatIds.clear();
    this.netCollisionBoxes = createPlayerCollisionBoxes();
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
    // Restore upright mats + their player collision when returning to practice.
    this.gym.resetMats();
    this.knockedNetMatIds.clear();
  }

  private resetPrediction(reason = 'reset'): void {
    if ((this.inputSeq > 0 || this.pendingInputs.length > 0) && isNetDebugEnabled()) {
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
    // Drop any in-flight catch attempt across a prediction reset (enter/exit online, server reset).
    this.pendingCatchAttemptId.left = 0;
    this.pendingCatchAttemptId.right = 0;
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
    this.perfReportTimer = 0;
    this.perfReportFrameCount = 0;
    this.perfReportInputCount = 0;
    this.perfReportFrameMsTotal = 0;
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

  /**
   * Push the authoritative blue/red scores to the 3D end-wall scoreboards each frame. setScores
   * buzzes the boards automatically when a number increases (i.e. when a player gets hit). During
   * the countdown the boards show the ticking number; on a win they show the winner banner.
   */
  private updateOnlineScoreboards(snapshot: ServerSnapshot): void {
    const match = snapshot.room.match;
    const blue = match.scoreByTeamId.blue ?? 0;
    const red = match.scoreByTeamId.red ?? 0;
    let label = '';
    if (match.status === 'countdown') label = String(Math.max(1, Math.ceil(match.countdownSeconds)));
    else if (match.winnerTeamId) label = `${match.winnerTeamId.toUpperCase()} WINS`;
    this.gym.setScoreboardScores(blue, red, label);
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

  /**
   * Reset detection — runs at the TOP of the frame, before reconcile/prediction. Keyed on
   * resetSerial so a room reset is caught exactly once regardless of tick values. On a fresh
   * reset it hard-clears prediction (so the next reconcile adopts the spawn state cleanly), clears
   * hand/charge state, and snaps the interpolation buffers via lastResetSerial bookkeeping.
   */
  private detectServerReset(snapshot: ServerSnapshot): void {
    const serial = snapshot.room.resetVote.resetSerial;
    if (this.lastResetSerial < 0) {
      // First snapshot of this session: adopt the baseline serial without firing a reset.
      this.lastResetSerial = serial;
      return;
    }
    if (serial === this.lastResetSerial) return;

    this.lastResetSerial = serial;
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

  /** Reset-vote HUD feedback only (the reset action itself is handled by detectServerReset). */
  private handleOnlineResetEvents(snapshot: ServerSnapshot): void {
    const vote = snapshot.room.resetVote;
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
    // During the pre-round countdown the player is frozen to look-only: send a neutral input that
    // carries just the fresh yaw/pitch (and sequence/time), so movement/combat are inert but the
    // seq stream + reconciliation keep advancing. The server also pins the player at spawn.
    if (this.countdownActive) {
      const frozen = neutralNetInput(this.networkYaw, this.networkPitch);
      frozen.sequence = this.inputSeq;
      frozen.clientTimeMs = Date.now();
      return frozen;
    }
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
      rightHandReleased: this.latchRightHandReleased,
      // Latched catch-attempt ids (0 = none pending). Re-sent every packet until the server acks.
      leftCatchAttemptId: this.pendingCatchAttemptId.left,
      rightCatchAttemptId: this.pendingCatchAttemptId.right
    };
  }

  private sendOnlineHandActions(dt: number, local: PlayerState): void {
    this.updateOnlineHandAction('left', MOUSE_BUTTON.leftHand, dt, this.input.isMouseDown(MOUSE_BUTTON.leftHand), local);
    this.updateOnlineHandAction('right', MOUSE_BUTTON.rightHand, dt, this.input.isMouseDown(MOUSE_BUTTON.rightHand), local);
  }

  private syncOnlineViewmodelHands(local: PlayerState | null): void {
    for (const side of ['left', 'right'] as const) {
      const serverHand = local?.hands[side];
      const visualHand = this.player.hands.getHand(side);
      const serverHolding = !!serverHand?.heldBallId;
      const releaseAnimating = visualHand.throwAnim > 0;
      const fakeAnimating = visualHand.fakeAnim > 0;
      const localCharging = this.onlineCharging[side] && serverHolding;
      const serverCharging = serverHolding && serverHand?.mode === 'charging';
      const charging = !releaseAnimating && !fakeAnimating && (localCharging || serverCharging);
      const chargeSeconds = localCharging
        ? this.onlineChargeSeconds[side]
        : serverHand?.chargeSeconds ?? 0;

      this.player.hands.syncVisualState(side, serverHolding && !releaseAnimating, charging, chargeSeconds);
    }
  }

  private updateOnlineHandAction(
    side: 'left' | 'right',
    button: number,
    dt: number,
    mouseDown: boolean,
    local: PlayerState
  ): void {
    const hand = local.hands[side];
    const pressed = this.input.wasMousePressed(button);
    const released = this.input.wasMouseReleased(button);

    // Stop re-latching an attempt once the server has acknowledged it (ack travels in hand state).
    if (this.pendingCatchAttemptId[side] !== 0 && hand.lastCatchAttemptId >= this.pendingCatchAttemptId[side]) {
      this.pendingCatchAttemptId[side] = 0;
    }

    if (!hand.heldBallId) {
      this.onlineCharging[side] = false;
      this.onlineChargeSeconds[side] = 0;
      // Empty-hand click = a server-authoritative timed CATCH attempt. Assign a fresh latched id
      // (carried on every input packet until acked) and play instant local catch feedback. The
      // server decides success against history; the client never decides the catch itself.
      if (pressed) {
        this.pendingCatchAttemptId[side] = this.nextCatchAttemptId;
        this.nextCatchAttemptId += 1;
        this.effects.onCatchAttempt(side);
      }
      return;
    }

    if (this.onlineCharging[side] && this.input.wasKeyPressed(CONTROL_KEYS.fakeThrow)) {
      this.player.hands.playFakeThrowAnimation(side, this.onlineChargeSeconds[side] / TUNING.ball.maxChargeSeconds);
      this.onlineCharging[side] = false;
      this.onlineChargeSeconds[side] = 0;
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
      // The release itself is sent through PlayerInput.left/rightHandReleased this same fixed tick.
      // Play instant local feedback while the server-authoritative throw event follows shortly after.
      this.effects.playerThrow();
      this.player.hands.playThrowAnimation(side);
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

function vector3ToVec3(v: Vector3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * Net-debug gate for the chatty per-frame/per-packet console logs ([net/input/send], [net/pos],
 * [net/local-writers], [net/rates]). OFF by default so playtests stay quiet; enable out-of-band
 * with `localStorage.setItem('strafeball.debug.net', '1')`. Wrapped in try/catch like
 * NetworkRenderer's isNetworkRenderDebugEnabled so a sandboxed/denied localStorage never throws.
 */
function isNetDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.net') === '1';
  } catch {
    return false;
  }
}

/**
 * Perf-line gate. Defaults ON (mirrors the server PERF_DEBUG default) so the throttled 5 s client
 * [perf] line shows during playtests; silence it explicitly with
 * `localStorage.setItem('strafeball.debug.perf', '0')`. try/catch so a denied localStorage can't throw.
 */
function isPerfDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.perf') !== '0';
  } catch {
    return true;
  }
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
    rightHandReleased: false,
    leftCatchAttemptId: 0,
    rightCatchAttemptId: 0
  };
}
