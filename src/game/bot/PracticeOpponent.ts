import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS } from '../../../shared/constants';
import { sweptBallHitsBody } from '../../../shared/simulation/CollisionMath';
import { sweptCatchFailReason } from '../../../shared/simulation/HandSim';
import { calculateThrow } from '../../../shared/simulation/ThrowMath';
import { shockwavePlayerVelocity } from '../../../shared/simulation/ShockwaveSim';
import type { BallState as SharedBallState, PowerupKind, Vec3 } from '../../../shared/types';
import { Ball } from '../ball/Ball';
import { BallManager } from '../ball/BallManager';
import { BallState, type HandSide } from '../ball/BallState';
import { TUNING } from '../config/tuning';
import { addPolishedGlowOccluder } from '../effects/PolishedPostFX';
import type { AABB, CollisionWorld } from '../map/Collider';
import { BackflipController } from '../player/BackflipController';
import { DashController } from '../player/DashController';
import type { BotDifficulty } from '../practice/PracticeState';
import { findClearFiringPosition, shotLaneClear, shotTrajectoryClear } from './OpponentCover';
import { OpponentNavigation } from './OpponentNavigation';
import { findCoverPlan, type OpponentCoverPlan } from './OpponentCoverTactics';

export type PracticeOpponentThrowType = 'quick' | 'charged' | 'curve' | 'backflip';

/** Cues visible in the player's hand and movement animations, never their raw inputs. */
export interface PracticeOpponentPlayerObservation {
  catching: boolean;
  charging: boolean;
  dashing: boolean;
}

export interface PracticeOpponentPowerupContext {
  speedActive: boolean;
  adrenalineActive: boolean;
  magnetActive: boolean;
  armorCount: number;
}

export interface PracticeOpponentBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  /** Minimum Z at which this opponent may collect a ball. Defaults to minZ. */
  ownSideMinZ?: number;
  floorY?: number;
}

export interface PracticeOpponentOptions {
  /** Feet position. A gym position defaults to the red half; distant Creator markers get a local area. */
  position?: Vector3;
  bounds?: PracticeOpponentBounds;
  /** Optional player collision world, so standing mats and walls also block the opponent. */
  collision?: CollisionWorld;
}

export interface PracticeOpponentFrameEvents {
  threw: boolean;
  throwType?: PracticeOpponentThrowType;
  dashed: boolean;
  backflipped: boolean;
  feinted?: boolean;
}

export interface PracticeOpponentBallEvent {
  kind: 'catch' | 'hit';
  speed: number;
}

const EYE_HEIGHT = 1.55;
const BODY_CENTER_HEIGHT = 0.92;
const BODY_RADIUS = 0.38;
const PICKUP_DISTANCE = Math.min(TUNING.ball.pickupRadius, 1.65);
const REACTION: Record<BotDifficulty, number> = { easy: 0.21, normal: 0.12, hard: 0.07 };
const CATCH_CHANCE: Record<BotDifficulty, number> = { easy: 0.25, normal: 0.5, hard: 0.68 };
const BOT_ID = 'practice-opponent';

let nextOpponentId = 1;

/**
 * Offline practice opponent. It never creates ammunition: it runs to a settled, reachable ball on
 * its half, picks it up, then uses the same shared throw calculation as a player. All defensive
 * ball decisions use the segment integrated by BallManager, before world bounces can hide a hit.
 */
export class PracticeOpponent {
  private static readonly throwOwners = new WeakMap<Ball, PracticeOpponent>();
  public readonly mesh: Mesh;
  public readonly dash = new DashController();
  public readonly backflip = new BackflipController();

  private readonly id = nextOpponentId++;
  private readonly spawn: Vector3;
  private readonly bounds: Required<PracticeOpponentBounds>;
  private readonly collision?: CollisionWorld;
  private readonly navigation: OpponentNavigation;
  private readonly bodyMaterial: PBRMaterial;
  private readonly trimMaterial: PBRMaterial;
  private readonly arm: TransformNode;
  private readonly hand: TransformNode;
  private readonly rightArm: TransformNode;
  private readonly rightHand: TransformNode;
  private readonly velocity = Vector3.Zero();
  private readonly seenThreatSeconds = new Map<number, number>();

  private enabled = true;
  private difficulty: BotDifficulty = 'normal';
  private held: Ball | null = null;
  private reserve: Ball | null = null;
  private seekSecondBall = false;
  private possessionSeconds = 0;
  private plannedWait = 0;
  private followupShot = false;
  private playerRecoveryUntil = -1;
  private observedPlayer: PracticeOpponentPlayerObservation = { catching: false, charging: false, dashing: false };
  private readonly observationQueue: { at: number; value: PracticeOpponentPlayerObservation }[] = [];
  private playerChargeSeconds = 0;
  private readCharge = false;
  private willFeint = false;
  private feintUsed = false;
  private feintUntil = -1;
  private releasePoseUntil = -1;
  private releaseHand: HandSide = 'left';
  private pairPlan: 'none' | 'pressure' | 'reserve' = 'none';
  private comboReacted = false;
  private lastShotAt = -10;
  private lastShotBall: Ball | null = null;
  private coverPlan: OpponentCoverPlan | null = null;
  private coverPhase: 'none' | 'hide' | 'peek' = 'none';
  private coverUntil = 0;
  private coverSearchAt = 0;
  private coverSide: -1 | 1 = 1;
  private relocateUntil = 0;
  private elapsed = 0;
  private holdSeconds = 0;
  private throwCooldown = 0.55;
  private chosenThrow: PracticeOpponentThrowType = 'quick';
  private throwIndex = 0;
  private pursuitSeconds = 0;
  private travelDashCooldown = 0;
  private dashActiveSeconds = 0;
  private backflipStartedForThrow = false;
  private backflipLandedAt = -1;
  private catchOpenedAtMs = -1;
  private catchActiveUntilMs = -1;
  private catchCooldown = 0;
  private dodgeCooldown = 0;
  private hitStun = 0;
  private hitFlash = 0;
  private airborneHeight = 0;
  private verticalVelocity = 0;
  private targetBallId: number | null = null;
  private cachedPickup: Ball | null = null;
  private pickupSearchAt = 0;
  private lastPlayerEye = new Vector3(0, EYE_HEIGHT, -8);
  private readonly playerVelocity = Vector3.Zero();
  private hasPlayerPosition = false;
  private powerups?: PracticeOpponentPowerupContext;
  private stunSeconds = 0;
  private impulseSeconds = 0;
  private firingPosition: Vector3 | null = null;
  private firingSearchCooldown = 0;
  private stuckGrenades = new Set<Ball>();

