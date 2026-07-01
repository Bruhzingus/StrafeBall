import { Engine, Mesh, PBRMaterial, Scene, Vector3 } from '@babylonjs/core';
import { FxaaPostProcess } from '@babylonjs/core/PostProcesses/fxaaPostProcess';
import { InputManager } from '../input/InputManager';
import { PlayerController } from '../player/PlayerController';
import { GymArena } from '../map/GymArena';
import { GYM_REFLECTION_TARGETS, getGymEnvironmentDebugInfo, applyShowcaseGymMaterials } from '../map/GymVisualRevamp';
import {
  applyCompetitiveLighting,
  createCompetitiveShadowSystem,
  disposeCompetitiveShadowSystem,
  getCompetitiveGraphicsDebugStats,
  registerCompetitiveShadowCaster
} from '../map/CompetitiveLighting';
import {
  applyShowcaseLighting,
  createShowcaseShadowSystem,
  disposeShowcaseLighting,
  getShowcaseGraphicsDebugStats,
  registerShowcaseShadowCaster
} from '../map/ShowcaseLighting';
import {
  clearActiveGymShadowRegistrar,
  registerGymShadowCaster,
  setActiveGymShadowRegistrar
} from '../map/GymShadowCasters';
import { ShowcasePostFX } from '../effects/ShowcasePostFX';
import { isNeutralModeEnabled, isShowcaseLightingEnabled, resolveGraphicsMode, resolveShowcaseTier, SHOWCASE_CONFIG, type ShowcaseTier } from '../config/graphicsConfig';
// RECOVERY: createGymReflectionProbe is intentionally NOT imported/instantiated this phase (code
// preserved in GymReflectionProbe). dispose + debug stay so any prior probe is torn down and reported.
import { disposeGymReflectionProbe, getGymReflectionProbeDebugInfo } from '../map/GymReflectionProbe';
import { MatObstacle } from '../map/MatObstacle';
import { ModelLoader } from '../assets/ModelLoader';
import { BallManager } from '../ball/BallManager';
import { BallVisualEffects } from '../ball/BallVisualEffects';
import { BallState } from '../ball/BallState';
import { Hud } from '../ui/Hud';
import { Nametags } from '../ui/Nametags';
import { BackflipQteController } from '../player/BackflipQteController';
import { BackflipQteHud } from '../ui/BackflipQteHud';
import { GAME_CONSTANTS } from '../../../shared/constants';
import { SettingsPanel } from '../ui/SettingsPanel';
import { MatchRules } from '../rules/MatchRules';
import { TUNING } from '../config/tuning';
import { CONTROL_KEYS, MOUSE_BUTTON } from '../config/controls';
import { SoundManager } from '../audio/SoundManager';
import { MusicManager } from '../audio/MusicManager';
import { Effects } from '../effects/Effects';
import { PracticeBot } from '../bot/PracticeBot';
import { PracticeControlWall } from '../practice/PracticeControlWall';
import { LobbyModePortals } from '../practice/LobbyModePortals';
import type { LobbyMode, LobbyPortalAction } from '../practice/LobbyModePortals';
import { GuideWall } from '../practice/GuideWall';
import { MovementSandbox, type SandboxAction } from '../practice/MovementSandbox';
import { CreatorEditor, CREATOR_ENTRY_RADIUS, CREATOR_ENTRY_HOLD_SECONDS } from '../practice/creator/CreatorEditor';
import { createPracticeState } from '../practice/PracticeState';
import type { PracticeState } from '../practice/PracticeState';
import { MultiplayerClient } from '../network/MultiplayerClient';
import { NetFlightRecorder, defaultFlightRecorderGraphicsPreset } from '../network/NetFlightRecorder';
import { MultiplayerOverlay } from '../network/MultiplayerOverlay';
import { NetworkRenderer } from '../network/NetworkRenderer';
import { OnlineTeamSelectorPads } from '../network/OnlineTeamSelectorPads';
import {
  onlineHandInputLooksEmpty,
  shouldClearPendingOnlineThrowRelease,
  type PendingOnlineThrowRelease
} from '../network/OnlineHandIntent';
import type { CatchEvent, HitEvent, HitRevertEvent, ParryEvent, ServerSnapshot } from '../../../shared/protocol';
import type { DashState, MatchStatus, MovementInternalState, PlayerInput, PlayerMovementState, PlayerState, Vec3 } from '../../../shared/types';
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
import { createPlayerCollisionBoxes, MAT_SPECS, type AABB } from '../../../shared/simulation/MapGeometry';
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
const PERF_FRAME_BUCKETS_MS = [8, 10, 12, 14, 16, 20, 25, 33, 50, 66, 100, 150, 250, 500, 1000];

export class ArenaScene {
  public readonly scene: Scene;

  private readonly input: InputManager;
  private readonly ballManager: BallManager;
  private readonly player: PlayerController;
  private readonly hud: Hud;
  private readonly nametags: Nametags;
  private readonly rules = new MatchRules();
  private readonly targetDummies: Mesh[] = [];
  private readonly sound: SoundManager;
  private readonly music: MusicManager;
  private readonly ballVisualEffects: BallVisualEffects;
  private readonly effects: Effects;
  private readonly quickBot: PracticeBot;
  private readonly chargeBot: PracticeBot;
  private readonly practiceWall: PracticeControlWall;
  private readonly lobbyModePortals: LobbyModePortals;
  private readonly guideWall: GuideWall;
  // Local outdoor Movement Sandbox — lazily created on first entry, only ever updated from the
  // offline step path (never stepOnline), and torn down when connected online gameplay begins.
  private movementSandbox: MovementSandbox | null = null;
  // Developer-only Creator Sandbox editor — created lazily on first sandbox entry, only ever updated
  // from the offline step path, and force-deactivated before connected online play.
  private creator: CreatorEditor | null = null;
  private creatorEntryHold = 0;
  private readonly practiceState: PracticeState = createPracticeState();
  private readonly settingsPanel: SettingsPanel;
  private readonly gym: GymArena;
  private readonly multiplayer = new MultiplayerClient();
  private readonly multiplayerOverlay: MultiplayerOverlay;
  private readonly networkRenderer: NetworkRenderer;
  private readonly onlineTeamSelector: OnlineTeamSelectorPads;
  // Anti-aliasing route differs by graphics mode: Competitive uses the lightweight standalone FXAA
  // post; Showcase uses the DefaultRenderingPipeline (FXAA + bloom) inside ShowcasePostFX instead, so
  // exactly one of these is ever non-null.
  private readonly fxaaPostProcess: FxaaPostProcess | null;
  private readonly showcasePostFx: ShowcasePostFX | null;
  // Resolved once at construction. Showcase is opt-in (see graphicsConfig); Competitive is the default
  // bright baseline. The tier only matters in Showcase mode.
  private readonly showcaseEnabled: boolean = isShowcaseLightingEnabled();
  private readonly showcaseTier: ShowcaseTier = resolveShowcaseTier();
  // Neutral: the diagnostic truth baseline (one hemi + one directional + one ShadowGenerator + FXAA
  // only, no environment/reflection source, no fake-lighting decal overlays). Opt-in, same as Showcase.
  private readonly neutralEnabled: boolean = isNeutralModeEnabled();
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
  private lastOnlineMatchStatus: MatchStatus | null = null;
  private readonly lastOnlineBallBounceCount = new Map<string, number>();
  private readonly lastTeamChoiceAnnouncementKeyByPlayerId = new Map<string, string>();
  private lastResetSerial = -1;
  private lastResetVoteKey = '';

