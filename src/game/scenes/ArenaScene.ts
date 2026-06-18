import { Engine, HemisphericLight, Mesh, Scene, Vector3 } from '@babylonjs/core';
import { InputManager } from '../input/InputManager';
import { PlayerController } from '../player/PlayerController';
import { GymArena } from '../map/GymArena';
import { ModelLoader } from '../assets/ModelLoader';
import { BallManager } from '../ball/BallManager';
import { BallVisualEffects } from '../ball/BallVisualEffects';
import { BallState } from '../ball/BallState';
import { Hud } from '../ui/Hud';
import { BackflipQteController } from '../player/BackflipQteController';
import { BackflipQteHud } from '../ui/BackflipQteHud';
import { backflipQteSpeed } from '../../../shared/simulation/ThrowMath';
import { GAME_CONSTANTS } from '../../../shared/constants';
import { SettingsPanel } from '../ui/SettingsPanel';
import { MatchRules } from '../rules/MatchRules';
import { TUNING } from '../config/tuning';
import { CONTROL_KEYS, MOUSE_BUTTON } from '../config/controls';
import { SoundManager } from '../audio/SoundManager';
import { Effects } from '../effects/Effects';
import { PracticeBot } from '../bot/PracticeBot';
import { PracticeControlWall } from '../practice/PracticeControlWall';
import { LobbyModePortals } from '../practice/LobbyModePortals';
import type { LobbyMode } from '../practice/LobbyModePortals';
import { GuideWall } from '../practice/GuideWall';
import { createPracticeState } from '../practice/PracticeState';
import type { PracticeState } from '../practice/PracticeState';
import { settings } from '../config/Settings';
import { MultiplayerClient } from '../network/MultiplayerClient';
import { MultiplayerOverlay } from '../network/MultiplayerOverlay';
import { NetworkRenderer } from '../network/NetworkRenderer';
import { OnlineTeamSelectorPads } from '../network/OnlineTeamSelectorPads';
import {
  onlineHandInputLooksEmpty,
  shouldClearPendingOnlineThrowRelease,
  type PendingOnlineThrowRelease
} from '../network/OnlineHandIntent';
import type { CatchEvent, HitEvent, HitRevertEvent, ParryEvent, ServerSnapshot } from '../../../shared/protocol';
import type { DashState, MovementInternalState, PlayerInput, PlayerMovementState, PlayerState, Vec3 } from '../../../shared/types';
import { stepMovement, facingFromAngles } from '../../../shared/simulation/MovementSim';
import { grantDashCharge } from '../../../shared/simulation/PlayerSim';
import { backflipPitchOffset } from '../../../shared/simulation/AimMath';
import {
  CLIENT_FIXED_DT,
  CLIENT_INPUT_RATE,
  MAX_ACCUMULATOR_STEPS,
  PENDING_INPUT_LIMIT,
  PERF_REPORT_INTERVAL_MS,
  SNAPSHOT_RATE
} from '../../../shared/netConfig';
import { createPlayerCollisionBoxes, type AABB } from '../../../shared/simulation/MapGeometry';
import { isIllegalHalfCourtPosition } from '../../../shared/simulation/RuleSim';
import { sweptBallHitsBody } from '../../../shared/simulation/CollisionMath';
import { playerBallHitRadius, playerHitCapsule } from '../../../shared/simulation/PlayerHitbox';
import { cameraForward } from '../utils/vector';

type PendingOnlineScoreEvent = { teamId: string; score: number; delta: number; dueAtMs: number };
const BALL_BOUNCE_GAIN = 0.42 * 0.7;
const BALL_BOUNCE_DECAY = 0.72;
const MIN_BALL_BOUNCE_GAIN = 0.00001;
const BALL_IMPACT_FX_MIN_SPEED = 8;
const AUDIO_UP = { x: 0, y: 1, z: 0 };

export class ArenaScene {
  public readonly scene: Scene;

  private readonly input: InputManager;
  private readonly ballManager: BallManager;
  private readonly player: PlayerController;
  private readonly hud: Hud;
  private readonly rules = new MatchRules();
  private readonly targetDummies: Mesh[] = [];
  private readonly sound: SoundManager;
  private readonly ballVisualEffects: BallVisualEffects;
  private readonly effects: Effects;
  private readonly quickBot: PracticeBot;
  private readonly chargeBot: PracticeBot;
  private readonly practiceWall: PracticeControlWall;
  private readonly lobbyModePortals: LobbyModePortals;
  private readonly guideWall: GuideWall;
  private readonly practiceState: PracticeState = createPracticeState();
  private readonly settingsPanel: SettingsPanel;
  private readonly gym: GymArena;
  private readonly multiplayer = new MultiplayerClient();
  private readonly multiplayerOverlay: MultiplayerOverlay;
  private readonly networkRenderer: NetworkRenderer;
  private readonly onlineTeamSelector: OnlineTeamSelectorPads;
  // Backflip landing quick-time event: armed when the local player lands from a backflip holding a
  // ball; resolving it throws (tiered speed). Owned here so it works in both offline and online.
  private readonly backflipQte = new BackflipQteController();
  private readonly backflipQteHud: BackflipQteHud;
  // Latched while a backflip jump is in the air: set when a backflip STARTS, cleared when the player
  // next touches the ground (the landing that arms the QTE). The backflip "active" flag clears after
  // ~0.72s — well before you land — so we can't edge-detect on it directly; this latch survives until
  // the real landing.
  private backflipJumpPending = false;
  private prevBackflipActiveForQte = false;
  // Online only: a resolved QTE tier waiting to ride the next throw-release input packet (0 = none).
  private pendingBackflipTier = 0;

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
  private readonly pendingOnlineThrowRelease: Record<'left' | 'right', PendingOnlineThrowRelease | null> = { left: null, right: null };
  // Catch-attempt ids (server-authoritative timed catch). A click on an EMPTY hand assigns a fresh
  // id; the latched id is stamped on every input packet (so the trigger survives packet loss) until
  // the server's hand.lastCatchAttemptId catches up, at which point we stop re-sending it.
  private nextCatchAttemptId = 1;
  private readonly pendingCatchAttemptId: Record<'left' | 'right', number> = { left: 0, right: 0 };
  private readonly recentCatchAttemptBySide: Record<'left' | 'right', { id: number; openedAtMs: number } | null> = { left: null, right: null };
  private readonly lastOnlineHeldBallId: Record<'left' | 'right', string | null> = { left: null, right: null };
  // True while the authoritative match is in its pre-round countdown: local input is frozen to look
  // only (movement/combat zeroed) and the HUD shows the countdown. Driven by the snapshot.
  private countdownActive = false;
  private lastOnlineScoreByTeamId: Record<string, number> = {};
  private pendingOnlineScoreEvents: PendingOnlineScoreEvent[] = [];
  private lastOnlineWinnerTeamId: string | null = null;
  private readonly lastOnlineBallBounceCount = new Map<string, number>();
  private lastResetSerial = -1;
  private lastResetVoteKey = '';

  // --- Client-side prediction & reconciliation ---
  // The local player is simulated via the SAME shared movement sim the server runs, at a fixed
  // timestep with sequence-numbered inputs. Each snapshot reconciles: adopt the authoritative
  // state, then replay inputs the server hasn't acknowledged yet.
  // Client prediction collision set. Mirrors the server's player collision (bleachers + standing
  // mats); rebuilt from snapshot mat state when a mat is knocked over so prediction stays in sync.
  private netCollisionBoxes: AABB[] = createPlayerCollisionBoxes();
  private readonly netCollisionScratch: AABB[] = [];
  // Set of mat ids currently reflected in netCollisionBoxes — avoids rebuilding every frame.
  private readonly knockedNetMatIds = new Set<string>();
  // Offline practice: hold-E progress (seconds) toward standing the nearest knocked-over mat back
  // up. Resets whenever E is released or the player leaves the mat's reach.
  private matRestoreHold = 0;
  private static readonly MAT_RESTORE_HOLD_SECONDS = 0.6;
  // Fixed timestep for input send + prediction + reconciliation replay. Driven entirely by the
  // shared net config (must equal the server's fixed dt for reconciliation residual ≈ 0). The
  // fixed-step loop below sends at the active CLIENT_INPUT_RATE.
  private static readonly NET_FIXED_DT = CLIENT_FIXED_DT;
  private static readonly RECONCILE_SNAP_THRESHOLD_M = 0.5;
  private static readonly DESYNC_TRACKER_SECONDS = 5;
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
  private desyncSmoothedM = 0;
  private desyncRecentMaxM = 0;
  private desyncPeakM = 0;
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
  private onlineModeStartedAtMs = 0;
  private perfReportTimer = 0;
  private perfReportFrameCount = 0;
  private perfReportInputCount = 0;
  private perfReportFrameMsTotal = 0;
  private perfReportCorrectionCount = 0;
  private perfReportSnapCount = 0;
  private perfReportMaxCorrectionM = 0;
  private footstepTimer = 0;
  private squeakCooldown = 0;
  private lastGroundMoveDir: Vec3 = { x: 0, y: 0, z: 1 };
  private lastGroundSpeed = 0;

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
    this.sound = new SoundManager();
    this.ballVisualEffects = new BallVisualEffects(this.scene);