  constructor(
    private readonly scene: Scene,
    private readonly ballManager: BallManager,
    options: PracticeOpponentOptions = {}
  ) {
    this.spawn = options.position?.clone() ?? new Vector3(0, 0, 9);
    const inGym = Math.abs(this.spawn.x) < TUNING.map.halfWidth && Math.abs(this.spawn.z) < TUNING.map.halfLength;
    const sourceBounds = options.bounds ?? (inGym
      ? { minX: -9.5, maxX: 9.5, minZ: 0.8, maxZ: 16.5, ownSideMinZ: 0.65, floorY: 0 }
      : { minX: this.spawn.x - 4, maxX: this.spawn.x + 4, minZ: this.spawn.z - 4,
          maxZ: this.spawn.z + 4, ownSideMinZ: this.spawn.z - 4, floorY: this.spawn.y });
    this.bounds = {
      ...sourceBounds,
      ownSideMinZ: sourceBounds.ownSideMinZ ?? sourceBounds.minZ,
      floorY: sourceBounds.floorY ?? this.spawn.y
    };
    this.collision = options.collision;
    this.navigation = new OpponentNavigation(this.bounds, this.collision, BODY_RADIUS);

    this.bodyMaterial = new PBRMaterial(`practice_opponent_body_${this.id}`, scene);
    this.bodyMaterial.albedoColor = new Color3(0.81, 0.24, 0.2);
    this.bodyMaterial.emissiveColor = new Color3(0.08, 0.015, 0.012);
    this.bodyMaterial.metallic = 0.04;
    this.bodyMaterial.roughness = 0.4;
    this.trimMaterial = new PBRMaterial(`practice_opponent_trim_${this.id}`, scene);
    this.trimMaterial.albedoColor = new Color3(0.12, 0.15, 0.23);
    this.trimMaterial.metallic = 0.12;
    this.trimMaterial.roughness = 0.38;

    this.mesh = MeshBuilder.CreateCapsule(`practice_opponent_${this.id}`, {
      height: 1.8, radius: 0.29, tessellation: 14
    }, scene);
    this.mesh.position.set(this.spawn.x, this.bounds.floorY + BODY_CENTER_HEIGHT, this.spawn.z);
    this.mesh.material = this.bodyMaterial;
    this.mesh.isPickable = false;
    this.mesh.metadata = { practiceOpponent: true, team: 'red' };
    this.buildBody();

    this.arm = new TransformNode(`practice_opponent_arm_${this.id}`, scene);
    this.arm.parent = this.mesh;
    this.arm.position.set(-0.34, 0.35, -0.02);
    const forearm = MeshBuilder.CreateCapsule(`practice_opponent_forearm_${this.id}`, {
      height: 0.58, radius: 0.075, tessellation: 10
    }, scene);
    forearm.parent = this.arm;
    forearm.position.y = -0.27;
    forearm.material = this.bodyMaterial;
    forearm.isPickable = false;
    const glove = MeshBuilder.CreateSphere(`practice_opponent_glove_${this.id}`, { diameter: 0.2, segments: 10 }, scene);
    glove.parent = this.arm;
    glove.position.y = -0.56;
    glove.material = this.trimMaterial;
    glove.isPickable = false;
    this.hand = new TransformNode(`practice_opponent_hand_${this.id}`, scene);
    this.hand.parent = this.arm;
    this.hand.position.set(0, -0.59, -0.08);

    this.rightArm = new TransformNode(`practice_opponent_right_arm_${this.id}`, scene);
    this.rightArm.parent = this.mesh;
    this.rightArm.position.set(0.34, 0.35, -0.02);
    const rightForearm = forearm.clone(`practice_opponent_right_forearm_${this.id}`, this.rightArm)!;
    rightForearm.position.y = -0.27;
    glove.clone(`practice_opponent_right_glove_${this.id}`, this.rightArm);
    this.rightHand = new TransformNode(`practice_opponent_right_hand_${this.id}`, scene);
    this.rightHand.parent = this.rightArm;
    this.rightHand.position.set(0, -0.59, -0.08);

    addPolishedGlowOccluder(this.mesh);
    for (const child of this.mesh.getChildMeshes(false)) {
      if (child instanceof Mesh) addPolishedGlowOccluder(child);
    }
  }

  get isEnabled(): boolean { return this.enabled; }
  get isHoldingBall(): boolean { return this.held !== null; }
  get heldBallCount(): number { return Number(this.held !== null) + Number(this.reserve !== null); }
  get attackPhase(): 'waiting' | 'windup' | 'feint' | 'release' {
    if (this.elapsed < this.releasePoseUntil) return 'release';
    if (this.elapsed < this.feintUntil) return 'feint';
    return this.held && this.holdSeconds > this.plannedWait ? 'windup' : 'waiting';
  }
  get feetPosition(): Vector3 { return new Vector3(this.mesh.position.x, this.bounds.floorY, this.mesh.position.z); }

  notifyBallHitPlayer(ball: Ball): void {
    if (PracticeOpponent.throwOwners.get(ball) !== this) return;
    PracticeOpponent.throwOwners.delete(ball);
    this.dash.addChargeFromHit();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.dropHeld();
    this.mesh.setEnabled(enabled);
    if (enabled) this.reset();
  }

  setDifficulty(difficulty: BotDifficulty): void {
    this.difficulty = difficulty;
  }

  reset(): void {
    this.dropHeld();
    this.mesh.position.set(this.spawn.x, this.bounds.floorY + BODY_CENTER_HEIGHT, this.spawn.z);
    this.mesh.rotation.setAll(0);
    this.velocity.setAll(0);
    this.airborneHeight = 0;
    this.verticalVelocity = 0;
    this.elapsed = 0;
    this.holdSeconds = 0;
    this.possessionSeconds = 0;
    this.seekSecondBall = false;
    this.plannedWait = 0;
    this.followupShot = false;
    this.playerRecoveryUntil = -1;
    this.observationQueue.length = 0;
    this.observedPlayer = { catching: false, charging: false, dashing: false };
    this.playerChargeSeconds = 0;
    this.readCharge = false;
    this.feintUsed = this.willFeint = false;
    this.feintUntil = this.releasePoseUntil = -1;
    this.pairPlan = 'none';
    this.lastShotAt = -10;
    this.lastShotBall = null;
    this.coverPlan = null;
    this.coverPhase = 'none';
    this.coverUntil = this.coverSearchAt = this.relocateUntil = 0;
    this.throwIndex = 0;
    this.chosenThrow = 'quick';
    this.pursuitSeconds = 0;
    this.travelDashCooldown = 0;
    this.dashActiveSeconds = 0;
    this.backflipStartedForThrow = false;
    this.backflipLandedAt = -1;
    this.throwCooldown = 0.55;
    this.catchOpenedAtMs = -1;
    this.catchActiveUntilMs = -1;
    this.catchCooldown = 0;
    this.dodgeCooldown = 0;
    this.hitStun = 0;
    this.stunSeconds = 0;
    this.impulseSeconds = 0;
    this.hasPlayerPosition = false;
    this.playerVelocity.setAll(0);
    this.powerups = undefined;
    this.firingPosition = null;
    this.firingSearchCooldown = 0;
    this.stuckGrenades.clear();
    this.hitFlash = 0;
    this.bodyMaterial.emissiveColor.set(0.08, 0.015, 0.012);
    this.seenThreatSeconds.clear();
    this.navigation.clear();
    this.targetBallId = null;
    this.cachedPickup = null;
    this.pickupSearchAt = 0;
    this.dash.refill();
    this.backflip.active = false;
    this.backflip.timer = 0;
    this.backflip.cooldown = 0;
  }

  dispose(): void {
    this.dropHeld();
    this.mesh.dispose(false, true);
    this.bodyMaterial.dispose();
    this.trimMaterial.dispose();
  }