  // Spectator fly-cam while downed online (eliminated in a still-live 2v2 match). The camera is
  // detached from the player root so it can move independently; reparented back on respawn/reset.
  private freeCamActive = false;
  private readonly freeCamPosition = Vector3.Zero();

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
  // Knock heading per downed mat (from the snapshot), so the prediction collision can place each
  // fallen mat's low flat step-on box exactly where the server does.
  private readonly knockedNetMatDirections = new Map<string, { x: number; z: number }>();
  // Mats hidden by the host mat-preset setting (absent from authoritative room.mats). Excluded from
  // both visuals and the local prediction collision so the client world matches the server's.
  private readonly excludedNetMatIds = new Set<string>();
  // Offline practice: hold-E progress (seconds) toward standing the nearest knocked-over mat back
  // up. Resets whenever E is released or the player leaves the mat's reach.
  private matRestoreHold = 0;
  // Freshly reset practice mats get a short grace period before player contact can knock them down.
  private readonly matPostResetKnockImmunityById = new Map<string, number>();
  private static readonly MAT_RESTORE_HOLD_SECONDS = TUNING.mat.restoreHoldSeconds;
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
  private perfReportUnchangedInputCount = 0;
  private perfReportInputEdgeCount = 0;
  private perfReportInputJsonBytesTotal = 0;
  private perfReportInputJsonBytesMax = 0;
  private perfReportInputJsonByteSamples = 0;
  private perfReportFrameMsTotal = 0;
  private perfReportFrameMsMax = 0;
  private perfReportFramesOver50Ms = 0;
  private perfReportFramesOver100Ms = 0;
  private perfReportFramesOver250Ms = 0;
  private readonly perfReportFrameBuckets = new Array<number>(PERF_FRAME_BUCKETS_MS.length).fill(0);
  private perfReportCorrectionCount = 0;
  private perfReportSnapCount = 0;
  private perfReportMaxCorrectionM = 0;
  private readonly netFlightRecorder = new NetFlightRecorder();
  private footstepTimer = 0;
  private squeakCooldown = 0;
  private lastBoundaryClockTickSecond: number | null = null;
  private lastBoundaryClockDisplaySecond: number | null = null;
  private boundaryCountdownWasActive = false;
  private boundaryOpenConfirmPlayed = false;
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
    this.setupGymShadows();
    this.setupGymEnvironmentResponse();
    // All meshes with targetDummy metadata — includes both static and the moving dummy.
    this.targetDummies = this.scene.meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh && !!mesh.metadata?.targetDummy);
    this.sound = new SoundManager();
    this.music = new MusicManager(() => this.multiplayer.estimateServerTimeMs());
    this.ballVisualEffects = new BallVisualEffects(this.scene);

    // Balls collide with bleachers only (mats are immune to balls — they pass through).
    this.ballManager = new BallManager(loader, this.gym.ballCollision, (speed, bounceCount, position) => {
      if (speed >= BALL_IMPACT_FX_MIN_SPEED) this.ballVisualEffects.spawnImpact(position, speed);
      this.playBallBounceSound(speed, bounceCount, position);
    }, this.ballVisualEffects);
    this.ballManager.spawnCenterLineBalls();

    this.effects = new Effects(this.scene, this.sound);

    this.player = new PlayerController(this.scene, this.input, this.ballManager, this.gym.collision, this.effects);
    // Post-processing: FXAA is the standalone post in EVERY mode (no bloom anywhere). Phase 8 adds an
    // OPTIONAL subtle SSAO-only pass in Showcase, gated by the single SHOWCASE_CONFIG.ssao.enabled kill
    // switch — disabled in Competitive and Neutral. SSAO coexists with the FXAA post; no bloom, no tone
    // mapping, no duplicate pipeline.
    this.fxaaPostProcess = new FxaaPostProcess('scene_fxaa', 1.0, this.player.camera);
    this.showcasePostFx =
      this.showcaseEnabled && SHOWCASE_CONFIG.ssao.enabled
        ? new ShowcasePostFX(this.scene, this.player.camera, this.showcaseTier)
        : null;
    this.quickBot = new PracticeBot(this.scene, this.ballManager, 'quick');
    this.chargeBot = new PracticeBot(this.scene, this.ballManager, 'charge');
    this.practiceWall = new PracticeControlWall(this.scene, this.practiceState, this.ballManager, (id) => this.handleButtonPress(id));
    this.lobbyModePortals = new LobbyModePortals(this.scene);
    this.guideWall = new GuideWall(this.scene);

    const hudRoot = document.getElementById('hud-root');
    if (!hudRoot) throw new Error('Missing HUD root.');
    this.hud = new Hud(hudRoot);
    this.nametags = new Nametags(hudRoot);
    this.backflipQteHud = new BackflipQteHud(hudRoot);
    this.settingsPanel = new SettingsPanel();
    this.multiplayerOverlay = new MultiplayerOverlay(this.multiplayer, this.input);
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

    // While the Creator Sandbox owns the screen (its password modal or an active editor session) it
    // is the sole owner of cursor-lock suppression — skip the lobby overlay's per-frame suppression so
    // it can't fight the editor (which would break free-look / re-grab the pointer every frame).
    if (!this.creator?.isBusy()) {
      this.multiplayerOverlay.update();
    }
    if (this.multiplayer.connected) {
      this.enterOnlineMode();
      const matchStatus = this.multiplayer.latestSnapshot?.room.match.status ?? 'warmup';
      this.music.setBattleSyncState(this.multiplayer.battleMusicSync);
      this.music.setLobbyMusicActive(matchStatus !== 'playing');
      this.stepOnline(dt, frameMs);
      this.nametags.update(this.networkRenderer.getPlayerNametagInfo(), this.scene);
      if (this.multiplayer.latestSnapshot) {
        const connectionDebug = this.multiplayer.getConnectionDebug();
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
            pingJitterMs: connectionDebug.pingJitterMs,
            lastPongAgeMs: connectionDebug.lastPongAgeMs,
            missedPongs: connectionDebug.missedPongs,
            socketBufferedAmount: connectionDebug.socketBufferedAmount,
            socketBufferedPeak: connectionDebug.socketBufferedPeak,
            pingSendBufferedAmount: connectionDebug.pingSendBufferedAmount,
            rttEstimateMs: connectionDebug.rttEstimateMs,
            maxRecentPingMs: connectionDebug.maxRecentPingMs,
            predictionActive: this.predictedMovement !== null,
          }
        );
      }
    } else {
      this.exitOnlineMode();
      this.music.setBattleSyncState(null);
      this.music.setLobbyMusicActive(true);
      this.step(dt);
      this.hud.update(this.player, this.rules, this.ballManager, engine.getFps(), frameMs);
      this.nametags.update([], this.scene);
    }
    this.music.update(dt);
    this.hud.updateMusic(this.music.getHudState());
    this.input.endFrame();
  }

  dispose(): void {
    this.input.dispose();
    this.hud.dispose();
    this.nametags.dispose();
    this.multiplayerOverlay.dispose();
    this.multiplayer.dispose();
    this.networkRenderer.dispose();
    this.onlineTeamSelector.dispose();
    this.settingsPanel.dispose();
    this.ballManager.clear();
    this.ballVisualEffects.dispose();
    this.fxaaPostProcess?.dispose();
    this.showcasePostFx?.dispose();
    this.quickBot.dispose();
    this.chargeBot.dispose();
    this.practiceWall.dispose();
    this.lobbyModePortals.dispose();
    this.guideWall.dispose();
    this.movementSandbox?.dispose();
    this.creator?.dispose();
    this.effects.dispose();
    // Tear down whichever shadow system this session built; the other is a no-op. Clear the caster
    // registrar so any late registration becomes a safe no-op.
    disposeCompetitiveShadowSystem();
    disposeShowcaseLighting(this.scene);
    disposeGymReflectionProbe();
    clearActiveGymShadowRegistrar();
    this.gym.dispose();
    this.music.dispose();
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
    // The QTE is intentionally landing-only — it never arms mid-air (e.g. during a wall-run).
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
    // The QTE is intentionally landing-only — it never arms mid-air (e.g. during a wall-run).
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
    this.tickMatPostResetKnockImmunity(dt);

    const p = this.player.root.position;
    const v = this.player.movement.velocity;
    const r = TUNING.player.radius;
    const reach = r + 0.12;

    for (const mat of this.gym.mats) {
      if (mat.knockedOver) continue;
      if ((this.matPostResetKnockImmunityById.get(mat.id) ?? 0) > 0) continue;
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
      // Lay the mat flat, then swap its collision to the low flat panel: balls bounce off the fallen
      // mat (and stay live) and the player steps onto it (a small, noticeable ledge).
      mat.knockOver(dir.lengthSquared() > 1e-4 ? dir : new Vector3(toMatX, 0, toMatZ));
      this.gym.setMatCollision(mat, 'knocked');
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
    const nearest = this.findNearestRestorableMat();
    if (!nearest) {
      this.matRestoreHold = 0;
      return;
    }

    if (!this.input.isKeyDown(CONTROL_KEYS.interact)) {
      this.matRestoreHold = 0;
      return;
    }

    this.matRestoreHold += dt;
    if (this.matRestoreHold >= ArenaScene.MAT_RESTORE_HOLD_SECONDS) {
      this.matRestoreHold = 0;
      nearest.reset();
      this.gym.setMatCollision(nearest, 'standing');
      this.matPostResetKnockImmunityById.set(nearest.id, TUNING.mat.postResetKnockImmunitySeconds);
    }
  }

  /** Nearest knocked-over mat within restore reach of the player, or null if none in range. */
  private findNearestRestorableMat(): MatObstacle | null {
    const p = this.player.root.position;
    const restoreReach = TUNING.mat.restoreReach;
    let nearest: MatObstacle | null = null;
    let nearestDist = Infinity;
    for (const mat of this.gym.mats) {
      if (!mat.knockedOver) continue;
      const box = mat.getAABB(); // standing footprint center is a stable proximity anchor
      const mx = (box.minX + box.maxX) * 0.5;
      const mz = (box.minZ + box.maxZ) * 0.5;
      const d = (p.x - mx) * (p.x - mx) + (p.z - mz) * (p.z - mz);
      if (d < nearestDist) { nearestDist = d; nearest = mat; }
    }
    return nearest && nearestDist <= restoreReach * restoreReach ? nearest : null;
  }

  /** Bottom-middle "Hold E" / "Press E" prompt: mat restore takes priority over ball pickup since
   * both use E and a mat is the more deliberate action (and rarer to be in range of both). */
  private updateInteractPrompt(): void {
    if (this.findNearestRestorableMat()) {
      this.hud.setInteractPrompt('Hold', 'to pick up mat');
      return;
    }

    const left = this.player.hands.getHand('left');
    const right = this.player.hands.getHand('right');
    if (!left.ball || !right.ball) {
      const waist = this.player.lastMovementSnapshot.position.add(new Vector3(0, 0.8, 0));
      if (this.ballManager.findPickupCandidate(waist)) {
        this.hud.setInteractPrompt('Press', 'to pick up ball');
        return;
      }
    }

    this.hud.setInteractPrompt(null, '');
  }

  private tickMatPostResetKnockImmunity(dt: number): void {
    for (const [matId, remaining] of this.matPostResetKnockImmunityById) {
      const next = remaining - dt;
      if (next > 0) this.matPostResetKnockImmunityById.set(matId, next);
      else this.matPostResetKnockImmunityById.delete(matId);
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
      // Mat-preset exclusion: a mat absent from authoritative room.mats does not exist this match.
      // Hide its visual + drop its collision so the client world matches the server's mat set.
      if (!state) {
        if (!this.excludedNetMatIds.has(mat.id)) {
          if (mat.knockedOver) mat.reset();
          this.gym.removeMatCollision(mat);
          mat.mesh.setEnabled(false);
          this.knockedNetMatIds.delete(mat.id);
          this.knockedNetMatDirections.delete(mat.id);
          this.excludedNetMatIds.add(mat.id);
          knockedChanged = true;
        }
        continue;
      }
      // Mat is back in the active set (host raised the preset / new match): re-show + re-collide.
      if (this.excludedNetMatIds.has(mat.id)) {
        mat.mesh.setEnabled(true);
        mat.reset();
        this.gym.setMatCollision(mat, 'standing');
        this.excludedNetMatIds.delete(mat.id);
        knockedChanged = true;
      }
      if (state.knockedOver && !mat.knockedOver) {
        // Tip the mat flat, then swap its collision to the low flat panel in BOTH gym worlds so balls
        // bounce off the fallen mat and the player steps onto it (mirrors the server).
        mat.knockOver(new Vector3(state.knockDirection.x, 0, state.knockDirection.z));
        this.gym.setMatCollision(mat, 'knocked');
        this.knockedNetMatIds.add(mat.id);
        this.knockedNetMatDirections.set(mat.id, { x: state.knockDirection.x, z: state.knockDirection.z });
        knockedChanged = true;
      } else if (!state.knockedOver && mat.knockedOver) {
        // Server reset the mat (e.g. room reset): stand it back up and restore its upright cover box.
        mat.reset();
        this.gym.setMatCollision(mat, 'standing');
        this.knockedNetMatIds.delete(mat.id);
        this.knockedNetMatDirections.delete(mat.id);
        knockedChanged = true;
      }
    }

    // Keep the prediction collision set in sync with the server: each downed mat becomes a low flat
    // step-on box (placed via its knock heading); preset-excluded mats have no box at all.
    if (knockedChanged) {
      this.netCollisionBoxes = createPlayerCollisionBoxes(
        new Set([...this.knockedNetMatIds, ...this.excludedNetMatIds]),
        MAT_SPECS,
        this.knockedNetMatDirections
      );
    }
  }

  private step(dt: number): void {
    this.elapsed += dt;

    // The Creator Sandbox editor, when unlocked + active, takes over the offline step entirely
    // (Build Mode flies an editor camera with the player frozen; Playtest Mode runs real movement).
    if (this.creator?.isActive()) {
      this.stepCreator(dt);
      return;
    }

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

    // The Movement Sandbox runs a lean offline step (movement foley + the leave portal only) and
    // skips the normal practice/match systems below (bots, mats, dummy scoring, boundary, gym update).
    if (this.movementSandbox?.active) {
      this.stepMovementSandbox(dt);
      return;
    }

    // Practice bots — only active when enabled via control wall
    const playerPos = this.player.camera.globalPosition;
    if (this.quickBot.update(dt, playerPos)) this.effects.botThrow();
    if (this.chargeBot.update(dt, playerPos)) this.effects.botThrow();
    this.practiceWall.update(dt);
    this.lobbyModePortals.update(
      dt,
      this.player.root.position,
      this.input.isKeyDown(CONTROL_KEYS.interact),
      this.multiplayerOverlay.isMenuOpen(),
      (action) => this.activateLobbyPortal(action)
    );

    this.ballManager.setPickupHighlight(
      this.ballManager.findPickupLookCandidate(this.player.camera.globalPosition, cameraForward(this.player.camera))
    );
    this.ballManager.update(dt);
    this.checkBotHitsPlayer(dt);
    this.ballVisualEffects.update(dt);
    this.updateOfflineMats(dt);
    this.updateInteractPrompt();
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
    this.updateBoundaryClockSound(
      Math.max(0, TUNING.match.noBoundariesSeconds - this.rules.boundary.elapsed),
      this.rules.boundary.noBoundaries
    );
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

  private stepOnline(dt: number, rawFrameMs: number): void {
    this.elapsed += dt;
    this.onlineRateLogFrameCount += 1;
    this.perfReportFrameCount += 1;
    this.recordPerfFrame(rawFrameMs);
    this.netFlightRecorder.recordFrame(rawFrameMs);

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
    const matchStatus = snapshot?.room.match.status ?? null;
    if (matchStatus === 'countdown' && this.lastOnlineMatchStatus !== 'countdown') {
      this.tryRequestMatchFullscreen();
    }
    this.lastOnlineMatchStatus = matchStatus;
    // Pre-round countdown gate: while the authoritative match is counting down, local input is
    // frozen to look-only (built in buildNetworkInput) so the player can't move/throw until GO.
    this.countdownActive = matchStatus === 'countdown';
    const teamSelectorConsumesInteract = this.onlineTeamSelector.update(
      dt,
      this.player.root.position,
      this.input.isKeyDown(CONTROL_KEYS.interact),
      snapshot?.room ?? null,
      this.multiplayer.localPlayerId,
      {
        chooseTeam: (teamId) => this.multiplayer.requestSwitchTeam(teamId),
        voteStart: () => {
          this.tryRequestMatchFullscreen();
          this.multiplayer.requestStartVote();
        }
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
    if (snapshot) {
      this.updateBoundaryClockSound(
        Math.max(0, snapshot.room.settings.halfCourtTimerSeconds - snapshot.room.match.boundary.elapsedSeconds),
        snapshot.room.match.boundary.noBoundaries
      );
    }

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
        this.deriveOnlineMovementScale(local),
        this.deriveOnlineCooldownRateScale(local)
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
      this.recordOnlineInputPerf(input, prev);
      this.multiplayer.sendInput(input, prev);
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

    this.updateFreeCam(dt, snapshot, local);

    // Server-side actions outside the movement input stream. Reset votes are always allowed.
    if (this.input.wasKeyPressed(CONTROL_KEYS.reset)) {
      this.multiplayer.requestReset('same-teams');
    }
    if (this.input.wasKeyPressed(CONTROL_KEYS.resetMatch)) {
      this.multiplayer.requestReset('reset-teams');
    }

    // Remote players and balls: rendered from server state. Pass the local PREDICTED movement so a
    // ball held by the local player attaches to the present-time hand (no strafe drag) rather than
    // the interpolation-delayed network position.
    if (snapshot) {
      this.handleOnlineResetEvents(snapshot);
      this.handleOnlineTeamChoiceEvents(snapshot);
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
      this.networkRenderer.update(snapshot, this.multiplayer.localPlayerId, dt, this.predictedMovement, this.multiplayer.latestSnapshotLanes ?? undefined);
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
    this.updateNetFlightRecorder(snapshot);
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
      const connectionDebug = this.multiplayer.getConnectionDebug();
      const render = this.networkRenderer.getDebugStats();
      const avgFrameMs = this.perfReportFrameCount > 0 ? this.perfReportFrameMsTotal / this.perfReportFrameCount : 0;
      const p95FrameMs = percentileFromBuckets(this.perfReportFrameBuckets, this.perfReportFrameCount, 0.95);
      const fps = avgFrameMs > 0 ? 1000 / avgFrameMs : 0;
      const activeMeshes = this.scene.getActiveMeshes ? this.scene.getActiveMeshes().length : this.scene.meshes.length;
      const roomAgeSec = this.onlineModeStartedAtMs > 0 ? (Date.now() - this.onlineModeStartedAtMs) / 1000 : 0;
      const avgInputJsonBytes = this.perfReportInputJsonByteSamples > 0
        ? Math.round(this.perfReportInputJsonBytesTotal / this.perfReportInputJsonByteSamples)
        : 0;
      const inputJsonBytesPerSec = avgInputJsonBytes * (this.perfReportInputCount / elapsed);
      console.log(
        `[perf] roomAgeSec=${roomAgeSec.toFixed(1)}` +
        ` snapshotMode=${this.multiplayer.snapshotTierMode}` +
        ` input=${CLIENT_INPUT_RATE}Hz snapshots=${SNAPSHOT_RATE}Hz` +
        ` fps=${fps.toFixed(1)} avgFrameMs=${avgFrameMs.toFixed(2)} p95FrameMs=${p95FrameMs.toFixed(2)} maxFrameMs=${this.perfReportFrameMsMax.toFixed(2)}` +
        ` framesOver={50:${this.perfReportFramesOver50Ms} 100:${this.perfReportFramesOver100Ms} 250:${this.perfReportFramesOver250Ms}}` +
        ` inputSent=${(this.perfReportInputCount / elapsed).toFixed(1)}/s` +
        ` inputUnchanged=${this.perfReportUnchangedInputCount}` +
        ` inputEdges=${(this.perfReportInputEdgeCount / elapsed).toFixed(1)}/s` +
        ` inputJsonBytes avg=${avgInputJsonBytes} max=${this.perfReportInputJsonBytesMax} estimated=${Math.round(inputJsonBytesPerSec)}B/s` +
        ` snapshotsRecv=${snap.receivedPerSecond.toFixed(1)}/s` +
        ` uniqueSnapshots=${snap.uniqueTicksPerSecond.toFixed(1)}/s` +
        ` renderSnapshots=${this.snapshotRateHz.toFixed(1)}/s` +
        ` snapMs avg=${snap.averageMsBetweenSnapshots.toFixed(1)} max=${snap.maxMsBetweenSnapshots.toFixed(1)}` +
        ` dupSnapshots=${snap.duplicateOrOutOfOrder} staleDropped=${snap.staleDropped}` +
        ` ping=${this.multiplayer.pingMs ?? -1}ms jitter=${connectionDebug.pingJitterMs.toFixed(1)}ms lastPongAge=${connectionDebug.lastPongAgeMs ?? -1}ms missedPongs=${connectionDebug.missedPongs}` +
        ` pendingInputs=${this.pendingInputs.length}` +
        ` rawServerLeadError=${this.predictionErrorM.toFixed(3)}m` +
        ` residualAfterReplay=${this.residualAfterReplayM.toFixed(3)}m` +
        ` desyncAvg=${this.desyncSmoothedM.toFixed(3)}m` +
        ` desyncRecentMax=${this.desyncRecentMaxM.toFixed(3)}m` +
        ` desyncPeak=${this.desyncPeakM.toFixed(3)}m` +
        ` corrections=${this.perfReportCorrectionCount} snaps=${this.perfReportSnapCount}` +
        ` oldestSnapshotAge=${render.oldestSnapshotAgeMs.toFixed(1)}ms` +
        ` renderDelay=${render.renderDelayMs.toFixed(1)}ms` +
        ` wsBuffered=${connectionDebug.socketBufferedAmount}B snapshotAge=${connectionDebug.lastSnapshotAgeMs ?? -1}ms` +
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
          ` pongAgeMs=${connectionDebug.lastPongAgeMs ?? -1}` +
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
    this.perfReportUnchangedInputCount = 0;
    this.perfReportInputEdgeCount = 0;
    this.perfReportInputJsonBytesTotal = 0;
    this.perfReportInputJsonBytesMax = 0;
    this.perfReportInputJsonByteSamples = 0;
    this.perfReportFrameMsTotal = 0;
    this.perfReportFrameMsMax = 0;
    this.perfReportFramesOver50Ms = 0;
    this.perfReportFramesOver100Ms = 0;
    this.perfReportFramesOver250Ms = 0;
    this.perfReportFrameBuckets.fill(0);
    this.perfReportCorrectionCount = 0;
    this.perfReportSnapCount = 0;
    this.perfReportMaxCorrectionM = 0;
  }

  private recordPerfFrame(frameMs: number): void {
    this.perfReportFrameMsTotal += frameMs;
    this.perfReportFrameMsMax = Math.max(this.perfReportFrameMsMax, frameMs);
    if (frameMs > 50) this.perfReportFramesOver50Ms += 1;
    if (frameMs > 100) this.perfReportFramesOver100Ms += 1;
    if (frameMs > 250) this.perfReportFramesOver250Ms += 1;
    for (let i = 0; i < PERF_FRAME_BUCKETS_MS.length; i += 1) {
      if (frameMs <= PERF_FRAME_BUCKETS_MS[i]) {
        this.perfReportFrameBuckets[i] += 1;
        return;
      }
    }
    this.perfReportFrameBuckets[PERF_FRAME_BUCKETS_MS.length - 1] += 1;
  }

  private recordOnlineInputPerf(input: PlayerInput, previous: PlayerInput): void {
    if (networkInputStateEquals(input, previous)) this.perfReportUnchangedInputCount += 1;
    this.perfReportInputEdgeCount += countInputEdges(input);

    const sampleStride = Math.max(1, Math.floor(CLIENT_INPUT_RATE / 4));
    if (
      this.perfReportInputJsonByteSamples < 8 &&
      (this.perfReportInputCount + 1) % sampleStride === 0 &&
      isPerfDebugEnabled()
    ) {
      const bytes = this.multiplayer.estimateInputCommandJsonBytes(input, previous);
      this.perfReportInputJsonBytesTotal += bytes;
      this.perfReportInputJsonBytesMax = Math.max(this.perfReportInputJsonBytesMax, bytes);
      this.perfReportInputJsonByteSamples += 1;
    }
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
        this.deriveOnlineMovementScale(local),
        this.deriveOnlineCooldownRateScale(local)
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
        this.deriveOnlineMovementScale(local),
        this.deriveOnlineCooldownRateScale(local)
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

  private deriveOnlineCooldownRateScale(local: PlayerState | null): number {
    if (!local || local.combatState === 'eliminated') return 1;
    const snapshot = this.multiplayer.latestSnapshot;
    if (snapshot?.room.match.mode !== '2v2') return 1;
    return (local.lastPlayerBuffUntilMs ?? 0) > Date.now()
      ? TUNING.match.lastPlayerBuffCooldownRateMultiplier
      : 1;
  }

  /**
   * Downed-spectator fly-cam: while the local player is eliminated in a still-live 2v2 match,
   * detach the camera from the (frozen) body and let them fly around with WASD + mouse to watch
   * teammates. Reparents back onto the root the moment they're no longer eliminated (respawned by
   * a round reset), so normal first-person view resumes with no manual cleanup needed elsewhere.
   */
  private updateFreeCam(dt: number, snapshot: ServerSnapshot | null, local: PlayerState | null): void {
    const shouldBeActive = !!local
      && local.combatState === 'eliminated'
      && snapshot?.room.match.mode === '2v2'
      && snapshot.room.match.status !== 'complete';

    if (shouldBeActive && !this.freeCamActive) {
      this.freeCamActive = true;
      this.freeCamPosition.copyFrom(this.player.camera.globalPosition);
      this.player.camera.parent = null;
      this.player.camera.position.copyFrom(this.freeCamPosition);
    } else if (!shouldBeActive && this.freeCamActive) {
      this.freeCamActive = false;
      this.player.camera.parent = this.player.root;
      this.player.camera.position.set(0, TUNING.player.eyeHeight, 0);
    }

    if (!this.freeCamActive) return;

    const moveX = (this.input.isKeyDown(CONTROL_KEYS.right) ? 1 : 0) - (this.input.isKeyDown(CONTROL_KEYS.left) ? 1 : 0);
    const moveZ = (this.input.isKeyDown(CONTROL_KEYS.forward) ? 1 : 0) - (this.input.isKeyDown(CONTROL_KEYS.backward) ? 1 : 0);
    const moveY = (this.input.isKeyDown(CONTROL_KEYS.jump) ? 1 : 0) - (this.input.isKeyDown(CONTROL_KEYS.crouch) ? 1 : 0);
    const speed = TUNING.freeCam.moveSpeed * (this.input.isKeyDown(CONTROL_KEYS.dash) ? TUNING.freeCam.sprintMultiplier : 1);

    const yaw = this.networkYaw;
    const sin = Math.sin(yaw), cos = Math.cos(yaw);
    const pitch = this.player.camera.rotation.x;
    const cosPitch = Math.cos(pitch);
    const forwardX = sin * cosPitch, forwardZ = cos * cosPitch, forwardY = -Math.sin(pitch);
    const rightX = cos, rightZ = -sin;

    const dirX = forwardX * moveZ + rightX * moveX;
    const dirZ = forwardZ * moveZ + rightZ * moveX;
    const dirY = forwardY * moveZ + moveY;
    const len = Math.hypot(dirX, dirY, dirZ);
    if (len > 0.0001) {
      const scale = (speed * dt) / len;
      this.freeCamPosition.x += dirX * scale;
      this.freeCamPosition.y += dirY * scale;
      this.freeCamPosition.z += dirZ * scale;
    }
    this.freeCamPosition.y = Math.min(TUNING.freeCam.verticalCeiling, Math.max(TUNING.freeCam.verticalFloor, this.freeCamPosition.y));

    this.player.camera.position.copyFrom(this.freeCamPosition);
    // The camera is unparented in freecam, so it no longer inherits yaw from the player root.
    // updateLook()/applyPredicted force camera.rotation.y = 0 (yaw normally lives on the root), so
    // without re-applying yaw here the fly-cam is locked facing world-Z and can't turn horizontally.
    this.player.camera.rotation.y = yaw;
    this.player.camera.rotation.x = pitch;
    this.player.camera.getViewMatrix(true);
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
    this.applyCrouchCameraHeight(movement.crouching, movement.sliding);
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
  private applyCrouchCameraHeight(crouching: boolean, sliding: boolean): void {
    const stand = TUNING.player.eyeHeight;
    const crouch = TUNING.player.eyeHeight * TUNING.player.crouchHeightMultiplier;
    const slide = TUNING.player.eyeHeight * TUNING.slide.heightScale;
    const target = sliding ? slide : crouching ? crouch : stand;
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
      const connectionDebug = this.multiplayer.getConnectionDebug();
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
        ` ping=${this.multiplayer.pingMs ?? -1}ms jitter=${connectionDebug.pingJitterMs.toFixed(1)}ms pongAge=${connectionDebug.lastPongAgeMs ?? -1}ms missed=${connectionDebug.missedPongs}` +
        ` inputPackets=${(this.onlineRateLogInputCount / elapsed).toFixed(1)}/s` +
        ` renderFps=${(this.onlineRateLogFrameCount / elapsed).toFixed(1)}` +
        ` remoteBuffer=${renderStats.remoteInterpolationBufferSize}` +
        ` ballBuffer=${renderStats.ballInterpolationBufferSize}` +
        ` renderDelay=${renderStats.renderDelayMs}ms` +
        ` latestSnapshotAge=${renderStats.latestSnapshotAgeMs}ms` +
        ` oldestSnapshotAge=${renderStats.oldestSnapshotAgeMs}ms` +
        ` wsBuffered=${connectionDebug.socketBufferedAmount}B` +
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

  private updateNetFlightRecorder(snapshot: ServerSnapshot | null): void {
    const renderStats = this.networkRenderer.getDebugStats();
    const local = snapshot?.room.players[this.multiplayer.localPlayerId] ?? null;
    this.netFlightRecorder.update({
      multiplayer: this.multiplayer,
      renderStats,
      pendingInputs: this.pendingInputs.length,
      ackAgeMs: this.ackAgeMs(),
      lastAckedInputSeq: this.lastAckedSeq,
      lastAuthoritativeTick: snapshot?.tick ?? this.lastSeenSnapshotTick,
      activePlayers: snapshot ? Object.keys(snapshot.room.players).length : 0,
      activeBalls: snapshot ? Object.keys(snapshot.room.balls).length : 0,
      localPlayerAlive: local ? local.combatState === 'alive' : null,
      graphicsPreset: defaultFlightRecorderGraphicsPreset(),
      matchPhase: snapshot?.room.match.status ?? 'offline'
    });
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

  private tryRequestMatchFullscreen(): void {
    if (document.fullscreenElement) return;
    const requestFullscreen = document.documentElement.requestFullscreen;
    if (typeof requestFullscreen !== 'function') return;
    const result = requestFullscreen.call(document.documentElement);
    if (result && typeof result.catch === 'function') {
      // Browsers usually require a user gesture for fullscreen. Countdown snapshots are async, so
      // this is best-effort; the start-vote interaction path above gives it a real click/hold event.
      result.catch(() => {});
    }
  }

  private enterOnlineMode(): void {
    if (this.onlineModeActive) return;
    this.onlineModeActive = true;
    this.onlineModeStartedAtMs = Date.now();
    // Force-deactivate the Creator Sandbox editor (no sandbox restore — the online path tears the
    // sandbox down next) and hide its entry sign, so the editor is fully inert during online play.
    this.creator?.forceDeactivate();
    this.creator?.setEntrySignVisible(false);
    // Tear down the local Movement Sandbox before connected play: clears the player's world override
    // + respawn, disables its meshes, removes its collision boxes, and restores the sky/fog. The
    // standard online setup below (props off, balls cleared, mats reset) is idempotent with this.
    this.movementSandbox?.exit(this.player);
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
    // Mats start upright online; server mat state then drives them via applyOnlineMats (including
    // hiding any the host's mat preset excludes). Re-show every mat here so a previous session's
    // preset-hidden mats don't stay invisible.
    this.gym.resetMats();
    for (const mat of this.gym.mats) mat.mesh.setEnabled(true);
    this.knockedNetMatIds.clear();
    this.excludedNetMatIds.clear();
    this.netCollisionBoxes = createPlayerCollisionBoxes();
    this.lastOnlineScoreByTeamId = {};
    this.pendingOnlineScoreEvents = [];
    this.lastOnlineWinnerTeamId = null;
    this.lastOnlineMatchStatus = null;
    this.lastOnlineBallBounceCount.clear();
    this.lastTeamChoiceAnnouncementKeyByPlayerId.clear();
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
    this.lastOnlineMatchStatus = null;
    this.lastOnlineBallBounceCount.clear();
    this.lastTeamChoiceAnnouncementKeyByPlayerId.clear();
    this.lastResetSerial = -1;
    this.lastResetVoteKey = '';
    this.onlineTeamSelector.setEnabled(false);
    this.player.hands.clearHands();
    this.player.resetPosition();
    this.quickBot.reset();
    this.chargeBot.reset();
    this.setPracticePropsEnabled(true);
    this.ballManager.spawnCenterLineBalls();
    // Restore upright + VISIBLE mats and their player collision when returning to practice (a host
    // mat preset may have hidden some online). resetMats rebuilds all mat collision boxes.
    this.gym.resetMats();
    for (const mat of this.gym.mats) mat.mesh.setEnabled(true);
    this.knockedNetMatIds.clear();
    this.excludedNetMatIds.clear();
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
    this.perfReportUnchangedInputCount = 0;
    this.perfReportInputEdgeCount = 0;
    this.perfReportInputJsonBytesTotal = 0;
    this.perfReportInputJsonBytesMax = 0;
    this.perfReportInputJsonByteSamples = 0;
    this.perfReportFrameMsTotal = 0;
    this.perfReportFrameMsMax = 0;
    this.perfReportFramesOver50Ms = 0;
    this.perfReportFramesOver100Ms = 0;
    this.perfReportFramesOver250Ms = 0;
    this.perfReportFrameBuckets.fill(0);
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

  private activateLobbyPortal(action: LobbyPortalAction): void {
    if (action.type === 'matchmaking') {
      this.openLobbyMode(action.mode);
      return;
    }
    this.enterMovementCourse();
  }

  private openLobbyMode(mode: LobbyMode): void {
    this.multiplayerOverlay.openMode(mode);
  }

  private enterMovementCourse(): void {
    if (this.onlineModeActive || this.multiplayer.connected) return;
    if (!this.movementSandbox) {
      this.movementSandbox = new MovementSandbox(this.scene, this.gym);
    }
    this.resetBackflipQte();
    this.player.hands.clearHands();
    // No stray practice balls in the sandbox (it has none); clears them from the gym.
    this.ballManager.clear();
    // Hide practice/match furniture (wall, portals, guide, bots, dummies) while in the sandbox.
    this.setPracticePropsEnabled(false);
    this.movementSandbox.enter(this.player);
    this.ensureCreator();
    this.creator?.setEntrySignVisible(true);
    this.creatorEntryHold = 0;
    this.hud.showScoreEvent('MOVEMENT SANDBOX', 'Free movement practice — hold E at the portal to leave', 'neutral');
  }

  private leaveMovementCourse(): void {
    const sandbox = this.movementSandbox;
    if (!sandbox || !sandbox.active) return;
    const ret = sandbox.lobbyReturn;
    this.creator?.setEntrySignVisible(false);
    this.creatorEntryHold = 0;
    sandbox.exit(this.player);
    this.setPracticePropsEnabled(true);
    this.ballManager.spawnCenterLineBalls();
    this.player.hands.clearHands();
    this.player.teleportTo(ret.position, ret.yaw, 0);
    this.hud.showScoreEvent('PRACTICE LOBBY', 'Left the movement sandbox', 'neutral');
  }

  /** Lazily build the developer Creator Sandbox editor (offline-only; gated by password + online check). */
  private ensureCreator(): void {
    if (this.creator) return;
    this.creator = new CreatorEditor(this.scene, this.gym, this.player, this.input, {
      isOnline: () => this.onlineModeActive || this.multiplayer.connected,
      suspendSandbox: () => this.movementSandbox?.suspend(),
      resumeSandbox: () => this.movementSandbox?.resume(this.player),
      setHudVisible: (visible: boolean) => this.hud.setVisible(visible)
    });
  }

  /** Offline step while the Creator Sandbox is active (replaces the normal sandbox/practice step). */
  private stepCreator(dt: number): void {
    const creator = this.creator;
    if (!creator) return;
    if (creator.getModePublic() === 'playtest') {
      // = toggles a free-fly noclip mid-test; B / F1 / Esc return to Build (never stuck in playtest).
      if (this.input.wasKeyPressed('Equal')) creator.togglePlaytestFly();
      if (this.input.wasKeyPressed('KeyB') || this.input.wasKeyPressed('F1') || this.input.wasKeyPressed('Escape')) {
        creator.setMode('build');
      } else if (!creator.isPlaytestFlying()) {
        // Real local first-person movement against the editor's collision/world.
        this.player.update(dt, false);
        const snap = this.player.lastMovementSnapshot;
        this.updateLocalMovementFoley(dt, vector3ToVec3(snap.velocity), snap.grounded, snap.sliding, snap.dashingThisFrame, snap.wallRunning);
        this.effects.update(dt);
      } else {
        this.effects.update(dt);
      }
    }
    creator.step(dt);
  }

  /** Drive the Creator Sandbox entry sign prompt + hold-E unlock while in the (non-creator) sandbox. */
  private updateCreatorEntry(dt: number): void {
    const creator = this.creator;
    if (!creator || creator.isActive()) {
      this.creatorEntryHold = 0;
      return;
    }
    const pt = creator.entryWorldPoint();
    const p = this.player.root.position;
    const dx = p.x - pt.x;
    const dz = p.z - pt.z;
    const near = dx * dx + dz * dz <= CREATOR_ENTRY_RADIUS * CREATOR_ENTRY_RADIUS;
    const held = this.input.isKeyDown(CONTROL_KEYS.interact);
    if (near && held) this.creatorEntryHold = Math.min(CREATOR_ENTRY_HOLD_SECONDS, this.creatorEntryHold + dt);
    else this.creatorEntryHold = 0;
    creator.showEntryPrompt(near, this.creatorEntryHold / CREATOR_ENTRY_HOLD_SECONDS);
    if (this.creatorEntryHold >= CREATOR_ENTRY_HOLD_SECONDS) {
      this.creatorEntryHold = 0;
      creator.promptUnlock();
    }
  }

  private handleSandboxAction(action: SandboxAction): void {
    if (action === 'leave') this.leaveMovementCourse();
  }

  /**
   * Offline-only lean step for the active Movement Sandbox: movement foley + effects + the hold-E
   * leave portal. Pure free practice — no balls, bots, objectives, timers, checkpoints, or HUD, and
   * all the normal practice/match systems are intentionally skipped while the sandbox is active.
   */
  private stepMovementSandbox(dt: number): void {
    const sandbox = this.movementSandbox;
    if (!sandbox) return;
    const snap = this.player.lastMovementSnapshot;
    this.updateLocalMovementFoley(dt, vector3ToVec3(snap.velocity), snap.grounded, snap.sliding, snap.dashingThisFrame, snap.wallRunning);
    this.effects.update(dt);
    sandbox.update(dt, this.player, this.input, (action) => this.handleSandboxAction(action));
    this.updateCreatorEntry(dt);
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
    this.lastTeamChoiceAnnouncementKeyByPlayerId.clear();
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
      const label = vote.mode === 'reset-teams' ? 'RESET TEAMS' : 'RESET MATCH';
      this.hud.showScoreEvent(label, `${vote.voteCount}/${vote.requiredVotes}`, 'neutral');
    }
  }

  private handleOnlineTeamChoiceEvents(snapshot: ServerSnapshot): void {
    const room = snapshot.room;
    if (room.match.mode !== '2v2' || room.match.status !== 'warmup') {
      this.lastTeamChoiceAnnouncementKeyByPlayerId.clear();
      return;
    }

    for (const player of Object.values(room.players)) {
      const chosen = room.startVote.teamChoicesByPlayerId[player.id] === true;
      const key = `${player.teamId}:${Number(chosen)}`;
      const previous = this.lastTeamChoiceAnnouncementKeyByPlayerId.get(player.id);
      this.lastTeamChoiceAnnouncementKeyByPlayerId.set(player.id, key);
      if (previous === undefined) continue;
      if (!chosen || previous === key) continue;
      this.hud.showTeamJoinEvent(`${player.name} has joined ${player.teamId} team!`, player.teamId);
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
      resetSerial: this.currentResetSerial(),
      interactHeld: this.input.isKeyDown(CONTROL_KEYS.interact)
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
          this.hud.showScoreEvent('HIT', `${target?.name ?? 'Opponent'} ${target?.lives ?? '-'} / ${snapshot.room.settings.livesPerPlayer} lives`, 'good');
        }
      } else if (event.targetId === this.multiplayer.localPlayerId) {
        this.hud.showHitMarker('bad');
        this.hud.pulseCrosshair('throw');
        if (snapshot.room.match.mode === '2v2') {
          const local = snapshot.room.players[event.targetId];
          this.hud.showScoreEvent('LIFE LOST', `${local?.lives ?? '-'} / ${snapshot.room.settings.livesPerPlayer} lives remaining`, 'bad');
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

  private updateBoundaryClockSound(remainingSeconds: number, noBoundaries: boolean): void {
    const displayedSecond = Math.max(0, Math.floor(remainingSeconds));

    if (!noBoundaries) {
      if (this.lastBoundaryClockDisplaySecond !== null && displayedSecond > this.lastBoundaryClockDisplaySecond) {
        this.lastBoundaryClockTickSecond = null;
      }
      this.boundaryOpenConfirmPlayed = false;
      this.boundaryCountdownWasActive = remainingSeconds > 0;
      this.lastBoundaryClockDisplaySecond = displayedSecond;

      if (displayedSecond < 1 || displayedSecond > GAME_CONSTANTS.match.halfCourtCountdownSeconds) {
        if (displayedSecond > GAME_CONSTANTS.match.halfCourtCountdownSeconds) this.lastBoundaryClockTickSecond = null;
        return;
      }

      if (displayedSecond === this.lastBoundaryClockTickSecond) return;
      this.lastBoundaryClockTickSecond = displayedSecond;
      this.sound.clockTick(displayedSecond);
      return;
    }

    this.lastBoundaryClockTickSecond = null;
    this.lastBoundaryClockDisplaySecond = 0;
    if (!this.boundaryCountdownWasActive || this.boundaryOpenConfirmPlayed) return;
    this.boundaryOpenConfirmPlayed = true;
    this.boundaryCountdownWasActive = false;
    this.sound.boundaryOpenConfirm();
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
    if (this.showcaseEnabled) {
      this.createShowcaseLighting();
      return;
    }
    // Competitive lighting: one hemispheric fill + one directional key, and the single shadow
    // generator bound to the key light. Casters (mats / moving dummy / remote players) are
    // registered after they exist; static geometry is never a caster.
    const { key } = applyCompetitiveLighting(this.scene);
    // Competitive shadow tier: 1024 map (High tier would be 2048 via the same option). Darkness at
    // the most-visible end of the spec band (0.18) so player/mat/dummy shadows read clearly on the
    // busy decal-stacked floor without darkening the room overall (only shadowed pixels are tinted).
    createCompetitiveShadowSystem(this.scene, key, { mapSize: 1024, darkness: 0.18 });
    // Route dynamic caster registration (mats/dummies here, remote players in NetworkRenderer) to the
    // competitive single-generator system.
    setActiveGymShadowRegistrar(registerCompetitiveShadowCaster);
  }

  /**
   * Showcase lighting: even ambient room light — one broad HemisphericLight fill (darker cool ground so
   * corners/under-surfaces fall off naturally for depth) + one angled DirectionalLight key that drives
   * the SINGLE ShadowGenerator. The ceiling fixtures are emissive housings, not light sources (no
   * spotlight pools). Dynamic caster registration is routed to that single-generator system.
   */
  private createShowcaseLighting(): void {
    const { key } = applyShowcaseLighting(this.scene, this.showcaseTier);
    createShowcaseShadowSystem(this.scene, key, this.showcaseTier);
    setActiveGymShadowRegistrar(registerShowcaseShadowCaster);
  }

  /**
   * Make the floor a shadow receiver and register the gym's dynamic shadow casters. Only the three
   * allowed dynamic categories cast: tipping cover mats, target dummies (the moving dummy AND the
   * three static ones), and — registered separately in NetworkRenderer — remote player bodies. Each
   * dummy is registered with descendants so its parented head/torso/limb submeshes cast too (the bare
   * root capsule alone would otherwise drop most of the silhouette). Static gym geometry (walls,
   * bleachers, ceiling, props, cones) is never a caster, and balls keep their cheap blob shadows.
   */
  private setupGymShadows(): void {
    const floor = this.scene.getMeshByName('gym_floor');
    if (floor) floor.receiveShadows = true;
    // Dynamic casters route through the mode-agnostic facade (the active system was wired in
    // createLighting): tipping cover mats + every target dummy. Remote player bodies register the same
    // way from NetworkRenderer.
    for (const mat of this.gym.mats) registerGymShadowCaster(mat.mesh);
    if (this.gym.movingDummy) registerGymShadowCaster(this.gym.movingDummy, true);
    // Static target dummies (name 'target_dummy', metadata.targetDummy) — register with descendants.
    // setEnabled() toggling between practice/online is respected automatically: a disabled caster is
    // simply skipped when the shadow map renders, so this is safe even while they are hidden online.
    for (const mesh of this.scene.meshes) {
      if (mesh instanceof Mesh && mesh.metadata?.targetDummy && mesh !== this.gym.movingDummy) {
        registerGymShadowCaster(mesh, true);
      }
    }

    if (this.showcaseEnabled) this.setupShowcaseStaticShadows();
  }

  /**
   * Showcase-only (Part 3): large static occluders cast roof-origin shadows (bleachers, major wall-pad
   * strips, scoreboard casing) so under-bleacher areas, corners, and pad seams gain real depth; and the
   * big court surfaces receive shadows (lower walls, bleacher platforms, cover mats). Competitive never
   * makes static geometry a caster, so this runs only in Showcase mode. Tiny props/cones/decals/HUD/
   * first-person/UI meshes are deliberately excluded.
   */
  private setupShowcaseStaticShadows(): void {
    for (const mesh of this.scene.meshes) {
      if (!(mesh instanceof Mesh)) continue;
      const name = mesh.name;
      // Static occluders that visibly affect the court.
      const isBleacherStructure = name.startsWith('bleacher_');
      const isWallPadStrip = name.startsWith('decor_wall_pad_raised_panel_');
      const isScoreboardCasing = name.startsWith('decor_scoreboard_back_panel_');
      if (isBleacherStructure || isWallPadStrip || isScoreboardCasing) {
        registerGymShadowCaster(mesh);
      }
      // Receivers: floor (already set), the four lower walls, bleacher platforms/seats, and cover mats.
      const isWall = name.endsWith('_wall');
      const isCoverMat = name === 'mat';
      if (isBleacherStructure || isWallPadStrip || isWall || isCoverMat) {
        mesh.receiveShadows = true;
      }
    }
  }

  /**
   * Wire each gym PBR surface's reflection response to the hidden HDR environment
   * (scene.environmentTexture, loaded in GymVisualRevamp.applyGymEnvironment). These materials leave
   * `reflectionTexture` unset, so they sample scene.environmentTexture directly — no reflection probe
   * and no per-frame reflection render. The per-surface `environmentIntensity` values are the single
   * authoritative source in GYM_REFLECTION_TARGETS; applying them here, after gym build, guarantees
   * every targeted material exists. The floor gets the broad waxed sheen; walls/mats/bleachers get
   * only a faint satin response.
   */
  private setupGymEnvironmentResponse(): void {
    // Neutral has no environment/reflection source (see GymVisualRevamp.applyGymEnvironment), so
    // there is nothing to wire — leaving each PBR material's default environmentIntensity (1.0)
    // pointed at an unset scene.environmentTexture contributes zero reflection either way, but
    // skipping this loop keeps the diagnostic baseline's intent explicit.
    if (this.neutralEnabled) {
      if (isGraphicsDebugEnabled()) this.logGraphicsDebugReport();
      return;
    }
    for (const target of GYM_REFLECTION_TARGETS) {
      const material = this.scene.getMaterialByName(target.materialName);
      if (!(material instanceof PBRMaterial)) continue;
      material.environmentIntensity = target.environmentIntensity;
    }
    // Showcase overrides the competitive reflection targets just applied: stronger environment response
    // for the .env, roughness inside the spec bands, and a higher PBR simultaneous-light cap so surfaces
    // react to all four roof spots. Applied last so Showcase always wins. No-op in Competitive mode.
    if (this.showcaseEnabled) {
      applyShowcaseGymMaterials(this.scene);
      // RECOVERY: the static reflection probe is NOT instantiated this phase — the scene must pass a
      // direct-light/material baseline first. createGymReflectionProbe is preserved (see GymReflectionProbe)
      // and intentionally not called here; no reflection source is active in any mode.
    }
    if (isGraphicsDebugEnabled()) this.logGraphicsDebugReport();
  }

  /**
   * Debug-only shadow + environment audit (gated by isGraphicsDebugEnabled). One-shot at gym build,
   * so it's safe to leave the flag on. Prints the explicit shadow-proof the recovery task asks for:
   * whether the single generator is active, its map resolution + filtering, whether the floor mesh
   * actually receives shadows, the registered caster roots, and the true render-list child counts per
   * dynamic category (mat / dummy / remote player) — the per-category counts are what confirm the
   * visible child submeshes (dummy head/torso/limbs, etc.) are really in the shadow pass.
   */
  private logGraphicsDebugReport(): void {
    const engine = this.scene.getEngine();
    const floorMat = this.scene.getMaterialByName('floor_material');
    const pbrLightLimit = floorMat instanceof PBRMaterial ? floorMat.maxSimultaneousLights : 'n/a';
    console.log('[graphics] === graphics audit ===');
    console.log(`[graphics] Active mode: ${resolveGraphicsMode()}${this.showcaseEnabled ? ` (tier=${this.showcaseTier})` : ''}`);
    console.log(`[graphics] PBR maxSimultaneousLights (floor): ${pbrLightLimit}`);
    console.log(`[graphics] FPS: ${engine.getFps().toFixed(1)} frameTime: ${engine.getDeltaTime().toFixed(2)}ms`);
    if (this.showcaseEnabled) {
      this.logShowcaseGraphicsReport();
    } else {
      this.logCompetitiveGraphicsReport();
    }
    const env = getGymEnvironmentDebugInfo();
    console.log(
      `[graphics] environment: kind=${env.kind} name=${env.name ?? 'n/a'}` +
      ` size=${env.size ?? 'n/a'} loaded=${env.loaded}`
    );
  }

  private logCompetitiveGraphicsReport(): void {
    const stats = getCompetitiveGraphicsDebugStats();
    const floor = this.scene.getMeshByName('gym_floor');
    const floorReceives = floor ? floor.receiveShadows : false;
    const byRoot = stats.shadow.casterCountsByCategory;
    const byMesh = stats.shadow.renderListCountsByCategory;
    console.log(`[graphics] Lights: 1 hemi + 1 directional key (Competitive)`);
    console.log(`[graphics] ShadowGenerator: ${stats.shadow.activeGeneratorCount === 1 ? 'active' : 'inactive'}` +
      ` (generators=${stats.shadow.activeGeneratorCount}, lifetimeCreated=${stats.shadow.lifetimeCreateCount})`);
    console.log(`[graphics] Shadow map: resolution=${stats.shadow.mapSize ?? 'n/a'} filtering=${stats.shadow.filteringMode}` +
      ` darkness=${stats.shadow.darkness ?? 'n/a'}`);
    console.log(`[graphics] Floor receives shadows: ${floorReceives ? 'yes' : 'no'}`);
    console.log(`[graphics] Registered casters: ${stats.shadow.casterCount}` +
      ` (mat=${byRoot.mat} dummy=${byRoot.dummy} remotePlayer=${byRoot.remotePlayer} other=${byRoot.other})`);
    console.log(`[graphics] Shadow render-list meshes (children included): ${stats.shadow.renderListCount}`);
    console.log(`[graphics] Registered player mesh children: ${byMesh.remotePlayer}`);
    console.log(`[graphics] Registered mat mesh children: ${byMesh.mat}`);
    console.log(`[graphics] Registered dummy mesh children: ${byMesh.dummy}`);
    console.log(`[graphics] SSAO: disabled (Competitive)`);
  }

  private logShowcaseGraphicsReport(): void {
    const stats = getShowcaseGraphicsDebugStats();
    const floor = this.scene.getMeshByName('gym_floor');
    const floorReceives = floor ? floor.receiveShadows : false;
    const lights = stats.lights;
    const byRoot = stats.shadow.casterCountsByCategory;
    const byMesh = stats.shadow.renderListCountsByCategory;
    console.log(`[graphics] Lights: ${lights.hemiCount} hemi + ${lights.keyCount} directional key` +
      ` (Showcase, even fill) = ${lights.hemiCount + lights.keyCount} total`);
    console.log(`[graphics] ShadowGenerators: ${stats.shadow.generatorCount} (lifetimeCreated=${stats.shadow.lifetimeCreateCount})`);
    console.log(`[graphics] Shadow map: resolution=${stats.shadow.mapSize ?? 'n/a'}` +
      ` filtering=${stats.shadow.filteringMode} darkness=${stats.shadow.darkness ?? 'n/a'}`);
    console.log(`[graphics] Floor receives shadows: ${floorReceives ? 'yes' : 'no'}`);
    console.log(`[graphics] Registered casters: ${stats.shadow.casterCount}` +
      ` (mat=${byRoot.mat} dummy=${byRoot.dummy} remotePlayer=${byRoot.remotePlayer} static=${byRoot.static} other=${byRoot.other})`);
    console.log(`[graphics] Shadow render-list meshes (children included): ${stats.shadow.renderListCount}` +
      ` (static=${byMesh.static} mat=${byMesh.mat} dummy=${byMesh.dummy} remotePlayer=${byMesh.remotePlayer})`);
    const probe = getGymReflectionProbeDebugInfo();
    console.log(`[graphics] ReflectionProbe: ${probe.active ? 'active' : 'none'}` +
      ` (count=${probe.active ? 1 : 0} resolution=${probe.resolution ?? 'n/a'} renderListMeshes=${probe.renderListCount ?? 'n/a'})`);
    const ssao = this.showcasePostFx?.getDebugInfo();
    console.log(`[graphics] SSAO: ${ssao?.ssaoEnabled ? 'enabled' : 'disabled'}` +
      ` (supported=${ssao?.ssaoSupported ?? 'n/a'} strength=${ssao?.ssaoStrength ?? 'n/a'}` +
      ` radius=${ssao?.ssaoRadius ?? 'n/a'} base=${ssao?.ssaoBase ?? 'n/a'})` +
      ` Bloom: disabled Post: FXAA${ssao?.ssaoEnabled ? ' + SSAO' : ' only'}`);
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

/**
 * Graphics-debug gate for the one-shot [graphics] shadow/reflection setup report logged right after
 * the gym builds. OFF by default (it's a one-time print, not a spam risk, but stays opt-in like the
 * other debug flags); enable with `localStorage.setItem('strafeball.debug.graphics', '1')`.
 */
function isGraphicsDebugEnabled(): boolean {
  try {
    return window.localStorage.getItem('strafeball.debug.graphics') === '1';
  } catch {
    return false;
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

function percentileFromBuckets(buckets: readonly number[], totalCount: number, percentile: number): number {
  if (totalCount <= 0) return 0;
  const target = Math.max(1, Math.ceil(totalCount * percentile));
  let seen = 0;
  for (let i = 0; i < buckets.length; i += 1) {
    seen += buckets[i];
    if (seen >= target) return PERF_FRAME_BUCKETS_MS[i];
  }
  return PERF_FRAME_BUCKETS_MS[PERF_FRAME_BUCKETS_MS.length - 1];
}

function networkInputStateEquals(a: PlayerInput, b: PlayerInput): boolean {
  return (
    a.moveX === b.moveX &&
    a.moveZ === b.moveZ &&
    vec3StateEquals(a.dashDirection, b.dashDirection) &&
    a.lookYawRadians === b.lookYawRadians &&
    a.lookPitchRadians === b.lookPitchRadians &&
    a.jumpPressed === b.jumpPressed &&
    a.jumpHeld === b.jumpHeld &&
    a.dashPressed === b.dashPressed &&
    a.crouchPressed === b.crouchPressed &&
    a.crouchHeld === b.crouchHeld &&
    a.slidePressed === b.slidePressed &&
    a.slideHeld === b.slideHeld &&
    a.backflipPressed === b.backflipPressed &&
    a.pickupPressed === b.pickupPressed &&
    a.dropPressed === b.dropPressed &&
    a.fakeThrowPressed === b.fakeThrowPressed &&
    a.fakeThrowHeld === b.fakeThrowHeld &&
    a.leftHandPressed === b.leftHandPressed &&
    a.leftHandHeld === b.leftHandHeld &&
    a.rightHandPressed === b.rightHandPressed &&
    a.rightHandHeld === b.rightHandHeld &&
    a.leftHandReleased === b.leftHandReleased &&
    a.rightHandReleased === b.rightHandReleased &&
    a.leftCatchAttemptId === b.leftCatchAttemptId &&
    a.rightCatchAttemptId === b.rightCatchAttemptId &&
    a.backflipThrowTier === b.backflipThrowTier &&
    a.resetSerial === b.resetSerial &&
    a.interactHeld === b.interactHeld
  );
}

function vec3StateEquals(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function countInputEdges(input: PlayerInput): number {
  let count = 0;
  if (input.jumpPressed) count += 1;
  if (input.dashPressed) count += 1;
  if (input.crouchPressed) count += 1;
  if (input.slidePressed) count += 1;
  if (input.backflipPressed) count += 1;
  if (input.pickupPressed) count += 1;
  if (input.dropPressed) count += 1;
  if (input.fakeThrowPressed) count += 1;
  if (input.leftHandPressed) count += 1;
  if (input.rightHandPressed) count += 1;
  if (input.leftHandReleased) count += 1;
  if (input.rightHandReleased) count += 1;
  return count;
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
    resetSerial: 0,
    interactHeld: false
  };
}