    // Balls collide with bleachers only (mats are immune to balls — they pass through).
    this.ballManager = new BallManager(loader, this.gym.ballCollision, (speed, bounceCount, position) => {
      if (speed >= BALL_IMPACT_FX_MIN_SPEED) this.ballVisualEffects.spawnImpact(position, speed);
      this.playBallBounceSound(speed, bounceCount, position);
    }, this.ballVisualEffects);
    this.ballManager.spawnCenterLineBalls();

    this.effects = new Effects(this.scene, this.sound);

    this.player = new PlayerController(this.scene, this.input, this.ballManager, this.gym.collision, this.effects);
    this.quickBot = new PracticeBot(this.scene, this.ballManager, 'quick');
    this.chargeBot = new PracticeBot(this.scene, this.ballManager, 'charge');
    this.practiceWall = new PracticeControlWall(this.scene, this.practiceState, this.ballManager, (id) => this.handleButtonPress(id));
    this.lobbyModePortals = new LobbyModePortals(this.scene);
    this.guideWall = new GuideWall(this.scene);

    const hudRoot = document.getElementById('hud-root');
    if (!hudRoot) throw new Error('Missing HUD root.');
    this.hud = new Hud(hudRoot);
    this.backflipQteHud = new BackflipQteHud(hudRoot);
    this.settingsPanel = new SettingsPanel();
    this.multiplayerOverlay = new MultiplayerOverlay(this.multiplayer);
    this.networkRenderer = new NetworkRenderer(this.scene, this.ballVisualEffects);
    this.onlineTeamSelector = new OnlineTeamSelectorPads(this.scene);
  }

  update(): void {
    const engine = this.scene.getEngine();
    // One simulation step per rendered frame. dt is clamped so a long hitch (alt-tab, GC)
    // can't produce a huge step that tunnels through collision. Because input edges are
    // consumed in this same single step, no clicks/presses get dropped (unlike the old
    // fixed-step substep loop, which discarded edges on frames that ran zero substeps).
    const frameMs = engine.getDeltaTime();
    const dt = Math.min(frameMs / 1000, TUNING.simulation.maxDeltaSeconds);

    if (this.input.wasKeyPressed(CONTROL_KEYS.toggleDebug)) {
      this.hud.toggleDebug();
    }

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
            snapshotRateHz: this.multiplayer.snapshotDebug.receivedPerSecond,
            renderSnapshotRateHz: this.snapshotRateHz,
            inputSeq: this.inputSeq,
            lastAckedSeq: this.multiplayer.latestSnapshot.room.players[this.multiplayer.localPlayerId]?.lastProcessedInputSeq ?? 0,
            pendingInputs: this.pendingInputs.length,
            predictionErrorM: this.predictionErrorM,
            residualAfterReplayM: this.residualAfterReplayM,
            expectedLeadM: this.expectedLeadM,
            desyncAverageM: this.desyncSmoothedM,
            desyncRecentMaxM: this.desyncRecentMaxM,
            desyncPeakM: this.desyncPeakM,
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
    this.onlineTeamSelector.dispose();
    this.settingsPanel.dispose();
    this.ballManager.clear();
    this.ballVisualEffects.dispose();
    this.quickBot.dispose();
    this.chargeBot.dispose();
    this.practiceWall.dispose();
    this.lobbyModePortals.dispose();
    this.guideWall.dispose();
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
      if (ball.state !== BallState.Live || (ball.owner !== 'bot' && ball.owner !== 'launcher')) continue;
      const b = ball.mesh.position;
      // Swept capsule (ball path this tick vs the player's body axis) so fast lobs that cross the
      // body between frames still register, and high throws count as head hits.
      const prev = { x: b.x - ball.velocity.x * dt, y: b.y - ball.velocity.y * dt, z: b.z - ball.velocity.z * dt };
      if (!sweptBallHitsBody(prev, b, hitbox.base, hitbox.top, radius)) continue;

      const v = ball.velocity;
      const speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
      ball.makeDead();
      this.effects.onPlayerHit(b, speed);
      this.ballVisualEffects.spawnImpact(b, speed);
      this.hud.showHitMarker('bad');
    }
  }

  /**
   * Offline backflip QTE: arm on landing from a backflip while holding a ball, advance the timing
   * bar, and on the throw-button click resolve a success tier (→ tiered backflip throw) or a miss
   * (→ no throw, keep the ball). Drives the QTE bar HUD.
   */
  private updateBackflipQteOffline(dt: number, grounded: boolean): void {
    const active = this.player.backflip.active;
    // Latch the jump on the backflip's rising edge; it stays pending through the whole flight even
    // after `active` clears (~0.72s), until we actually land.
    if (active && !this.prevBackflipActiveForQte) this.backflipJumpPending = true;
    this.prevBackflipActiveForQte = active;

    // Landing: a pending backflip jump just touched the ground → arm the QTE if holding a ball.
    if (this.backflipJumpPending && grounded && !active) {
      this.backflipJumpPending = false;
      if (this.player.hands.backflipThrowHand() && !this.backflipQte.isActive()) {
        this.backflipQte.arm();
      }
    }

    // A backflip whose ball was lost (dropped/knocked) before landing can't be thrown — cancel.
    if (this.backflipQte.isActive() && !this.player.hands.backflipThrowHand()) {
      this.backflipQte.cancel();
    }

    if (!this.backflipQte.isActive()) {
      if (!this.backflipQteHud.isFlashing()) this.backflipQteHud.hide();
      return;
    }

    // Still in the post-landing pre-roll delay: tick it down, keep the bar hidden, ignore clicks.
    if (!this.backflipQte.isSweeping()) {
      this.backflipQte.update(dt);
      if (!this.backflipQteHud.isFlashing()) this.backflipQteHud.hide();
      return;
    }

    // Resolve a click before advancing the timer so the offset reflects the frame the player clicked.
    if (this.input.wasMousePressed(MOUSE_BUTTON.leftHand) || this.input.wasMousePressed(MOUSE_BUTTON.rightHand)) {
      const result = this.backflipQte.resolveClick();
      if (result.kind === 'hit') {
        const side = this.player.hands.backflipThrowHand();
        if (side) this.player.hands.throwBackflipQte(side, this.player.lastMovementSnapshot, result.tier);
        this.onBackflipQteHit(result.tier);
      } else {
        this.backflipQteHud.flashResult(false);
      }
      return;
    }

    const lapse = this.backflipQte.update(dt);
    if (lapse) {
      this.backflipQteHud.flashResult(false); // timed out → no throw, keep ball
      return;
    }

    this.backflipQteHud.show();
    this.backflipQteHud.setPointer(this.backflipQte.currentOffset());
  }

  /** Shared success feedback for a backflip-QTE hit (offline + online): sound, gold flash, popup. */
  private onBackflipQteHit(tier: number): void {
    const maxTier = TUNING.backflip.qte.tierCount;
    const strength = maxTier > 1 ? (tier - 1) / (maxTier - 1) : 1;
    if (tier >= maxTier) this.grantLocalStamina();
    this.effects.onBackflipThrow(tier, maxTier);
    this.backflipQteHud.flashResult(true);
    const labels = ['SLOW', 'OK', 'NICE', 'GREAT', 'PERFECT!'];
    const label = labels[Math.max(0, Math.min(labels.length - 1, tier - 1))];
    this.hud.showQteEvent(label, 'BACKFLIP THROW', strength);
  }

  private grantLocalStamina(): void {
    this.player.dash.addChargeFromHit();
    if (this.predictedDash) {
      this.predictedDash = grantDashCharge(this.predictedDash);
    }
  }

  /** Clear all backflip-QTE state + hide the bar (used on mode transitions and resets). */
  private resetBackflipQte(): void {
    this.backflipQte.cancel();
    this.backflipQteHud.hide();
    this.backflipJumpPending = false;
    this.prevBackflipActiveForQte = false;
    this.pendingBackflipTier = 0;
  }

  /**
   * Online backflip QTE: same timing/HUD as offline, but the throw is released through the input
   * stream. On a hit we latch a hand-release + the QTE tier onto the next packet; the server
   * re-validates the backflip and applies the tiered speed. Returns true while the QTE is active so
   * the caller suppresses the normal hand action (the click must not start a charge). The local
   * held-ball state is read from the authoritative snapshot (`local.hands`).
   */
  private updateBackflipQteOnline(dt: number, local: PlayerState | null): boolean {
    const internal = this.predictedInternal;
    const movement = this.predictedMovement;
    if (!internal || !movement || !local) {
      this.backflipQte.cancel();
      this.backflipJumpPending = false;
      this.prevBackflipActiveForQte = false;
      if (!this.backflipQteHud.isFlashing()) this.backflipQteHud.hide();
      return false;
    }

    const heldHand: 'left' | 'right' | null =
      local.hands.left.heldBallId ? 'left' : local.hands.right.heldBallId ? 'right' : null;
    const active = internal.backflipActive;

    // Latch on the backflip's rising edge; arm on the landing that follows (active clears mid-air).
    if (active && !this.prevBackflipActiveForQte) this.backflipJumpPending = true;
    this.prevBackflipActiveForQte = active;

    if (this.backflipJumpPending && movement.grounded && !active) {
      this.backflipJumpPending = false;
      if (heldHand && !this.backflipQte.isActive()) this.backflipQte.arm();
    }

    if (this.backflipQte.isActive() && !heldHand) this.backflipQte.cancel();

    if (!this.backflipQte.isActive()) {
      if (!this.backflipQteHud.isFlashing()) this.backflipQteHud.hide();
      return false;
    }

    // While the QTE owns the click, never let it leak into the normal charge/throw latches.
    this.latchLeftHandPressed = false;
    this.latchRightHandPressed = false;

    // Still in the post-landing pre-roll delay: tick it down, keep the bar hidden, ignore clicks.
    if (!this.backflipQte.isSweeping()) {
      this.backflipQte.update(dt);
      if (!this.backflipQteHud.isFlashing()) this.backflipQteHud.hide();
      return true;
    }

    if (this.input.wasMousePressed(MOUSE_BUTTON.leftHand) || this.input.wasMousePressed(MOUSE_BUTTON.rightHand)) {
      const result = this.backflipQte.resolveClick();
      if (result.kind === 'hit' && heldHand) {
        // Latch the release for the holding hand + the tier; the input packet carries both this tick.
        // The server allows a backflip-tier release straight from a holding hand (no charge needed).
        if (heldHand === 'left') this.latchLeftHandReleased = true;
        else this.latchRightHandReleased = true;
        this.pendingBackflipTier = result.tier;
        this.player.hands.playThrowAnimation(heldHand);
        this.onBackflipQteHit(result.tier);
      } else {
        this.backflipQteHud.flashResult(false);
      }
      return true;
    }

    const lapse = this.backflipQte.update(dt);
    if (lapse) {
      this.backflipQteHud.flashResult(false);
      return false;
    }

    this.backflipQteHud.show();
    this.backflipQteHud.setPointer(this.backflipQte.currentOffset());
    return true;
  }

  /**
   * Offline: knock a standing mat flat when the local player walks into it (mirrors the server's
   * contact-based rule). A downed mat's collision box is spliced out of BOTH worlds so it becomes
   * walkable and balls pass over it. Holding E next to a downed mat stands it back up.
   */
  private updateOfflineMats(dt: number): void {
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
      // what was added to the collision worlds). Then it no longer blocks movement or balls.
      this.gym.removeMatCollision(mat);
      mat.knockOver(dir.lengthSquared() > 1e-4 ? dir : new Vector3(toMatX, 0, toMatZ));
    }

    this.updateMatRestore(dt);
  }

  /**
   * Offline: hold E next to a knocked-over mat to stand it back up. We pick the nearest downed mat
   * within an arm's-reach radius (measured from its original standing footprint) and accumulate a
   * hold timer; releasing E or stepping away cancels it. On completion the mat re-enters both
   * collision worlds so it blocks players and balls again.
   */
  private updateMatRestore(dt: number): void {
    if (!this.input.isKeyDown(CONTROL_KEYS.interact)) {
      this.matRestoreHold = 0;
      return;
    }

    const p = this.player.root.position;
    const restoreReach = TUNING.player.radius + 1.0; // generous: a flattened mat sits on the floor
    let nearest: typeof this.gym.mats[number] | null = null;
    let nearestDist = Infinity;
    for (const mat of this.gym.mats) {
      if (!mat.knockedOver) continue;
      const box = mat.getAABB(); // standing footprint center is a stable proximity anchor
      const mx = (box.minX + box.maxX) * 0.5;
      const mz = (box.minZ + box.maxZ) * 0.5;
      const d = (p.x - mx) * (p.x - mx) + (p.z - mz) * (p.z - mz);
      if (d < nearestDist) { nearestDist = d; nearest = mat; }
    }

    if (!nearest || nearestDist > restoreReach * restoreReach) {
      this.matRestoreHold = 0;
      return;
    }

    this.matRestoreHold += dt;
    if (this.matRestoreHold >= ArenaScene.MAT_RESTORE_HOLD_SECONDS) {
      this.matRestoreHold = 0;
      nearest.reset();
      this.gym.addMatCollision(nearest);
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
        // Drop the mat's ball-collision box BEFORE tipping it (getAABB returns the standing
        // footprint that was registered), so balls pass over the downed mat.
        this.gym.removeMatCollision(mat);
        mat.knockOver(new Vector3(state.knockDirection.x, 0, state.knockDirection.z));
        this.knockedNetMatIds.add(mat.id);
        knockedChanged = true;
      } else if (!state.knockedOver && mat.knockedOver) {
        // Server reset the mat (e.g. room reset): stand it back up and restore its ball-collision
        // box so dodgeballs bounce off it again.
        mat.reset();
        this.gym.addMatCollision(mat);
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

    // Suppress normal throws while a backflip is airborne or the landing QTE is pending — the
    // backflip throw is released only by the QTE click.
    // Suppress normal throws for the whole backflip arc: from launch (active), through the fall
    // (jump pending after `active` clears mid-air), until the landing QTE resolves. The backflip
    // throw is released only by the QTE click.
    const throwsSuppressed = this.player.backflip.active || this.backflipJumpPending || this.backflipQte.isActive();
    this.player.update(dt, throwsSuppressed);

    const snap = this.player.lastMovementSnapshot;

    // Fire one-shot effects on state transitions so every slide/dash/backflip has audio+visual.
    if (!wasSliding && snap.sliding) this.effects.onSlide(snap.speed);
    if (snap.dashingThisFrame) this.effects.onDash(snap.speed);
    if (!wasBackflipActive && this.player.backflip.active) this.effects.onBackflip();

    this.prevSliding = snap.sliding;
    this.prevBackflipActive = this.player.backflip.active;

    this.updateBackflipQteOffline(dt, snap.grounded);

    // Practice bots — only active when enabled via control wall
    const playerPos = this.player.camera.globalPosition;
    if (this.quickBot.update(dt, playerPos)) this.effects.botThrow();
    if (this.chargeBot.update(dt, playerPos)) this.effects.botThrow();
    this.practiceWall.update(dt);
    this.lobbyModePortals.update(dt, this.player.root.position, this.input.isKeyDown(CONTROL_KEYS.interact), (mode) => this.openLobbyMode(mode));

    this.ballManager.setPickupHighlight(
      this.ballManager.findPickupLookCandidate(this.player.camera.globalPosition, cameraForward(this.player.camera))
    );
    this.ballManager.update(dt);
    this.checkBotHitsPlayer(dt);
    this.ballVisualEffects.update(dt);
    this.updateOfflineMats(dt);
    this.updateLocalMovementFoley(dt, vector3ToVec3(snap.velocity), snap.grounded, snap.sliding, snap.dashingThisFrame, snap.wallRunning);

    // Each landed hit grants the thrower one dash charge (locked rule).
    const hits = this.rules.scoring.updateAgainstDummies(this.ballManager.balls, this.targetDummies, dt);
    for (const hit of hits) {
      this.player.dash.addChargeFromHit();
      this.effects.onDummyHit(hit.speed);
      this.hud.showHitMarker('good');
    }
    if (hits.length > 0) {
      this.hud.showScoreEvent(`HIT +${hits.length}`, `${this.rules.scoring.playerHits} / ${TUNING.match.scoreLimit}`, 'good');
    }

    this.rules.boundary.update(dt, this.player.root.position);
    this.updateOfflineCourtLines();
    this.effects.update(dt);

    // Advance the moving dummy's oscillation + the live 3D scoreboards (offline shows practice score:
    // your dummy hits as BLUE, opponent penalty as RED; setScores buzzes them when a number ticks up).
    this.gym.update(this.elapsed);
    this.gym.setScoreboardScores(this.rules.scoring.playerHits, this.rules.boundary.opponentPenaltyHits);
    this.gym.updateScoreboards(dt);

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
    if (this.latchPickupPressed) {
      this.recentCatchAttemptBySide.left = null;
      this.recentCatchAttemptBySide.right = null;
    }

    const snapshot = this.multiplayer.latestSnapshot;
    const local = snapshot?.room.players[this.multiplayer.localPlayerId] ?? null;
    // Pre-round countdown gate: while the authoritative match is counting down, local input is
    // frozen to look-only (built in buildNetworkInput) so the player can't move/throw until GO.
    this.countdownActive = snapshot?.room.match.status === 'countdown';
    const teamSelectorConsumesInteract = this.onlineTeamSelector.update(
      dt,
      this.player.root.position,
      this.input.isKeyDown(CONTROL_KEYS.interact),
      snapshot?.room ?? null,
      this.multiplayer.localPlayerId,
      {
        chooseTeam: (teamId) => this.multiplayer.requestSwitchTeam(teamId),
        voteStart: () => this.multiplayer.requestStartVote()
      }
    );
    if (teamSelectorConsumesInteract) {
      this.latchPickupPressed = false;
      this.recentCatchAttemptBySide.left = null;
      this.recentCatchAttemptBySide.right = null;
    }

    // Backflip landing QTE (online): runs client-side; on a hit it latches a release + tier onto the
    // input stream (handled below) and suppresses the normal hand action so the click doesn't charge.
    const qteActive = this.updateBackflipQteOnline(dt, local);
    this.handleOnlineCatchSuccessAudio(local);

    // Hand edges are folded into the fixed input stream. Process them before building packets so
    // catch ids and throw releases ride the same ordered tick as crouch/look/charge state.
    if (local && !this.countdownActive && !qteActive && local.combatState !== 'eliminated') this.sendOnlineHandActions(dt, local);
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
    this.updateDesyncTracker(dt);

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
        input, prev, ArenaScene.NET_FIXED_DT, this.predictionCollisionBoxes(),
        this.deriveCatchStance(local, input),
        undefined,
        this.deriveOnlineMovementScale(local)
      );
      this.predictedMovement = res.movement;
      this.predictedInternal = res.internal;
      this.predictedDash = res.dash;

      this.pendingInputs.push({ seq: this.inputSeq, input, prev });
      if (this.pendingInputs.length > PENDING_INPUT_LIMIT) {
        const dropped = this.pendingInputs.shift();
        if (dropped) this.sentInputClientTimeBySeq.delete(dropped.seq);
      }

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
      // The QTE tier is one-shot: it rode this packet's release, so clear it now.
      this.pendingBackflipTier = 0;

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
      this.pruneSentInputClientTimes();
      if ((input.leftCatchAttemptId > 0 || input.rightCatchAttemptId > 0) && isCatchTraceDebugEnabled()) {
        console.log(
          `[catch/client] input-sent seq=${input.sequence}` +
          ` left=${input.leftCatchAttemptId} right=${input.rightCatchAttemptId}` +
          ` leftAck=${local?.hands.left.lastCatchAttemptId ?? 0} rightAck=${local?.hands.right.lastCatchAttemptId ?? 0}` +
          ` leftHeld=${local?.hands.left.heldBallId ?? 'none'} rightHeld=${local?.hands.right.heldBallId ?? 'none'}` +
          ` leftReleasePending=${this.pendingOnlineThrowRelease.left?.ballId ?? 'none'}` +
          ` rightReleasePending=${this.pendingOnlineThrowRelease.right?.ballId ?? 'none'}`
        );
      }
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
      if (!this.prevSliding && nowSliding) this.effects.onSlide(this.predictedMovement.speed);
      if (this.predictedMovement.dashingThisFrame) this.effects.onDash(this.predictedMovement.speed);
      if (!this.prevBackflipActive && nowBackflip) this.effects.onBackflip();
      this.prevSliding = nowSliding;
      this.prevBackflipActive = nowBackflip;
    }

    // Apply the shared-sim predicted position to the player root.
    // The camera is parented to root, so it follows automatically; look angles are untouched.
    if (this.predictedMovement && this.predictedInternal) {
      this.applyPredicted(this.predictedMovement, this.predictedInternal);
      this.updateLocalMovementFoley(
        dt,
        this.predictedMovement.velocity,
        this.predictedMovement.grounded,
        this.predictedMovement.sliding,
        this.predictedMovement.dashingThisFrame,
        this.predictedMovement.wallRunning
      );
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
      this.handleOnlineBallBounceAudio(snapshot);
      // Seed live-ball visual prediction from any throw events that arrived this frame BEFORE the
      // renderer update so a freshly-thrown ball predicts from its very first rendered frame.
      this.networkRenderer.applyThrowEvents(this.multiplayer.drainThrowEvents());
      const catchEvents = this.multiplayer.drainCatchEvents();
      this.handleOnlineCatchEvents(catchEvents);
      this.networkRenderer.applyCatchEvents(catchEvents);
      this.handleOnlineParryEvents(this.multiplayer.drainParryEvents(), snapshot);
      this.handleOnlineHitEvents(this.multiplayer.drainHitEvents(), snapshot);
      this.handleOnlineHitRevertEvents(this.multiplayer.drainHitRevertEvents());
      this.networkRenderer.update(snapshot, this.multiplayer.localPlayerId, dt, this.predictedMovement);
      this.applyOnlineMats(snapshot);
      this.handleOnlineScoreEvents(snapshot);
      this.flushPendingOnlineScoreEvents(snapshot);
      this.handleOnlineWinnerEvent(snapshot);
      this.updateOnlineScoreboards(snapshot);
      this.updateOnlineCourtLines(snapshot);
    }

    this.effects.update(dt);
    this.ballVisualEffects.update(dt);
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
      const roomAgeSec = this.onlineModeStartedAtMs > 0 ? (Date.now() - this.onlineModeStartedAtMs) / 1000 : 0;
      console.log(
        `[perf] roomAgeSec=${roomAgeSec.toFixed(1)}` +
        ` input=${CLIENT_INPUT_RATE}Hz snapshots=${SNAPSHOT_RATE}Hz` +
        ` fps=${fps.toFixed(1)} avgFrameMs=${avgFrameMs.toFixed(2)}` +
        ` inputSent=${(this.perfReportInputCount / elapsed).toFixed(1)}/s` +
        ` snapshotsRecv=${snap.receivedPerSecond.toFixed(1)}/s` +
        ` uniqueSnapshots=${snap.uniqueTicksPerSecond.toFixed(1)}/s` +
        ` renderSnapshots=${this.snapshotRateHz.toFixed(1)}/s` +
        ` snapMs avg=${snap.averageMsBetweenSnapshots.toFixed(1)} max=${snap.maxMsBetweenSnapshots.toFixed(1)}` +
        ` dupSnapshots=${snap.duplicateOrOutOfOrder} staleDropped=${snap.staleDropped}` +
        ` pendingInputs=${this.pendingInputs.length}` +
        ` rawServerLeadError=${this.predictionErrorM.toFixed(3)}m` +
        ` residualAfterReplay=${this.residualAfterReplayM.toFixed(3)}m` +
        ` desyncAvg=${this.desyncSmoothedM.toFixed(3)}m` +
        ` desyncRecentMax=${this.desyncRecentMaxM.toFixed(3)}m` +
        ` desyncPeak=${this.desyncPeakM.toFixed(3)}m` +
        ` corrections=${this.perfReportCorrectionCount} snaps=${this.perfReportSnapCount}` +
        ` oldestSnapshotAge=${render.oldestSnapshotAgeMs.toFixed(1)}ms` +
        ` renderDelay=${render.renderDelayMs.toFixed(1)}ms` +
        ` wsBuffered=${snap.socketBufferedAmount}B` +
        ` remoteUnderruns=${render.bufferUnderrunsPerSec.toFixed(1)}/s` +
        ` remoteOverruns=${render.bufferOverrunsPerSec.toFixed(1)}/s` +
        ` remoteSnaps=${render.remoteSnapCount}` +
        ` ballSnaps=${render.ballSnapCount}` +
        ` lastSnapReason=${render.lastCorrectionReason || 'none'}` +
        ` remoteBuffer=${render.remoteInterpolationBufferSize}` +
        ` ballBuffer=${render.ballInterpolationBufferSize}` +
        ` ballPredictions=${render.ballPredictionCount}` +
        ` ballPredictionCorrections=${render.ballPredictionCorrections}` +
        ` ballPredictionMaxCorrections=${render.ballPredictionMaxCorrections}` +
        ` ballPredictionMaxError=${render.ballPredictionMaxErrorM.toFixed(3)}m` +
        ` ballPredictionLastError=${render.ballPredictionLastErrorM.toFixed(3)}m` +
        ` ballPredictionSnaps=${render.ballPredictionSnapCount}` +
        ` ballPredictionSoft=${render.ballPredictionSoftCorrections}` +
        ` ballPredictionMedium=${render.ballPredictionMediumCorrections}` +
        ` ballPredictionSnapReasons=${formatCountMap(render.ballPredictionSnapReasonCounts)}` +
        ` activeMeshes=${activeMeshes}`
      );

      if (isSoakDebugEnabled()) {
        const heap = readJsHeapStats();
        console.log(
          `[soak] roomAgeSec=${roomAgeSec.toFixed(1)}` +
          ` ackAgeMs=${this.ackAgeMs() ?? -1}` +
          ` expectedLead=${this.expectedLeadM.toFixed(3)}m` +
          ` correctionsMax=${this.perfReportMaxCorrectionM.toFixed(3)}m` +
          ` interp={avgMs=${render.avgSnapshotIntervalMs.toFixed(1)} maxMs=${render.maxSnapshotIntervalMs.toFixed(1)} underruns=${render.bufferUnderrunsPerSec.toFixed(1)}/s overruns=${render.bufferOverrunsPerSec.toFixed(1)}/s}` +
          ` heap=${heap ?? 'n/a'}`
        );
      }
    }

    this.perfReportTimer = 0;
    this.perfReportFrameCount = 0;
    this.perfReportInputCount = 0;
    this.perfReportFrameMsTotal = 0;
    this.perfReportCorrectionCount = 0;
    this.perfReportSnapCount = 0;
    this.perfReportMaxCorrectionM = 0;
  }

  private updatePredictionDebugMetrics(local: PlayerState | null): void {
    if (!local || !this.predictedMovement) {
      this.predictionErrorM = 0;
      this.residualAfterReplayM = 0;
      this.expectedLeadM = 0;
      return;
    }

    this.predictionErrorM = distanceVec3(this.predictedMovement.position, local.movement.position);
    let unackedCount = 0;
    for (let i = 0; i < this.pendingInputs.length; i += 1) {
      if (this.pendingInputs[i].seq > local.lastProcessedInputSeq) unackedCount += 1;
    }
    this.expectedLeadM = this.predictedMovement.speed * unackedCount * ArenaScene.NET_FIXED_DT;

    const replayed = this.replayUnackedFromServer(local, local.lastProcessedInputSeq);
    this.residualAfterReplayM = replayed
      ? distanceVec3(this.predictedMovement.position, replayed.movement.position)
      : 0;
  }

  private updateDesyncTracker(dt: number): void {
    const current = this.residualAfterReplayM;
    const seconds = ArenaScene.DESYNC_TRACKER_SECONDS;
    const alpha = 1 - Math.exp(-Math.max(0, dt) / seconds);
    this.desyncSmoothedM += (current - this.desyncSmoothedM) * alpha;
    this.desyncRecentMaxM = Math.max(current, this.desyncRecentMaxM * (1 - alpha));
    this.desyncPeakM = Math.max(this.desyncPeakM, current);
  }

  private replayUnackedFromServer(
    local: PlayerState,
    lastProcessedInputSeq: number
  ): { movement: PlayerMovementState; internal: MovementInternalState; dash: DashState } | null {
    let movement = cloneMovement(local.movement);
    let internal = { ...local.movementInternal };
    let dash = { ...local.dash };

    for (let i = 0; i < this.pendingInputs.length; i += 1) {
      const entry = this.pendingInputs[i];
      if (entry.seq <= lastProcessedInputSeq) continue;
      const res = stepMovement(
        movement,
        internal,
        dash,
        entry.input,
        entry.prev,
        ArenaScene.NET_FIXED_DT,
        this.predictionCollisionBoxes(),
        this.deriveCatchStance(local, entry.input),
        undefined,
        this.deriveOnlineMovementScale(local)
      );
      movement = res.movement;
      internal = res.internal;
      dash = res.dash;
    }

    return { movement, internal, dash };
  }

  /** Adopt the authoritative snapshot, drop acknowledged inputs, then replay the unacked ones. */
  private reconcile(local: PlayerState): void {
    const correctionMeters = this.predictedMovement
      ? distanceVec3(this.predictedMovement.position, local.movement.position)
      : 0;
    if (correctionMeters > 0.001) {
      this.perfReportCorrectionCount += 1;
      this.perfReportMaxCorrectionM = Math.max(this.perfReportMaxCorrectionM, correctionMeters);
      if (correctionMeters >= ArenaScene.RECONCILE_SNAP_THRESHOLD_M) this.perfReportSnapCount += 1;
    }

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
        this.predictionCollisionBoxes(),
        this.deriveCatchStance(local, entry.input),
        undefined,
        this.deriveOnlineMovementScale(local)
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

  private deriveOnlineMovementScale(local: PlayerState | null): number {
    if (!local || local.combatState === 'eliminated') return 1;
    const snapshot = this.multiplayer.latestSnapshot;
    if (snapshot?.room.match.mode !== '2v2') return 1;
    return (local.lastPlayerBuffUntilMs ?? 0) > Date.now()
      ? TUNING.match.lastPlayerBuffMultiplier
      : 1;
  }

  private isLocalOnlineEliminated(): boolean {
    const snapshot = this.multiplayer.latestSnapshot;
    const local = snapshot?.room.players[this.multiplayer.localPlayerId];
    return local?.combatState === 'eliminated';
  }

  private predictionCollisionBoxes(): AABB[] {
    const snapshot = this.multiplayer.latestSnapshot;
    if (!snapshot || !hasEliminatedPlayers(snapshot)) return this.netCollisionBoxes;

    this.netCollisionScratch.length = 0;
    for (const box of this.netCollisionBoxes) this.netCollisionScratch.push(box);
    for (const player of Object.values(snapshot.room.players)) {
      if (player.id === this.multiplayer.localPlayerId) continue;
      if (player.connected === false) continue;
      if (player.combatState !== 'eliminated') continue;
      const pos = player.movement.position;
      const radius = TUNING.player.radius * 0.95;
      const height = TUNING.player.height * TUNING.player.crouchHeightMultiplier;
      this.netCollisionScratch.push({
        minX: pos.x - radius,
        maxX: pos.x + radius,
        minY: pos.y,
        maxY: pos.y + height,
        minZ: pos.z - radius,
        maxZ: pos.z + radius,
        id: `eliminated_${player.id}`
      });
    }
    return this.netCollisionScratch;
  }

  private pruneSentInputClientTimes(): void {
    const maxEntries = PENDING_INPUT_LIMIT * 2;
    while (this.sentInputClientTimeBySeq.size > maxEntries) {
      const oldest = this.sentInputClientTimeBySeq.keys().next().value;
      if (oldest === undefined) break;
      this.sentInputClientTimeBySeq.delete(oldest);
    }
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
    this.player.applyWallRunLean(ArenaScene.NET_FIXED_DT, movement.wallRunning, internal.lastWallNormalX, internal.lastWallNormalZ);
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
    const snap = this.player.lastMovementSnapshot;
    snap.position.set(p.x, p.y, p.z);
    snap.velocity.set(v.x, v.y, v.z);
    snap.grounded = movement.grounded;
    snap.sliding = movement.sliding;
    snap.crouching = movement.crouching;
    snap.wallRunning = movement.wallRunning;
    snap.wallNormal.set(internal.lastWallNormalX, 0, internal.lastWallNormalZ);
    snap.dashingThisFrame = movement.dashingThisFrame;
    snap.speed = movement.speed;
    snap.bhopGraceTimer = internal.jumpGraceTimer;
    snap.wallRunTimer = internal.wallRunTimer;
    snap.frictionMode = !movement.grounded
      ? 'air'
      : internal.dashActiveTimer > 0 && !movement.sliding
        ? 'dashSuppressed'
        : movement.sliding
          ? 'slide'
          : 'normal';
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
        ` unique=${snapshotDebug.uniqueTicksPerSecond.toFixed(1)}/s` +
        ` renderSeen=${this.snapshotRateHz.toFixed(1)}/s` +
        ` avgMs=${snapshotDebug.averageMsBetweenSnapshots.toFixed(1)}` +
        ` maxMs=${snapshotDebug.maxMsBetweenSnapshots.toFixed(1)}` +
        ` dup=${snapshotDebug.duplicateOrOutOfOrder}` +
        ` staleDropped=${snapshotDebug.staleDropped}` +
        ` inputPackets=${(this.onlineRateLogInputCount / elapsed).toFixed(1)}/s` +
        ` renderFps=${(this.onlineRateLogFrameCount / elapsed).toFixed(1)}` +
        ` remoteBuffer=${renderStats.remoteInterpolationBufferSize}` +
        ` ballBuffer=${renderStats.ballInterpolationBufferSize}` +
        ` renderDelay=${renderStats.renderDelayMs}ms` +
        ` latestSnapshotAge=${renderStats.latestSnapshotAgeMs}ms` +
        ` oldestSnapshotAge=${renderStats.oldestSnapshotAgeMs}ms` +
        ` wsBuffered=${snapshotDebug.socketBufferedAmount}B` +
        ` underruns=${renderStats.bufferUnderrunsPerSec.toFixed(1)}/s` +
        ` overruns=${renderStats.bufferOverrunsPerSec.toFixed(1)}/s` +
        ` interpAvgMs=${renderStats.avgSnapshotIntervalMs.toFixed(1)}` +
        ` interpMaxMs=${renderStats.maxSnapshotIntervalMs.toFixed(1)}` +
        ` ballPred=${renderStats.ballPredictionCount}` +
        ` ballPredErrMax=${renderStats.ballPredictionMaxErrorM.toFixed(3)}m` +
        ` ballPredErrLast=${renderStats.ballPredictionLastErrorM.toFixed(3)}m` +
        ` ballPredSnaps=${renderStats.ballPredictionSnapCount}`
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

  private resetOnlineCatchAudioTracking(): void {
    this.pendingCatchAttemptId.left = 0;
    this.pendingCatchAttemptId.right = 0;
    this.recentCatchAttemptBySide.left = null;
    this.recentCatchAttemptBySide.right = null;
    this.lastOnlineHeldBallId.left = null;
    this.lastOnlineHeldBallId.right = null;
    this.pendingOnlineThrowRelease.left = null;
    this.pendingOnlineThrowRelease.right = null;
  }

  private enterOnlineMode(): void {
    if (this.onlineModeActive) return;
    this.onlineModeActive = true;
    this.onlineModeStartedAtMs = Date.now();
    this.resetBackflipQte();
    this.networkYaw = this.player.root.rotation.y;
    this.networkPitch = this.player.camera.rotation.x;
    this.onlineCharging.left = false;
    this.onlineCharging.right = false;
    this.onlineChargeSeconds.left = 0;
    this.onlineChargeSeconds.right = 0;
    this.resetPrediction('enter-online');
    this.player.hands.clearHands();
    this.quickBot.reset();
    this.chargeBot.reset();
    this.setPracticePropsEnabled(false);
    this.ballManager.clear();
    // Mats start upright online; server mat state then drives them via applyOnlineMats.
    this.gym.resetMats();
    this.knockedNetMatIds.clear();
    this.netCollisionBoxes = createPlayerCollisionBoxes();
    this.lastOnlineScoreByTeamId = {};
    this.pendingOnlineScoreEvents = [];
    this.lastOnlineWinnerTeamId = null;
    this.lastOnlineBallBounceCount.clear();
    this.lastResetSerial = -1;
    this.lastResetVoteKey = '';
    this.onlineTeamSelector.setEnabled(false);
  }

  private exitOnlineMode(): void {
    if (!this.onlineModeActive) return;
    this.onlineModeActive = false;
    this.onlineModeStartedAtMs = 0;
    this.resetBackflipQte();
    this.networkRenderer.clear();
    this.onlineCharging.left = false;
    this.onlineCharging.right = false;
    this.onlineChargeSeconds.left = 0;
    this.onlineChargeSeconds.right = 0;
    this.resetPrediction('exit-online');
    this.lastOnlineScoreByTeamId = {};
    this.pendingOnlineScoreEvents = [];
    this.lastOnlineWinnerTeamId = null;
    this.lastOnlineBallBounceCount.clear();
    this.lastResetSerial = -1;
    this.lastResetVoteKey = '';
    this.onlineTeamSelector.setEnabled(false);
    this.player.hands.clearHands();
    this.player.resetPosition();
    this.quickBot.reset();
    this.chargeBot.reset();
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
    this.resetOnlineCatchAudioTracking();
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
    this.perfReportCorrectionCount = 0;
    this.perfReportSnapCount = 0;
    this.perfReportMaxCorrectionM = 0;
    this.snapshotReceiveCount = 0;
    this.snapshotRateTimer = 0;
    this.snapshotRateHz = 0;
    this.predictionErrorM = 0;
    this.residualAfterReplayM = 0;
    this.expectedLeadM = 0;
    this.desyncSmoothedM = 0;
    this.desyncRecentMaxM = 0;
    this.desyncPeakM = 0;
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
    const blue = match.mode === '2v2'
      ? teamLivesFor(snapshot, 'blue')
      : match.scoreByTeamId.blue ?? 0;
    const red = match.mode === '2v2'
      ? teamLivesFor(snapshot, 'red')
      : match.scoreByTeamId.red ?? 0;
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
      if (delta > 0) {
        if (this.isPenaltyScoreEvent(snapshot, teamId)) {
          this.showOnlineScoreEvent(snapshot, teamId, score, delta);
        } else {
          this.queueOnlineScoreEvent(teamId, score, delta);
        }
      }
    }

    this.lastOnlineScoreByTeamId = { ...scores };
    this.cancelRevertedPendingScoreEvents(snapshot);
  }

  private queueOnlineScoreEvent(teamId: string, score: number, delta: number): void {
    const dueAtMs = performance.now() + GAME_CONSTANTS.combat.catchHitGraceMs + 40;
    this.pendingOnlineScoreEvents.push({ teamId, score, delta, dueAtMs });
  }

  private cancelRevertedPendingScoreEvents(snapshot: ServerSnapshot): void {
    const scores = snapshot.room.match.scoreByTeamId;
    this.pendingOnlineScoreEvents = this.pendingOnlineScoreEvents.filter((event) => {
      return (scores[event.teamId] ?? 0) >= event.score;
    });
  }

  private flushPendingOnlineScoreEvents(snapshot: ServerSnapshot): void {
    if (this.pendingOnlineScoreEvents.length === 0) return;
    this.cancelRevertedPendingScoreEvents(snapshot);

    const now = performance.now();
    const remaining: PendingOnlineScoreEvent[] = [];
    for (const event of this.pendingOnlineScoreEvents) {
      if (event.dueAtMs > now) {
        remaining.push(event);
        continue;
      }
      this.showOnlineScoreEvent(snapshot, event.teamId, event.score, event.delta, false);
    }
    this.pendingOnlineScoreEvents = remaining;
  }

  private isPenaltyScoreEvent(snapshot: ServerSnapshot, scoringTeamId: string): boolean {
    const boundaryEvent = snapshot.room.match.boundary.lastEvent;
    return boundaryEvent.type === 'half-court-penalty' && boundaryEvent.opponentTeamId === scoringTeamId;
  }

  private handleOnlineWinnerEvent(snapshot: ServerSnapshot): void {
    const winnerTeamId = snapshot.room.match.winnerTeamId;
    if (winnerTeamId && winnerTeamId !== this.lastOnlineWinnerTeamId) {
      this.effects.onMatchWin();
      const local = snapshot.room.players[this.multiplayer.localPlayerId];
      const localWon = local?.teamId === winnerTeamId;
      this.hud.showScoreEvent(
        localWon ? 'VICTORY' : 'DEFEAT',
        `${winnerTeamId.toUpperCase()} team wins`,
        localWon ? 'good' : 'bad'
      );
    }
    this.lastOnlineWinnerTeamId = winnerTeamId;
  }

  private handleOnlineBallBounceAudio(snapshot: ServerSnapshot): void {
    for (const ballId in snapshot.room.balls) {
      const ball = snapshot.room.balls[ballId];
      const previous = this.lastOnlineBallBounceCount.get(ballId);
      this.lastOnlineBallBounceCount.set(ballId, ball.bounceCount);
      if (previous === undefined || ball.bounceCount <= previous) continue;

      const speed = Math.max(4, Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z));
      if (speed >= BALL_IMPACT_FX_MIN_SPEED) this.ballVisualEffects.spawnImpact(ball.position, speed);
      this.playBallBounceSound(speed, ball.bounceCount, ball.position);
    }
  }

  private playBallBounceSound(speed: number, bounceCount: number, position: { x: number; y: number; z: number }): void {
    const gain = BALL_BOUNCE_GAIN * Math.pow(BALL_BOUNCE_DECAY, Math.max(0, bounceCount - 1));
    if (!Number.isFinite(gain) || gain <= MIN_BALL_BOUNCE_GAIN) return;
    const forward = this.player.camera.getForwardRay().direction;
    this.sound.pingAt(speed, position, this.player.camera.globalPosition, forward, AUDIO_UP, gain);
  }

  private openLobbyMode(mode: LobbyMode): void {
    this.multiplayerOverlay.openMode(mode);
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
    this.pendingOnlineScoreEvents = [];
    this.lastOnlineWinnerTeamId = null;
    this.lastOnlineBallBounceCount.clear();
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

  private showOnlineScoreEvent(snapshot: ServerSnapshot, scoringTeamId: string, score: number, delta: number, allowPenaltyLabel = true): void {
    const local = snapshot.room.players[this.multiplayer.localPlayerId];
    const scorer = Object.values(snapshot.room.players).find((player) => player.teamId === scoringTeamId);
    const scorerName = scorer?.name ?? scoringTeamId.toUpperCase();
    const localScored = local?.teamId === scoringTeamId;
    const wasPenalty = allowPenaltyLabel && this.isPenaltyScoreEvent(snapshot, scoringTeamId);

    if (wasPenalty) {
      this.hud.showScoreEvent(`PENALTY +${delta}`, `${scorerName} ${score} / ${snapshot.room.match.scoreLimit}`, localScored ? 'good' : 'bad');
      return;
    }

    if (localScored) {
      this.effects.onDummyHit();
      this.hud.showHitMarker('good');
      this.hud.showScoreEvent(`HIT +${delta}`, `${scorerName} ${score} / ${snapshot.room.match.scoreLimit}`, 'good');
      return;
    }

    this.effects.onPlayerHit(this.player.camera.globalPosition);
    this.hud.showHitMarker('bad');
    this.hud.showScoreEvent('HIT TAKEN', `${scorerName} ${score} / ${snapshot.room.match.scoreLimit}`, 'bad');
  }

  private setPracticePropsEnabled(enabled: boolean): void {
    // Practice-only wall props, bots, and target dummies should disappear in the connected
    // lobby/duel arena, leaving only the live scoreboards on the end walls.
    this.practiceWall.setEnabled(enabled);
    this.lobbyModePortals.setEnabled(enabled);
    this.guideWall.setEnabled(enabled);

    // Bots are individually gated by their own enabled flag (practice state), not the online/offline toggle.
    // When going online, force both off. When returning to practice, restore from practiceState.
    if (!enabled) {
      this.quickBot.setEnabled(false);
      this.chargeBot.setEnabled(false);
    } else {
      this.quickBot.setEnabled(this.practiceState.quickThrowBotEnabled);
      this.chargeBot.setEnabled(this.practiceState.chargeThrowBotEnabled);
    }
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
    if (this.countdownActive || this.isLocalOnlineEliminated()) {
      const frozen = neutralNetInput(this.networkYaw, this.networkPitch);
      frozen.sequence = this.inputSeq;
      frozen.clientTimeMs = Date.now();
      frozen.resetSerial = this.currentResetSerial();
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
      rightCatchAttemptId: this.pendingCatchAttemptId.right,
      // One-shot backflip QTE tier; the server reads it on the throw-release tick (0 = normal throw).
      backflipThrowTier: this.pendingBackflipTier,
      // Stamp the timeline this input belongs to so the server can drop pre-reset packets still in
      // flight after a room reset (otherwise they freeze the player at spawn).
      resetSerial: this.currentResetSerial()
    };
  }

  /** The latest server resetSerial we've seen, as a non-negative int (−1 sentinel → 0 = unknown). */
  private currentResetSerial(): number {
    return Math.max(0, this.lastResetSerial);
  }

  private handleOnlineCatchSuccessAudio(local: PlayerState | null): void {
    const now = Date.now();
    // Covers the server active catch window, rewind/history slack, and snapshot/network delay.
    const catchConfirmWindowMs =
      GAME_CONSTANTS.combat.catchCooldownMs +
      GAME_CONSTANTS.combat.defenseHistoryMs +
      GAME_CONSTANTS.combat.defenseInputGraceMs +
      500;

    for (const side of ['left', 'right'] as const) {
      const currentHeld = local?.hands[side].heldBallId ?? null;
      const previousHeld = this.lastOnlineHeldBallId[side];
      const becameHeld = previousHeld === null && currentHeld !== null;
      const attempt = this.recentCatchAttemptBySide[side];
      const handAck = local?.hands[side].lastCatchAttemptId ?? 0;
      const attemptFresh = attempt ? now - attempt.openedAtMs <= catchConfirmWindowMs : false;

      if ((becameHeld && attempt && attemptFresh && handAck >= attempt.id) || (attempt && !attemptFresh)) {
        this.recentCatchAttemptBySide[side] = null;
      }

      this.lastOnlineHeldBallId[side] = currentHeld;
    }
  }

  private handleOnlineCatchEvents(events: readonly CatchEvent[]): void {
    for (const event of events) {
      if (event.catcherId !== this.multiplayer.localPlayerId) continue;
      this.effects.onCatch(event.absorbedSpeed);
      this.player.hands.playCatchSuccessAnimation(event.hand);
      this.hud.pulseCrosshair('catch');
      this.hud.showHitMarker('neutral');
      this.player.movement.addCatchRecoil(new Vector3(
        event.incomingVelocity.x,
        event.incomingVelocity.y,
        event.incomingVelocity.z
      ));
      this.recentCatchAttemptBySide[event.hand] = null;
    }
  }

  private handleOnlineParryEvents(events: readonly ParryEvent[], snapshot: ServerSnapshot): void {
    for (const event of events) {
      const ball = snapshot.room.balls[event.ballId];
      const position = ball
        ? new Vector3(ball.position.x, ball.position.y, ball.position.z)
        : this.player.camera.globalPosition;
      this.effects.onParry(18, position);

      if (event.deflectorId !== this.multiplayer.localPlayerId) continue;
      this.player.hands.playParryAnimation();
      this.hud.pulseCrosshair('parry');
      this.hud.showHitMarker('neutral');
    }
  }

  private handleOnlineHitEvents(events: readonly HitEvent[], snapshot: ServerSnapshot): void {
    for (const event of events) {
      const ball = snapshot.room.balls[event.ballId];
      if (ball) {
        this.ballVisualEffects.spawnImpact(
          ball.position,
          Math.max(12, Math.hypot(ball.velocity.x, ball.velocity.y, ball.velocity.z))
        );
      }
      if (event.throwerId === this.multiplayer.localPlayerId) {
        this.hud.showHitMarker('good');
        this.hud.pulseCrosshair('hit');
        if (snapshot.room.match.mode === '2v2') {
          const target = snapshot.room.players[event.targetId];
          this.hud.showScoreEvent('HIT', `${target?.name ?? 'Opponent'} ${target?.lives ?? '-'} / ${TUNING.match.playerLives} lives`, 'good');
        }
      } else if (event.targetId === this.multiplayer.localPlayerId) {
        this.hud.showHitMarker('bad');
        this.hud.pulseCrosshair('throw');
        if (snapshot.room.match.mode === '2v2') {
          const local = snapshot.room.players[event.targetId];
          this.hud.showScoreEvent('LIFE LOST', `${local?.lives ?? '-'} / ${TUNING.match.playerLives} lives remaining`, 'bad');
        }
      }
    }
  }

  private handleOnlineHitRevertEvents(events: readonly HitRevertEvent[]): void {
    for (const event of events) {
      if (event.targetId === this.multiplayer.localPlayerId) {
        this.hud.showScoreEvent('CATCH SAVE', 'Hit reversed', 'neutral');
      } else if (event.throwerId === this.multiplayer.localPlayerId) {
        this.hud.showScoreEvent('HIT DENIED', 'Opponent caught it', 'neutral');
      }
    }
  }

  private updateLocalMovementFoley(
    dt: number,
    velocity: Vec3,
    grounded: boolean,
    sliding: boolean,
    dashingThisFrame: boolean,
    wallRunning: boolean
  ): void {
    const speed = Math.hypot(velocity.x, velocity.z);
    this.squeakCooldown = Math.max(0, this.squeakCooldown - dt);

    if (!grounded || sliding || wallRunning) {
      this.footstepTimer = 0;
    } else if (speed > 1.25) {
      this.footstepTimer -= dt;
      if (this.footstepTimer <= 0) {
        const cadence = 0.4 - Math.min(0.18, (speed - 1.25) * 0.025);
        this.sound.footstep(Math.min(1, speed / TUNING.player.maxGroundSpeed));
        this.footstepTimer = Math.max(0.18, cadence);
      }
    } else {
      this.footstepTimer = 0;
    }

    if (grounded && speed > 2.8) {
      const dirX = velocity.x / speed;
      const dirZ = velocity.z / speed;
      const turnDot = dirX * this.lastGroundMoveDir.x + dirZ * this.lastGroundMoveDir.z;
      const hardTurn = this.lastGroundSpeed > 3.5 && turnDot < 0.72;
      if (!dashingThisFrame && hardTurn && this.squeakCooldown <= 0) {
        this.sound.squeak(0.7 + Math.min(0.35, speed / 18));
        this.squeakCooldown = 0.12;
      }
      this.lastGroundMoveDir = { x: dirX, y: 0, z: dirZ };
      this.lastGroundSpeed = speed;
    } else if (speed < 1.2) {
      this.lastGroundSpeed = speed;
    }
  }

  private updateOfflineCourtLines(): void {
    this.gym.setCourtLineState({
      negativeHalfActive: false,
      positiveHalfActive: isIllegalHalfCourtPosition('negativeZ', vector3ToVec3(this.player.root.position)),
      suddenDeath: this.rules.boundary.noBoundaries
    });
  }

  private updateOnlineCourtLines(snapshot: ServerSnapshot): void {
    let negativeHalfActive = false;
    let positiveHalfActive = false;
    for (const player of Object.values(snapshot.room.players)) {
      if (!isIllegalHalfCourtPosition(player.legalHalf, player.movement.position)) continue;
      if (player.legalHalf === 'negativeZ') positiveHalfActive = true;
      else negativeHalfActive = true;
    }
    this.gym.setCourtLineState({
      negativeHalfActive,
      positiveHalfActive,
      suddenDeath: snapshot.room.match.boundary.noBoundaries
    });
  }

  private aimedOnlineBallId(local: PlayerState): string | null {
    const snapshot = this.multiplayer.latestSnapshot;
    if (!snapshot) return null;
    const origin = {
      x: local.movement.position.x,
      y: local.movement.position.y + GAME_CONSTANTS.player.eyeHeight,
      z: local.movement.position.z
    };
    const forward = facingFromAngles(this.networkYaw, this.networkPitch);
    const minDot = Math.cos((GAME_CONSTANTS.catch.coneDegrees + 8) * Math.PI / 180);
    const maxRange = GAME_CONSTANTS.catch.rangeMeters * 1.75;
    let bestId: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const ball of Object.values(snapshot.room.balls)) {
      if (ball.phase === 'held') continue;
      const dx = ball.position.x - origin.x;
      const dy = ball.position.y - origin.y;
      const dz = ball.position.z - origin.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist <= 0.001 || dist > maxRange) continue;
      const dot = (dx * forward.x + dy * forward.y + dz * forward.z) / dist;
      if (dot < minDot) continue;
      const score = dist + (1 - dot) * 4;
      if (score < bestScore) {
        bestScore = score;
        bestId = ball.id;
      }
    }

    return bestId;
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
    const nowMs = Date.now();
    if (shouldClearPendingOnlineThrowRelease(hand.heldBallId, this.pendingOnlineThrowRelease[side], nowMs)) {
      if (isCatchTraceDebugEnabled() && this.pendingOnlineThrowRelease[side]) {
        console.log(
          `[catch/client] release-ack hand=${side}` +
          ` pendingBall=${this.pendingOnlineThrowRelease[side]?.ballId ?? 'none'}` +
          ` serverHeld=${hand.heldBallId ?? 'none'}`
        );
      }
      this.pendingOnlineThrowRelease[side] = null;
    }
    const inputHandEmpty = onlineHandInputLooksEmpty(hand.heldBallId, this.pendingOnlineThrowRelease[side], nowMs);

    // Stop re-latching an attempt once the server has acknowledged it (ack travels in hand state).
    if (this.pendingCatchAttemptId[side] !== 0 && hand.lastCatchAttemptId >= this.pendingCatchAttemptId[side]) {
      this.pendingCatchAttemptId[side] = 0;
    }

    if (inputHandEmpty) {
      this.onlineCharging[side] = false;
      this.onlineChargeSeconds[side] = 0;
      // Empty-hand click = a server-authoritative timed CATCH attempt. Assign a fresh latched id
      // (carried on every input packet until acked). The server decides success against history;
      // the client only plays catch audio once a snapshot confirms a ball entered the hand.
      if (pressed) {
        const attemptId = this.nextCatchAttemptId;
        this.pendingCatchAttemptId[side] = attemptId;
        this.recentCatchAttemptBySide[side] = { id: attemptId, openedAtMs: nowMs };
        this.nextCatchAttemptId += 1;
        if (isCatchTraceDebugEnabled()) {
          console.log(
            `[catch/client] attempt-created hand=${side} id=${attemptId}` +
            ` serverHeld=${hand.heldBallId ?? 'none'}` +
            ` releasePending=${this.pendingOnlineThrowRelease[side]?.ballId ?? 'none'}` +
            ` ack=${hand.lastCatchAttemptId} aimedBall=${this.aimedOnlineBallId(local) ?? 'none'}`
          );
        }
        this.player.hands.playCatchAttemptAnimation(side);
        this.effects.onCatchAttempt(side);
        this.hud.pulseCrosshair('catch');
      }
      return;
    }

    if (pressed && isCatchTraceDebugEnabled()) {
      console.log(
        `[catch/client] held-click-no-catch hand=${side}` +
        ` serverHeld=${hand.heldBallId ?? 'none'} mode=${hand.mode}` +
        ` charging=${Number(this.onlineCharging[side])} ack=${hand.lastCatchAttemptId}`
      );
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
      if (hand.heldBallId) {
        this.pendingOnlineThrowRelease[side] = { ballId: hand.heldBallId, releasedAtMs: nowMs };
        if (isCatchTraceDebugEnabled()) {
          console.log(`[catch/client] local-throw-release hand=${side} ball=${hand.heldBallId} optimisticEmpty=1`);
        }
      }
      this.effects.playerThrow();
      this.player.hands.playThrowAnimation(side);
      this.hud.pulseCrosshair('throw');
      this.onlineCharging[side] = false;
      this.onlineChargeSeconds[side] = 0;
    }
  }

  private resetBalls(): void {
    this.player.hands.clearHands();
    this.quickBot.reset();
    this.chargeBot.reset();
    this.ballManager.spawnCenterLineBalls();
    this.practiceState.spawnedExtraBalls = 0;
  }

  private resetMatch(): void {
    this.rules.reset();
    for (const dummy of this.targetDummies) {
      if (dummy.metadata) dummy.metadata.hitCount = 0;
    }
  }

  private handleButtonPress(id: import('../practice/PracticeControlWall').ButtonId): void {
    const s = this.practiceState;
    switch (id) {
      case 'addBall':
        if (this.ballManager.balls.length < s.maxPracticeBalls) {
          this.practiceWall.spawnPracticeBall();
          s.spawnedExtraBalls++;
        }
        break;
      case 'removeBall':
        if (this.practiceWall.removeOneBall()) {
          s.spawnedExtraBalls = Math.max(0, s.spawnedExtraBalls - 1);
        }
        break;
      case 'clearExtra': {
        const extra = s.spawnedExtraBalls;
        this.practiceWall.clearExtraBalls(extra);
        s.spawnedExtraBalls = 0;
        break;
      }
      case 'giveTwoBalls':
        this.giveTwoBalls();
        break;
      case 'resetScore':
        this.practiceState.practiceScore = 0;
        this.rules.reset();
        for (const dummy of this.targetDummies) {
          if (dummy.metadata) dummy.metadata.hitCount = 0;
        }
        this.hud.showScoreEvent('RESET SCORE', 'Practice score cleared', 'neutral');
        break;
      case 'resetMap':
        this.practiceReset();
        break;
      case 'toggleQuickBot':
        s.quickThrowBotEnabled = !s.quickThrowBotEnabled;
        this.quickBot.setEnabled(s.quickThrowBotEnabled);
        this.hud.showScoreEvent(
          s.quickThrowBotEnabled ? 'QUICK BOT ON' : 'QUICK BOT OFF', '', 'neutral'
        );
        break;
      case 'toggleChargeBot':
        s.chargeThrowBotEnabled = !s.chargeThrowBotEnabled;
        this.chargeBot.setEnabled(s.chargeThrowBotEnabled);
        this.hud.showScoreEvent(
          s.chargeThrowBotEnabled ? 'CHARGE BOT ON' : 'CHARGE BOT OFF', '', 'neutral'
        );
        break;
      case 'stopBots':
        s.quickThrowBotEnabled = false;
        s.chargeThrowBotEnabled = false;
        this.quickBot.setEnabled(false);
        this.chargeBot.setEnabled(false);
        this.hud.showScoreEvent('BOTS STOPPED', '', 'neutral');
        break;
      case 'difficulty': {
        const order = ['easy', 'normal', 'hard'] as const;
        const next = order[(order.indexOf(s.botDifficulty) + 1) % order.length];
        s.botDifficulty = next;
        this.quickBot.setDifficulty(next);
        this.chargeBot.setDifficulty(next);
        this.hud.showScoreEvent(`DIFFICULTY: ${next.toUpperCase()}`, '', 'neutral');
        break;
      }
    }
  }

  /** Attempt to give the player two balls (one per hand). Spawns if needed. */
  private giveTwoBalls(): void {
    const hands = this.player.hands;
    for (const side of ['left', 'right'] as const) {
      if (hands.getHand(side).ball) continue; // already holding
      let ball = this.ballManager.findNearestFreeBall(this.player.root.position);
      // Practice-admin button: if every settled ball is already busy/in motion, reclaim any
      // other non-held ball before giving up. This keeps repeated presses reliable even after
      // extra balls have been spawned or scattered around the gym.
      if (!ball) ball = this.ballManager.findFreeBall();
      if (!ball && this.ballManager.balls.length < this.practiceState.maxPracticeBalls) {
        ball = this.practiceWall.spawnPracticeBall();
        if (ball) this.practiceState.spawnedExtraBalls++;
      }
      if (!ball) continue;
      const holdPos = this.player.root.position.add(new Vector3(side === 'left' ? -0.4 : 0.4, 1.2, 0.3));
      this.ballManager.attachHeldBall(ball, side, holdPos);
      hands.forceCatchBall(side, ball);
    }
  }

  /** Full practice room reset: balls, bots, score, prediction buffers. Guide/control wall stays. */
  private practiceReset(): void {
    this.player.hands.clearHands();
    this.quickBot.reset();
    this.chargeBot.reset();
    // Clear ALL balls (including extra) and respawn default set
    this.ballManager.spawnCenterLineBalls();
    this.practiceState.spawnedExtraBalls = 0;
    this.practiceState.practiceScore = 0;
    this.rules.reset();
    for (const dummy of this.targetDummies) {
      if (dummy.metadata) dummy.metadata.hitCount = 0;
    }
    this.gym.resetMats();
    this.hud.showScoreEvent('MAP RESET', 'Practice reset', 'neutral');
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

function teamLivesFor(snapshot: ServerSnapshot, teamId: string): number {
  let total = 0;
  for (const player of Object.values(snapshot.room.players)) {
    if (player.teamId === teamId) total += Math.max(0, player.lives);
  }
  return total;
}

function hasEliminatedPlayers(snapshot: ServerSnapshot): boolean {
  for (const player of Object.values(snapshot.room.players)) {
    if (player.connected === false) continue;
    if (player.combatState === 'eliminated') return true;
  }
  return false;
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

function isSoakDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.soak') === '1';
  } catch {
    return false;
  }
}

function isCatchTraceDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.catch') === '1';
  } catch {
    return false;
  }
}

function readJsHeapStats(): string | null {
  const perf = performance as Performance & {
    memory?: {
      usedJSHeapSize: number;
      totalJSHeapSize: number;
    };
  };
  if (!perf.memory) return null;
  const usedMb = (perf.memory.usedJSHeapSize / 1048576).toFixed(1);
  const totalMb = (perf.memory.totalJSHeapSize / 1048576).toFixed(1);
  return `${usedMb}/${totalMb}MB`;
}

function formatCountMap(counts: Record<string, number>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0);
  if (entries.length === 0) return 'none';
  return entries.map(([key, count]) => `${key}:${count}`).join(',');
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
    rightCatchAttemptId: 0,
    backflipThrowTier: 0,
    resetSerial: 0
  };
}