  /** Called before BallManager.update in the ordinary offline frame. */
  update(dt: number, playerEye: Vector3, _playerRoot?: Vector3,
    powerups?: PracticeOpponentPowerupContext,
    observation?: PracticeOpponentPlayerObservation): PracticeOpponentFrameEvents {
    const events: PracticeOpponentFrameEvents = { threw: false, dashed: false, backflipped: false };
    if (!this.enabled || dt <= 0) return events;
    dt = Math.min(dt, TUNING.simulation.maxDeltaSeconds);
    this.elapsed += dt;
    this.observePlayer(dt, observation);
    // Clear-balls controls and detonations can remove a ball while it is still in a bot hand.
    if (this.reserve && !this.ballManager.balls.includes(this.reserve)) this.reserve = null;
    if (this.held && !this.ballManager.balls.includes(this.held)) {
      this.held = this.reserve;
      this.reserve = null;
      if (this.held) this.planThrow(false);
    }
    if (this.held) this.possessionSeconds += dt;
    if (this.hasPlayerPosition) {
      const observed = playerEye.subtract(this.lastPlayerEye).scale(1 / dt);
      if (observed.length() > 25) observed.normalize().scaleInPlace(25);
      Vector3.LerpToRef(this.playerVelocity, observed, Math.min(1, dt * 5), this.playerVelocity);
    }
    this.hasPlayerPosition = true;
    this.powerups = powerups;
    this.lastPlayerEye.copyFrom(playerEye);
    this.dash.update(dt);
    this.travelDashCooldown = Math.max(0, this.travelDashCooldown - dt);
    this.dashActiveSeconds = Math.max(0, this.dashActiveSeconds - dt);
    this.backflip.update(dt);
    this.catchCooldown = Math.max(0, this.catchCooldown - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.throwCooldown = Math.max(0, this.throwCooldown - dt);
    this.hitStun = Math.max(0, this.hitStun - dt);
    this.stunSeconds = Math.max(0, this.stunSeconds - dt);
    this.impulseSeconds = Math.max(0, this.impulseSeconds - dt);
    this.firingSearchCooldown = Math.max(0, this.firingSearchCooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.bodyMaterial.emissiveColor.set(0.08 + this.hitFlash * 2, 0.015 + this.hitFlash * 0.42, 0.012);

    this.trackIncomingBalls(dt);
    const threat = this.pickDefensiveThreat();
    if (this.hitStun <= 0 && this.impulseSeconds <= 0) {
      if (threat && this.canReadCatch(threat) && this.heldBallCount < 2 && this.catchCooldown <= 0 && this.catchActiveUntilMs < this.elapsed * 1000) {
        this.tryOpenCatch(threat);
      } else if (threat && this.dodgeCooldown <= 0 && this.catchActiveUntilMs < this.elapsed * 1000) {
        events.dashed = this.tryDodge(threat);
      }
      if (!threat) this.reactToPlayerWindup();
    }

    const escapingBlast = this.hitStun <= 0 && this.avoidPowerupDanger(dt, events);
    const takingCover = !escapingBlast && this.hitStun <= 0 && this.impulseSeconds <= 0 &&
      this.updateCoverTactics(dt, playerEye, threat, events);
    const candidate = this.heldBallCount < 2 && !escapingBlast && !takingCover ? this.findOwnSideBall() : null;
    const ball = candidate && (!this.held || this.shouldCollectSecond(candidate, threat)) ? candidate : null;
    if (escapingBlast || takingCover) {
      // Defense takes priority over collecting ammunition or winding up a throw.
    } else if (ball && this.hitStun <= 0 && this.impulseSeconds <= 0) {
      const bx = ball.mesh.position.x;
      const bz = ball.mesh.position.z;
      const distance = Math.hypot(bx - this.mesh.position.x, bz - this.mesh.position.z);
      if (distance <= PICKUP_DISTANCE && shotLaneClear(
          new Vector3(this.mesh.position.x, ball.mesh.position.y, this.mesh.position.z), ball.mesh.position, this.collision) &&
          Math.abs(ball.mesh.position.y - (this.bounds.floorY + TUNING.ball.radius)) < 1.35) {
        this.grab(ball);
      } else {
        if (this.targetBallId !== ball.id) {
          this.targetBallId = ball.id;
          this.pursuitSeconds = 0;
          this.navigation.clear();
        }
        this.pursuitSeconds += dt;
        this.moveToward(bx, bz, dt, 4.8);
        if (!threat && this.pursuitSeconds >= (powerups?.magnetActive ? 0.15 : 0.25)) {
          events.dashed = this.tryTravelDash(bx, bz, false) || events.dashed;
        }
      }
    } else if (this.held && this.hitStun <= 0 && this.impulseSeconds <= 0) {
      this.holdSeconds += dt;
      this.repositionForThrow(dt, playerEye);
      this.updateFeint(playerEye, events);
      if (this.chosenThrow === 'backflip' && this.stunSeconds <= 0 && !this.backflipStartedForThrow &&
          this.holdSeconds >= this.plannedWait + this.throwWindup() - 0.48 && !threat) {
        const away = new Vector3(this.mesh.position.x - playerEye.x, 0, this.mesh.position.z - playerEye.z).normalize();
        const impulse = this.backflip.start(away);
        if (impulse) {
          this.backflipStartedForThrow = true;
          this.backflipLandedAt = -1;
          this.velocity.x += impulse.x;
          this.velocity.z += impulse.z;
          this.verticalVelocity = impulse.y;
          events.backflipped = true;
        }
      }
      const ready = this.readyToAttack(playerEye, threat);
      // Player backflip throws are released from the landing QTE, not during the flip itself.
      const landingQteReady = this.backflipStartedForThrow && this.backflipLandedAt >= 0 &&
        this.elapsed - this.backflipLandedAt >= TUNING.backflip.qte.armDelaySeconds + 0.28;
      if (ready && (this.chosenThrow !== 'backflip' || landingQteReady)) {
        events.throwType = this.chosenThrow;
        events.threw = this.release(playerEye);
      }
    } else if (this.hitStun <= 0 && this.impulseSeconds <= 0) {
      // No ammunition on this half: stay alert and patrol laterally instead of freezing.
      this.pursuitSeconds = 0;
      if (this.targetBallId !== null) {
        this.targetBallId = null;
          this.navigation.clear();
      }
      const patrolX = Math.max(this.bounds.minX + 0.8, Math.min(this.bounds.maxX - 0.8,
        this.spawn.x + Math.sin(this.elapsed * 0.7) * Math.min(2.6, (this.bounds.maxX - this.bounds.minX) * 0.28)));
      this.moveToward(patrolX, this.spawn.z, dt, 1.8);
    } else if (this.impulseSeconds <= 0) {
      this.velocity.x *= Math.exp(-9 * dt);
      this.velocity.z *= Math.exp(-9 * dt);
    }

    this.integrateMotion(dt);
    this.facePlayer(playerEye, dt);
    this.animate(dt);
    if (this.held) this.held.mesh.position.copyFrom(this.handWorldPosition(this.held.heldHand ?? 'left'));
    if (this.reserve) this.reserve.mesh.position.copyFrom(this.handWorldPosition(this.reserve.heldHand ?? 'right'));
    for (const grenade of this.stuckGrenades) {
      if (!this.ballManager.balls.includes(grenade)) this.stuckGrenades.delete(grenade);
      else grenade.mesh.position.copyFrom(this.mesh.position);
    }
    return events;
  }

  /** Call from BallManager's advanced-segment observer, after local-player catch resolution. */
  resolveAdvancedBall(ball: Ball, segmentStart: Vector3, segmentEnd: Vector3): PracticeOpponentBallEvent | null {
    if (!this.enabled || ball.state !== BallState.Live || ball.owner !== 'player') return null;
    if (ball.powerupKind === 'cannon' && ball.cannonHitDummyIds.has(this.mesh.name)) return null;
    const speed = ball.velocity.length();
    const eye = this.eyePosition();
    if (this.heldBallCount < 2 && this.catchOpenedAtMs >= 0 && this.elapsed * 1000 <= this.catchActiveUntilMs) {
      const forward = new Vector3(this.lastPlayerEye.x - eye.x, 0, this.lastPlayerEye.z - eye.z);
      if (forward.lengthSquared() > 1e-6) forward.normalize();
      const sharedBall: Pick<SharedBallState, 'phase' | 'velocity' | 'bounceCount' | 'ownerId' | 'kind' | 'armedAtMs' | 'isSuper'> = {
        phase: 'live', velocity: vec(ball.velocity), bounceCount: ball.bounceCount,
        ownerId: 'local', kind: ball.powerupKind ?? 'normal', armedAtMs: ball.armedAtMs, isSuper: ball.isSuper
      };
      const fail = sweptCatchFailReason({
        handEmpty: true,
        handCooldownSeconds: 0,
        dashing: this.dashActiveSeconds > 0,
        defenderPlayerId: BOT_ID,
        ball: sharedBall,
        origin: vec(eye),
        forward: vec(forward),
        segmentStart: vec(segmentStart),
        segmentEnd: vec(segmentEnd),
        timing: {
          nowMs: this.elapsed * 1000,
          openedAtMs: this.catchOpenedAtMs,
          startupMs: GAME_CONSTANTS.combat.catchStartupMs,
          activeUntilMs: this.catchActiveUntilMs
        }
      });
      if (!fail) {
        this.grab(ball);
        this.catchOpenedAtMs = -1;
        this.catchActiveUntilMs = -1;
        this.catchCooldown = GAME_CONSTANTS.combat.catchCooldownMs / 1000;
        this.dash.addChargeFromHit();
        return { kind: 'catch', speed };
      }
    }

    const radius = TUNING.ball.hitRadius + (ball.powerupKind === 'cannon'
      ? TUNING.ball.radius * (GAME_CONSTANTS.powerup.cannonFlightScale - 1) : 0);
    const x = this.mesh.position.x;
    const z = this.mesh.position.z;
    if (!sweptBallHitsBody(vec(segmentStart), vec(segmentEnd),
      { x, y: this.bounds.floorY + this.airborneHeight + 0.15, z },
      { x, y: this.bounds.floorY + this.airborneHeight + 2, z }, radius)) return null;
    if (ball.powerupKind === 'shock' || ball.powerupKind === 'stun') {
      // Grenades stick to the opponent; ArenaScene starts their fuse and applies the blast.
      ball.makeDead();
      ball.velocity.setAll(0);
      ball.mesh.position.copyFrom(this.mesh.position);
      this.stuckGrenades.add(ball);
      return null;
    }
    if (ball.powerupKind === 'bomb') {
      ball.makeDead();
      return null; // Damage and feedback come from the blast, once its fuse expires.
    }
    if (ball.powerupKind === 'heal') return null;
    if (ball.powerupKind === 'cannon') ball.cannonHitDummyIds.add(this.mesh.name);
    else ball.makeDead();
    this.dropHeld();
    this.hitStun = 0.7;
    this.hitFlash = 0.42;
    this.catchOpenedAtMs = -1;
    this.catchActiveUntilMs = -1;
    this.velocity.x += ball.velocity.x * 0.06;
    this.velocity.z += ball.velocity.z * 0.06;
    return { kind: 'hit', speed };
  }

  /** Apply the same offline powerup effects used for the local player. */
  applyPowerupBlast(kind: PowerupKind, position: Vector3): PracticeOpponentBallEvent | null {
    if (!this.enabled) return null;
    const center = this.feetPosition.add(new Vector3(0, this.airborneHeight + TUNING.player.height / 2, 0));
    const distance = Vector3.Distance(center, position);
    if (kind === 'shock') {
      const feet = this.feetPosition;
      feet.y += this.airborneHeight;
      const launched = shockwavePlayerVelocity(vec(feet),
        { x: this.velocity.x, y: this.verticalVelocity, z: this.velocity.z }, vec(position),
        vec(center.subtract(this.lastPlayerEye).normalize()));
      if (launched) {
        this.velocity.set(launched.x, 0, launched.z);
        this.verticalVelocity = launched.y;
        // Keep the external launch until landing; ordinary steering must not erase it mid-flight.
        const gravity = TUNING.player.gravity;
        this.impulseSeconds = Math.max(0.35,
          (launched.y + Math.sqrt(launched.y * launched.y + 2 * gravity * this.airborneHeight)) / gravity);
        this.dashActiveSeconds = 0;
        this.backflip.active = false;
        this.backflipStartedForThrow = false;
        this.backflipLandedAt = -1;
        this.holdSeconds = 0;
      }
    } else if (kind === 'stun' && distance <= GAME_CONSTANTS.powerup.stunRadius) {
      this.stunSeconds = GAME_CONSTANTS.powerup.stunSeconds;
      this.dashActiveSeconds = 0;
      this.velocity.scaleInPlace(GAME_CONSTANTS.powerup.stunMoveMultiplier);
      this.catchOpenedAtMs = this.catchActiveUntilMs = -1;
      if (this.chosenThrow === 'backflip') this.chosenThrow = 'charged';
    } else if (kind === 'bomb' && distance <= GAME_CONSTANTS.powerup.blastRadius) {
      this.dropHeld();
      this.hitStun = 0.7;
      this.hitFlash = 0.42;
      this.catchOpenedAtMs = this.catchActiveUntilMs = -1;
      return { kind: 'hit', speed: 0 };
    }
    return null;
  }

  private findOwnSideBall(): Ball | null {
    const cached = this.cachedPickup;
    if (this.elapsed < this.pickupSearchAt && (!cached ||
        (this.ballManager.balls.includes(cached) && this.ballManager.canPickup(cached) &&
         cached.mesh.position.z >= this.bounds.ownSideMinZ && cached.mesh.position.z <= this.bounds.maxZ))) return cached;
    this.pickupSearchAt = this.elapsed + 0.25;
    let best: Ball | null = null;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    for (const ball of this.ballManager.balls) {
      if (ball.state !== BallState.Loose && ball.state !== BallState.Dead) continue;
      if (!this.ballManager.canPickup(ball)) continue;
      const p = ball.mesh.position;
      if (p.x < this.bounds.minX || p.x > this.bounds.maxX ||
          p.z < this.bounds.ownSideMinZ || p.z > this.bounds.maxZ) continue;
      if (Math.abs(p.y - (this.bounds.floorY + TUNING.ball.radius)) > 1.35) continue;
      const dx = p.x - this.mesh.position.x;
      const dz = p.z - this.mesh.position.z;
      const directDistance = Math.hypot(dx, dz);
      if (Math.max(0, directDistance - PICKUP_DISTANCE) ** 2 >= bestDistanceSq) continue;
      const route = this.navigation.routeDistance(this.feetPosition, p);
      const distanceSq = route * route;
      if (distanceSq < bestDistanceSq) {
        bestDistanceSq = distanceSq;
        best = ball;
      }
    }
    this.cachedPickup = best;
    return best;
  }

  private grab(ball: Ball): void {
    if (this.heldBallCount >= 2 || !this.ballManager.balls.includes(ball)) return;
    const second = this.held !== null;
    const hand: HandSide = this.held?.heldHand === 'left' ? 'right' : 'left';
    ball.state = BallState.Held;
    ball.owner = 'bot';
    ball.heldHand = hand;
    ball.velocity.setAll(0);
    ball.bounceCount = 0;
    ball.isSuper = false;
    ball.curveAccel.setAll(0);
    if (second) {
      this.reserve = ball;
      this.seekSecondBall = false;
      this.pairPlan = this.dash.charges <= 1 || this.playerHeldBallCount() >= 2 || Math.random() < 0.3
        ? 'reserve' : 'pressure';
      // The opening ball forces a response; save the stronger/readjusted shot for the other hand.
      if (this.pairPlan === 'pressure' && !this.backflipStartedForThrow) this.chosenThrow = 'quick';
    } else {
      this.held = ball;
      this.pairPlan = 'none';
      this.possessionSeconds = 0;
      this.seekSecondBall = Math.random() < 0.65;
      this.planThrow(false);
    }
    this.pursuitSeconds = 0;
    this.backflipStartedForThrow = false;
    this.backflipLandedAt = -1;
    this.targetBallId = null;
    this.navigation.clear();
    ball.mesh.position.copyFrom(this.handWorldPosition(hand));
  }

  private planThrow(followup: boolean): void {
    this.followupShot = followup;
    this.holdSeconds = 0;
    // Vary the attack while adapting its timing and ammunition use to the visible situation.
    const sequence: PracticeOpponentThrowType[] = ['quick', 'charged', 'curve', 'quick', 'backflip', 'charged'];
    this.chosenThrow = followup ? 'quick' : sequence[this.throwIndex % sequence.length];
    if (this.powerups?.armorCount) this.chosenThrow = 'quick';
    else if ((this.powerups?.speedActive || this.powerups?.adrenalineActive) && this.chosenThrow === 'quick') {
      this.chosenThrow = 'charged';
    }
    if (this.stunSeconds > 0 && this.chosenThrow === 'backflip') this.chosenThrow = 'charged';
    this.plannedWait = followup ? 0.25 + Math.random() * 0.35 : 0.65 + Math.random() * 0.9;
    if (followup && this.pairPlan === 'reserve') this.plannedWait += 1.2;
    if (!followup && this.playerHeldBallCount() >= 2) this.plannedWait += 0.35;
    this.throwIndex += 1;
    this.willFeint = !followup && this.chosenThrow !== 'backflip' &&
      Math.random() < (this.difficulty === 'easy' ? 0.14 : this.difficulty === 'hard' ? 0.36 : 0.26);
    this.feintUsed = false;
    this.feintUntil = -1;
    this.backflipStartedForThrow = false;
    this.backflipLandedAt = -1;
  }

  private playerHeldBallCount(): number {
    return this.ballManager.balls.filter(ball => ball.owner === 'player' && ball.state === BallState.Held).length;
  }

  private observePlayer(dt: number, observation?: PracticeOpponentPlayerObservation): void {
    this.observationQueue.push({ at: this.elapsed, value: observation
      ? { ...observation } : { catching: false, charging: false, dashing: false } });
    while (this.observationQueue.length && this.observationQueue[0].at <= this.elapsed - REACTION[this.difficulty]) {
      const next = this.observationQueue.shift()!.value;
      if (this.observedPlayer.catching && !next.catching) this.playerRecoveryUntil = this.elapsed + 0.4;
      if (next.catching || next.dashing) this.comboReacted = true;
      this.observedPlayer = next;
    }
    if (this.observedPlayer.charging) this.playerChargeSeconds += dt;
    else { this.playerChargeSeconds = 0; this.readCharge = false; }
    if (this.lastShotBall?.state === BallState.Held && this.lastShotBall.owner === 'player') this.comboReacted = true;
  }

  private reactToPlayerWindup(): void {
    if (this.readCharge || this.playerChargeSeconds < 0.5 || this.heldBallCount >= 2 ||
        this.catchCooldown > 0 || this.stunSeconds > 0 || this.dashActiveSeconds > 0 || this.backflip.active) return;
    this.readCharge = true;
    if (this.ballManager.balls.some(ball => ball.owner === 'player' && ball.state === BallState.Held &&
        !this.canReadCatch(ball))) return;
    const eye = this.eyePosition();
    if (Vector3.Distance(eye, this.lastPlayerEye) > 19 ||
        !shotLaneClear(eye, this.lastPlayerEye, this.collision) || Math.random() > 0.3) return;
    // Occasionally bite on a visible windup. The player can cancel it and punish this spent catch.
    this.catchOpenedAtMs = this.elapsed * 1000;
    this.catchActiveUntilMs = this.catchOpenedAtMs + GAME_CONSTANTS.combat.catchStartupMs + GAME_CONSTANTS.combat.catchActiveMs;
    this.catchCooldown = GAME_CONSTANTS.combat.catchCooldownMs / 1000;
  }

  private updateFeint(playerEye: Vector3, events: PracticeOpponentFrameEvents): void {
    if (!this.willFeint || this.feintUsed || !this.held || this.backflipStartedForThrow ||
        this.playerHeldBallCount() >= 2 || this.holdSeconds < this.plannedWait + this.throwWindup() * 0.7 ||
        !shotLaneClear(this.handWorldPosition(), playerEye, this.collision)) return;
    this.feintUsed = true;
    this.feintUntil = this.elapsed + 0.3;
    this.holdSeconds = 0;
    this.plannedWait = 0.35;
    events.feinted = true;
  }

  private updateCoverTactics(dt: number, playerEye: Vector3, threat: Ball | null,
    events: PracticeOpponentFrameEvents): boolean {
    if (!this.collision || this.backflip.active || this.backflipStartedForThrow) return false;
    const pressure = !!threat || this.observedPlayer.charging ||
      (this.playerHeldBallCount() > 0 && (!this.held || this.dash.charges <= 1));
    const repositioning = this.elapsed < this.relocateUntil && this.pairPlan !== 'pressure';
    if (this.elapsed >= this.coverSearchAt) {
      this.coverSearchAt = this.elapsed + 0.55;
      if (pressure || repositioning || this.coverPhase !== 'none') {
        const plan = findCoverPlan(this.feetPosition, playerEye, this.bounds, this.collision, this.coverSide,
          (from, to) => this.navigation.routeDistance(from, to));
        if (!plan) { this.coverPlan = null; this.coverPhase = 'none'; }
        else if (!this.coverPlan || this.coverPlan.coverId !== plan.coverId) {
          this.coverPlan = plan;
          this.coverPhase = 'hide';
          this.coverUntil = this.elapsed + 1.6;
        } else this.coverPlan = plan;
      }
    }
    if (!this.coverPlan) return false;
    if (this.coverPhase === 'peek' && (repositioning || (!!threat && this.elapsed > this.coverUntil))) {
      this.coverPhase = 'hide';
      this.coverUntil = this.elapsed + 1.1;
      this.holdSeconds = 0;
    }
    if (this.coverPhase !== 'hide') return false;
    const hide = this.coverPlan.hide;
    const distance = Vector3.Distance(this.feetPosition, hide);
    if (this.elapsed >= this.coverUntil) {
      if (this.held) this.coverPhase = 'peek';
      else {
        // Leave cover to retrieve ammunition after a short breather, even if the player stays armed.
        this.coverPhase = 'none';
        this.coverPlan = null;
        this.coverSearchAt = this.elapsed + 2.2;
      }
      return false;
    }
    this.moveToward(hide.x, hide.z, dt, 4.8);
    if (distance > 3) events.dashed = this.tryTravelDash(hide.x, hide.z, true) || events.dashed;
    return true;
  }

  private tryTravelDash(x: number, z: number, retreat: boolean): boolean {
    if (this.stunSeconds > 0 || this.impulseSeconds > 0 || this.hitStun > 0 || this.airborneHeight > 0.2 ||
        this.dashActiveSeconds > 0 || this.travelDashCooldown > 0 || this.dodgeCooldown > 0 || !this.dash.canDash()) return false;
    const reserve = !retreat && (this.observedPlayer.charging || this.playerHeldBallCount() >= 2) ? 2 : 1;
    if (this.dash.charges <= reserve) return false;
    const target = this.navigation.nextWaypoint(this.feetPosition, new Vector3(x, this.bounds.floorY, z));
    if (!target) return false;
    const delta = target.subtract(this.feetPosition);
    const distance = Math.hypot(delta.x, delta.z);
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    const runway = (speed + GAME_CONSTANTS.dash.impulse) * TUNING.dash.activeSeconds + 0.65;
    if (distance < runway + 0.5) return false;
    const direction = new Vector3(delta.x / distance, 0, delta.z / distance);
    if (speed > 1.5 && Vector3.Dot(this.velocity, direction) / speed < 0.65) return false;
    const landing = this.feetPosition.add(direction.scale(runway));
    if (this.isBlocked(landing.x, landing.z) || !this.navigation.pathClear(this.feetPosition, landing)) return false;
    const dashed = this.dash.tryDash(this.velocity, direction);
    if (!dashed) return false;
    this.velocity.copyFrom(dashed);
    this.dashActiveSeconds = TUNING.dash.activeSeconds;
    this.travelDashCooldown = retreat ? 0.75 : 0.65;
    return true;
  }

  private shouldCollectSecond(ball: Ball, threat: Ball | null): boolean {
    if (!this.seekSecondBall || this.reserve || this.backflipStartedForThrow || this.followupShot ||
        this.possessionSeconds > 2 || threat || this.dashActiveSeconds > 0 || this.playerHeldBallCount() >= 2) return false;
    return this.navigation.routeDistance(this.feetPosition, ball.mesh.position) <= 5.5;
  }

  private readyToAttack(playerEye: Vector3, threat: Ball | null): boolean {
    if (this.throwCooldown > 0 || threat || this.dashActiveSeconds > 0 || this.impulseSeconds > 0 ||
        this.catchActiveUntilMs >= this.elapsed * 1000 || this.elapsed < this.feintUntil ||
        this.coverPhase === 'hide') return false;
    const winding = this.throwWindup();
    // Return a shot after the player's throw, once the immediate danger has passed.
    const counter = this.elapsed < this.playerRecoveryUntil && this.holdSeconds >= this.plannedWait + winding;
    if (!counter && this.holdSeconds < this.plannedWait + winding) return false;
    if (this.observedPlayer.catching && this.possessionSeconds < 4 && !this.powerups?.armorCount) return false;
    if (this.followupShot && this.pairPlan === 'pressure' && !this.comboReacted &&
        this.lastShotBall?.state === BallState.Live && this.elapsed - this.lastShotAt < 1.3) return false;
    if (this.chosenThrow === 'backflip' && !this.backflipStartedForThrow) return false;
    // Keep a ball while recovering stamina or tracking a fast strafe, but never stall indefinitely.
    const patient = !this.followupShot && this.holdSeconds < this.plannedWait + winding + 0.85;
    if (!counter && patient && ((this.dash.charges <= 1 && this.playerHeldBallCount() > 0) ||
        Math.hypot(this.playerVelocity.x, this.playerVelocity.z) > 8)) return false;
    return shotLaneClear(this.handWorldPosition(), playerEye.subtract(new Vector3(0, 0.52, 0)), this.collision);
  }

  private dropHeld(): void {
    for (const ball of [this.held, this.reserve]) {
      if (ball && this.ballManager.balls.includes(ball)) {
        this.ballManager.dropBall(ball, this.handWorldPosition(ball.heldHand ?? 'left'), new Vector3(0, -0.5, 0));
      }
    }
    this.held = null;
    this.reserve = null;
    this.seekSecondBall = false;
    this.possessionSeconds = 0;
    this.followupShot = false;
    this.pairPlan = 'none';
    this.feintUntil = -1;
    this.holdSeconds = 0;
    this.pursuitSeconds = 0;
    this.backflipStartedForThrow = false;
    this.backflipLandedAt = -1;
  }

  private throwWindup(): number {
    const scale = this.difficulty === 'easy' ? 1.25 : this.difficulty === 'hard' ? 0.78 : 1;
    const base = this.chosenThrow === 'quick' ? 0.48 : this.chosenThrow === 'backflip' ? 0.98 : 1.12;
    return base * scale;
  }

  private release(playerEye: Vector3): boolean {
    const ball = this.held;
    if (!ball) return false;
    const origin = this.handWorldPosition();
    const aim = playerEye.clone();
    aim.y -= 0.52;
    const charge01 = this.chosenThrow === 'quick' ? 0 : this.chosenThrow === 'curve' ? 0.72 : 1;
    const speed = TUNING.ball.quickThrowSpeed + (TUNING.ball.chargedThrowSpeed - TUNING.ball.quickThrowSpeed) * charge01;
    const flightSeconds = Vector3.Distance(origin, aim) / (speed * (ball.powerupKind === 'bomb' ? GAME_CONSTANTS.powerup.bombThrowSpeedMultiplier : 1));
    const lead = this.powerups?.speedActive || this.powerups?.adrenalineActive ||
      (this.followupShot && this.comboReacted) ? 0.7 : 0.35;
    aim.x += this.playerVelocity.x * Math.min(0.45, flightSeconds) * lead;
    aim.z += this.playerVelocity.z * Math.min(0.45, flightSeconds) * lead;
    const drop = this.chosenThrow === 'backflip' ? TUNING.ball.chargedDropScale
      : TUNING.ball.quickDropScale + (TUNING.ball.chargedDropScale - TUNING.ball.quickDropScale) * charge01;
    aim.y += 0.5 * TUNING.ball.gravity * drop * ball.mapGravityScale * flightSeconds * flightSeconds;
    const forward = aim.subtract(origin);
    if (forward.lengthSquared() <= 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const backflipTier = this.chosenThrow === 'backflip'
      ? (this.difficulty === 'easy' ? 1 : this.difficulty === 'hard' ? 4 : 3) : 0;
    if (this.chosenThrow === 'quick') forward.y += 0.035;
    const spread = this.difficulty === 'easy' ? 0.09 : this.difficulty === 'hard' ? 0.023 : 0.052;
    forward.x += (Math.random() - 0.5) * spread;
    forward.y += (Math.random() - 0.5) * spread * 0.65;
    forward.normalize();
    const result = calculateThrow({
      hand: ball.heldHand ?? 'left', forward: vec(forward), playerVelocity: vec(this.velocity), charge01,
      crouching: this.chosenThrow === 'curve', backflipTier,
      fastDoubleThrowPenalty: this.elapsed - this.lastShotAt < 0.2
    });
    // A curve should start outside the target, then bend back toward the middle.
    if (this.chosenThrow === 'curve') {
      result.velocity.x -= result.curveAccel.x * 0.12;
      result.velocity.z -= result.curveAccel.z * 0.12;
    }
    const velocity = new Vector3(result.velocity.x, result.velocity.y, result.velocity.z);
    if (ball.powerupKind === 'bomb') velocity.scaleInPlace(GAME_CONSTANTS.powerup.bombThrowSpeedMultiplier);
    const curve = new Vector3(result.curveAccel.x, result.curveAccel.y, result.curveAccel.z);
    if (!shotTrajectoryClear({ origin, target: aim, velocity, dropScale: result.dropScale,
      curveAccel: curve, collision: this.collision, floorY: this.bounds.floorY, gravityScale: ball.mapGravityScale })) {
      // Keep the ball while looking for a clean angle. A straight charge can clear a lane a curve clips.
      if (this.chosenThrow === 'curve') this.chosenThrow = 'charged';
      this.firingSearchCooldown = 0;
      return false;
    }
    this.held = this.reserve;
    this.reserve = null;
    this.releaseHand = ball.heldHand ?? 'left';
    this.releasePoseUntil = this.elapsed + 0.22;
    ball.mesh.position.copyFrom(origin);
    ball.throw('bot', velocity, result.isSuper, result.dropScale, curve);
    PracticeOpponent.throwOwners.set(ball, this);
    this.lastShotAt = this.elapsed;
    this.lastShotBall = ball;
    this.comboReacted = false;
    this.coverSide = this.coverSide === 1 ? -1 : 1;
    this.relocateUntil = this.elapsed + 1.1;
    if (this.coverPlan?.oppositePeek) {
      const next = this.coverPlan.oppositePeek;
      this.coverPlan.oppositePeek = this.coverPlan.peek;
      this.coverPlan.peek = next;
    }
    this.coverSearchAt = 0;
    this.throwCooldown = this.difficulty === 'easy' ? 0.7 : this.difficulty === 'hard' ? 0.25 : 0.42;
    this.holdSeconds = 0;
    this.backflipStartedForThrow = false;
    this.backflipLandedAt = -1;
    if (this.held) this.planThrow(true);
    else this.pairPlan = 'none';
    return true;
  }

  private trackIncomingBalls(dt: number): void {
    const seen = new Set<number>();
    const eye = this.eyePosition();
    for (const ball of this.ballManager.balls) {
      if (ball.state !== BallState.Live || ball.owner !== 'player') continue;
      const distance = Vector3.Distance(ball.mesh.position, eye);
      if (distance > 22 || distance < 0.1) continue;
      const toBot = eye.subtract(ball.mesh.position);
      if (Vector3.Dot(ball.velocity, toBot) <= 0) continue;
      seen.add(ball.id);
      if (!this.seenThreatSeconds.has(ball.id)) this.playerRecoveryUntil = this.elapsed + 0.85;
      this.seenThreatSeconds.set(ball.id, (this.seenThreatSeconds.get(ball.id) ?? 0) + dt);
    }
    for (const id of this.seenThreatSeconds.keys()) {
      if (!seen.has(id)) this.seenThreatSeconds.delete(id);
    }
  }

  private pickDefensiveThreat(): Ball | null {
    const eye = this.eyePosition();
    let best: Ball | null = null;
    let bestTime = Number.POSITIVE_INFINITY;
    for (const ball of this.ballManager.balls) {
      if (ball.state !== BallState.Live || ball.owner !== 'player') continue;
      if ((this.seenThreatSeconds.get(ball.id) ?? 0) < REACTION[this.difficulty]) continue;
      const rel = eye.subtract(ball.mesh.position);
      const relativeVelocity = ball.velocity.subtract(this.velocity);
      const speedSq = relativeVelocity.lengthSquared();
      if (speedSq <= 1) continue;
      const time = Vector3.Dot(rel, relativeVelocity) / speedSq;
      if (time < 0 || time > 0.3 || time >= bestTime) continue;
      const near = ball.mesh.position.add(relativeVelocity.scale(time));
      const threatRadius = ball.powerupKind === 'cannon'
        ? 1.0 + TUNING.ball.radius * (GAME_CONSTANTS.powerup.cannonFlightScale - 1) : 1.0;
      if (Math.hypot(near.x - eye.x, near.z - eye.z) > threatRadius || Math.abs(near.y - eye.y) > threatRadius + 0.05) continue;
      best = ball;
      bestTime = time;
    }
    return best;
  }

  private tryOpenCatch(ball: Ball): void {
    // Deliberately miss some reads; an opponent with perfect reactions is poor practice.
    if (ball.isSuper || ball.curveAccel.lengthSquared() > 2 || Math.random() > CATCH_CHANCE[this.difficulty]) {
      this.catchCooldown = 0.3;
      return;
    }
    const eye = this.eyePosition();
    const towardBall = ball.mesh.position.subtract(eye).normalize();
    const forward = this.lastPlayerEye.subtract(eye).normalize();
    if (Vector3.Dot(towardBall, forward) < Math.cos(TUNING.catch.coneDegrees * Math.PI / 180)) return;
    this.catchOpenedAtMs = this.elapsed * 1000;
    this.catchActiveUntilMs = this.catchOpenedAtMs + GAME_CONSTANTS.combat.catchStartupMs + GAME_CONSTANTS.combat.catchActiveMs;
    this.catchCooldown = GAME_CONSTANTS.combat.catchCooldownMs / 1000;
  }

  private canReadCatch(ball: Ball): boolean {
    return this.stunSeconds <= 0 && ball.powerupKind !== 'cannon' && ball.powerupKind !== 'shock' &&
      ball.powerupKind !== 'stun' && ball.powerupKind !== 'heal' && ball.armedAtMs === undefined;
  }

  private avoidPowerupDanger(dt: number, events: PracticeOpponentFrameEvents): boolean {
    const hazards: { position: Vector3; radius: number }[] = [];
    for (const ball of this.ballManager.balls) {
      const kind = ball.powerupKind;
      if (kind !== 'bomb' && kind !== 'shock' && kind !== 'stun') continue;
      if (ball.state === BallState.Held || (ball.fuseSeconds === undefined && ball.state !== BallState.Live)) continue;
      if (this.stuckGrenades.has(ball)) continue; // A stuck grenade rides us; running cannot escape it.
      const radius = kind === 'bomb' ? GAME_CONSTANTS.powerup.blastRadius
        : kind === 'shock' ? GAME_CONSTANTS.powerup.shockRadius : GAME_CONSTANTS.powerup.stunRadius;
      const position = ball.mesh.position.clone();
      if (ball.state === BallState.Live) position.addInPlace(ball.velocity.scale(0.18));
      if (Vector3.Distance(position, this.mesh.position) < radius + 1.3) hazards.push({ position, radius });
    }
    if (!hazards.length) return false;
    const safety = (x: number, z: number) => Math.min(...hazards.map(h => Math.hypot(x - h.position.x, z - h.position.z) - h.radius));
    let best = this.feetPosition;
    let bestScore = safety(best.x, best.z);
    for (let i = 0; i < 16; i++) {
      const angle = i * Math.PI / 8;
      const x = Math.max(this.bounds.minX + BODY_RADIUS + 0.05, Math.min(this.bounds.maxX - BODY_RADIUS - 0.05,
        this.mesh.position.x + Math.cos(angle) * 3.5));
      const z = Math.max(this.bounds.minZ + BODY_RADIUS + 0.05, Math.min(this.bounds.maxZ - BODY_RADIUS - 0.05,
        this.mesh.position.z + Math.sin(angle) * 3.5));
      if (this.isBlocked(x, z) || this.pathBlocked(this.mesh.position.x, this.mesh.position.z, x, z)) continue;
      const score = safety(x, z);
      if (score > bestScore) { best = new Vector3(x, this.bounds.floorY, z); bestScore = score; }
    }
    this.moveToward(best.x, best.z, dt, 5.2);
    const direction = best.subtract(this.feetPosition);
    if (this.stunSeconds <= 0 && this.impulseSeconds <= 0 && this.dashActiveSeconds <= 0 &&
        this.dodgeCooldown <= 0 && direction.length() > 2.2) {
      const dashed = this.dash.tryDash(this.velocity, direction.normalize());
      if (dashed) {
        this.velocity.copyFrom(dashed);
        this.dashActiveSeconds = TUNING.dash.activeSeconds;
        this.dodgeCooldown = 0.65;
        events.dashed = true;
      }
    }
    return true;
  }

  private tryDodge(ball: Ball): boolean {
    if (!this.dash.canDash() || this.hitStun > 0 || this.stunSeconds > 0 || this.impulseSeconds > 0) return false;
    const side = ball.velocity.z <= 0 ? 1 : -1;
    const toBall = ball.mesh.position.subtract(this.mesh.position);
    const direction = new Vector3(toBall.z * side, 0, -toBall.x * side);
    if (direction.lengthSquared() <= 1e-6) direction.set(1, 0, 0);
    direction.normalize();
    // Only dodge if there is room on the chosen side, otherwise use the other side.
    const clear = () => !this.isBlocked(this.mesh.position.x + direction.x * 2.1, this.mesh.position.z + direction.z * 2.1) &&
      !this.pathBlocked(this.mesh.position.x, this.mesh.position.z,
        this.mesh.position.x + direction.x * 2.1, this.mesh.position.z + direction.z * 2.1);
    if (!clear()) direction.scaleInPlace(-1);
    if (!clear()) return false;
    const dashed = this.dash.tryDash(this.velocity, direction);
    if (!dashed) return false;
    this.velocity.copyFrom(dashed);
    this.dashActiveSeconds = TUNING.dash.activeSeconds;
    this.dodgeCooldown = 1.6;
    return true;
  }

  private repositionForThrow(dt: number, playerEye: Vector3): void {
    if (this.coverPlan && this.coverPhase === 'peek') {
      this.moveToward(this.coverPlan.peek.x, this.coverPlan.peek.z, dt, 3.5);
      return;
    }
    const aim = playerEye.subtract(new Vector3(0, 0.52, 0));
    const origin = this.handWorldPosition();
    if (!shotLaneClear(origin, aim, this.collision, TUNING.ball.radius + 0.12)) {
      if (this.firingSearchCooldown <= 0) {
        this.firingPosition = findClearFiringPosition(this.feetPosition, origin, aim, this.bounds, this.collision);
        this.firingSearchCooldown = 0.3;
      }
      if (this.firingPosition) {
        this.moveToward(this.firingPosition.x, this.firingPosition.z, dt, 3.8);
        return;
      }
    } else {
      this.firingPosition = null;
    }
    // A slow lateral strafe gives the player a moving target without crossing the center line.
    const shift = Math.sin(this.elapsed * 0.8) * 2.5 * this.coverSide;
    const targetX = Math.max(this.bounds.minX + 0.8, Math.min(this.bounds.maxX - 0.8, this.spawn.x + shift));
    const playerDistance = Math.hypot(playerEye.x - this.mesh.position.x, playerEye.z - this.mesh.position.z);
    const cannonHeld = this.ballManager.balls.some(ball => ball.owner === 'player' &&
      ball.state === BallState.Held && ball.powerupKind === 'cannon');
    const targetZ = Math.max(this.bounds.minZ + 0.8, Math.min(this.bounds.maxZ - 0.8,
      this.spawn.z + (playerDistance < (cannonHeld ? 17 : 8) ? 2.3 : -0.5)));
    this.moveToward(targetX, targetZ, dt, cannonHeld ? 4.5 : 2.4);
  }

  private moveToward(x: number, z: number, dt: number, speed: number): void {
    // Preserve the shared dash impulse for the same short window as player movement.
    if (this.dashActiveSeconds > 0 || this.impulseSeconds > 0) return;
    if (this.stunSeconds > 0) speed *= GAME_CONSTANTS.powerup.stunMoveMultiplier;
    const target = this.navigationTarget(x, z);
    const dx = target.x - this.mesh.position.x;
    const dz = target.z - this.mesh.position.z;
    const distance = Math.hypot(dx, dz);
    const desiredSpeed = Math.min(speed, Math.sqrt(Math.max(0, distance)) * 3.4);
    const desiredX = distance > 0.03 ? dx / distance * desiredSpeed : 0;
    const desiredZ = distance > 0.03 ? dz / distance * desiredSpeed : 0;
    const blend = Math.min(1, dt * (this.backflip.active ? 2.5 : 6));
    this.velocity.x += (desiredX - this.velocity.x) * blend;
    this.velocity.z += (desiredZ - this.velocity.z) * blend;
  }

  private navigationTarget(x: number, z: number): Vector3 {
    const target = new Vector3(x, this.bounds.floorY, z);
    // After a forced landing on a mat, step off its top before resuming ground navigation.
    if (this.airborneHeight > TUNING.player.stepHeight && this.impulseSeconds <= 0) return target;
    return this.navigation.nextWaypoint(this.feetPosition, target) ?? this.feetPosition;
  }

  private pathBlocked(x0: number, z0: number, x1: number, z1: number, airborne = false): boolean {
    if (!this.collision) return false;
    for (const box of this.collision.boxes) {
      if (this.isStandingObstacle(box, airborne) && segmentCrossesBox(x0, z0, x1, z1, box, BODY_RADIUS + 0.02)) return true;
    }
    return false;
  }

  private integrateMotion(dt: number): void {
    const x = this.mesh.position.x;
    const z = this.mesh.position.z;
    const nextX = x + this.velocity.x * dt;
    const nextZ = z + this.velocity.z * dt;
    if (!this.isBlocked(nextX, nextZ, true) && !this.pathBlocked(x, z, nextX, nextZ, true)) {
      this.mesh.position.x = nextX;
      this.mesh.position.z = nextZ;
    } else if (!this.isBlocked(nextX, z, true) && !this.pathBlocked(x, z, nextX, z, true)) {
      this.mesh.position.x = nextX;
      this.velocity.z = 0;
    } else if (!this.isBlocked(x, nextZ, true) && !this.pathBlocked(x, z, x, nextZ, true)) {
      this.mesh.position.z = nextZ;
      this.velocity.x = 0;
    } else {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
    if (this.verticalVelocity !== 0 || this.airborneHeight > 0) {
      const previousHeight = this.airborneHeight;
      this.airborneHeight += this.verticalVelocity * dt;
      this.verticalVelocity -= TUNING.player.gravity * dt;
      let landingHeight = 0;
      // A blast can carry the bot above a mat. Land on its top instead of sinking into its collider.
      if (this.verticalVelocity <= 0 && this.collision) {
        for (const box of this.collision.boxes) {
          const top = box.maxY - this.bounds.floorY;
          if (box.enabled === false || box.ramp || top <= landingHeight ||
              previousHeight < top - 1e-6 || this.airborneHeight > top) continue;
          if (this.mesh.position.x >= box.minX - BODY_RADIUS && this.mesh.position.x <= box.maxX + BODY_RADIUS &&
              this.mesh.position.z >= box.minZ - BODY_RADIUS && this.mesh.position.z <= box.maxZ + BODY_RADIUS) {
            landingHeight = top;
          }
        }
      }
      if (this.airborneHeight <= landingHeight && this.verticalVelocity <= 0) {
        this.airborneHeight = landingHeight;
        this.verticalVelocity = 0;
        this.impulseSeconds = 0;
        if (this.backflipStartedForThrow && this.backflipLandedAt < 0) this.backflipLandedAt = this.elapsed;
      }
    }
    this.mesh.position.y = this.bounds.floorY + BODY_CENTER_HEIGHT + this.airborneHeight;
  }

  private isBlocked(x: number, z: number, airborne = false): boolean {
    if (x < this.bounds.minX + BODY_RADIUS || x > this.bounds.maxX - BODY_RADIUS ||
        z < this.bounds.minZ + BODY_RADIUS || z > this.bounds.maxZ - BODY_RADIUS) return true;
    if (!this.collision) return false;
    for (const box of this.collision.boxes) {
      if (!this.isStandingObstacle(box, airborne)) continue;
      if (x > box.minX - BODY_RADIUS && x < box.maxX + BODY_RADIUS &&
          z > box.minZ - BODY_RADIUS && z < box.maxZ + BODY_RADIUS) return true;
    }
    return false;
  }

  private isStandingObstacle(box: AABB, airborne = false): boolean {
    const feetY = this.bounds.floorY + (airborne ? this.airborneHeight : 0);
    return box.enabled !== false && !box.ramp && box.maxY > feetY + TUNING.player.stepHeight &&
      box.minY < feetY + TUNING.player.height;
  }

  private eyePosition(): Vector3 {
    return new Vector3(this.mesh.position.x, this.bounds.floorY + this.airborneHeight + EYE_HEIGHT, this.mesh.position.z);
  }

  private facePlayer(playerEye: Vector3, dt: number): void {
    const dx = playerEye.x - this.mesh.position.x;
    const dz = playerEye.z - this.mesh.position.z;
    if (dx * dx + dz * dz < 0.05) return;
    const target = Math.atan2(-dx, -dz);
    const delta = Math.atan2(Math.sin(target - this.mesh.rotation.y), Math.cos(target - this.mesh.rotation.y));
    this.mesh.rotation.y += delta * Math.min(1, dt * 8);
  }

  private animate(dt: number): void {
    if (this.backflip.active) {
      const progress = this.backflip.timer / TUNING.backflip.durationSeconds;
      this.mesh.rotation.x = progress * Math.PI * 2;
    } else {
      this.mesh.rotation.x = 0;
    }
    const moving = Math.min(1, Math.hypot(this.velocity.x, this.velocity.z) / 5);
    const windup = this.held ? Math.min(1, Math.max(0, this.holdSeconds - this.plannedWait) / Math.max(0.2, this.throwWindup())) : 0;
    this.trimMaterial.emissiveColor.set(0.12 * windup, 0.045 * windup, 0.008 * windup);
    for (const [side, arm] of [['left', this.arm], ['right', this.rightArm]] as const) {
      const active = this.held?.heldHand === side;
      const loaded = active || this.reserve?.heldHand === side;
      let pose = loaded ? 0.45 + (active ? windup * 2 : 0) : 0.12 + Math.sin(this.elapsed * 9) * 0.18 * moving;
      if (active && this.elapsed < this.feintUntil) pose = 0.35;
      if (!loaded && this.catchActiveUntilMs >= this.elapsed * 1000) pose = 1.45;
      if (side === this.releaseHand && this.elapsed < this.releasePoseUntil) pose = 1.15;
      arm.rotation.x += (pose - arm.rotation.x) * Math.min(1, dt * 18);
      arm.rotation.z = loaded ? (side === 'left' ? -1 : 1) * 0.16 * windup : 0;
    }
  }

  private handWorldPosition(side: HandSide = this.held?.heldHand ?? 'left'): Vector3 {
    const arm = side === 'left' ? this.arm : this.rightArm;
    const hand = side === 'left' ? this.hand : this.rightHand;
    this.mesh.computeWorldMatrix(true);
    arm.computeWorldMatrix(true);
    hand.computeWorldMatrix(true);
    return hand.getAbsolutePosition();
  }

  private buildBody(): void {
    const head = MeshBuilder.CreateSphere(`practice_opponent_head_${this.id}`, { diameter: 0.43, segments: 14 }, this.scene);
    head.parent = this.mesh;
    head.position.set(0, 1.04, 0);
    head.material = this.bodyMaterial;
    head.isPickable = false;
    const torso = MeshBuilder.CreateBox(`practice_opponent_torso_${this.id}`, { width: 0.55, height: 0.55, depth: 0.18 }, this.scene);
    torso.parent = this.mesh;
    torso.position.set(0, 0.19, -0.27);
    torso.material = this.trimMaterial;
    torso.isPickable = false;
    const visor = MeshBuilder.CreateBox(`practice_opponent_visor_${this.id}`, { width: 0.35, height: 0.08, depth: 0.04 }, this.scene);
    visor.parent = this.mesh;
    visor.position.set(0, 1.06, -0.24);
    visor.material = this.trimMaterial;
    visor.isPickable = false;
    for (const side of [-1, 1]) {
      const leg = MeshBuilder.CreateCapsule(`practice_opponent_leg_${this.id}_${side}`, { height: 0.65, radius: 0.085 }, this.scene);
      leg.parent = this.mesh;
      leg.position.set(side * 0.16, -0.76, 0);
      leg.material = this.bodyMaterial;
      leg.isPickable = false;
      const foot = MeshBuilder.CreateBox(`practice_opponent_foot_${this.id}_${side}`, { width: 0.23, height: 0.09, depth: 0.34 }, this.scene);
      foot.parent = this.mesh;
      foot.position.set(side * 0.16, -1.13, -0.07);
      foot.material = this.trimMaterial;
      foot.isPickable = false;
    }
  }
}

function vec(value: Vector3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

/** Slab intersection of a ground-plane segment against an expanded obstacle. */
function segmentCrossesBox(x0: number, z0: number, x1: number, z1: number, box: AABB, padding: number): boolean {
  let near = 0;
  let far = 1;
  for (const [start, end, min, max] of [
    [x0, x1, box.minX - padding, box.maxX + padding],
    [z0, z1, box.minZ - padding, box.maxZ + padding]
  ]) {
    const delta = end - start;
    if (Math.abs(delta) < 1e-9) {
      if (start < min || start > max) return false;
      continue;
    }
    const a = (min - start) / delta;
    const b = (max - start) / delta;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
    if (near > far) return false;
  }
  return far >= 0 && near <= 1;
}
