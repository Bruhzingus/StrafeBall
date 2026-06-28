import {
  Color3,
  DynamicTexture,
  Material,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3
} from '@babylonjs/core';
import { GymArena } from '../map/GymArena';
import { BallManager } from '../ball/BallManager';
import { Ball } from '../ball/Ball';
import { BallState } from '../ball/BallState';
import { PlayerController } from '../player/PlayerController';
import { InputManager } from '../input/InputManager';
import { CONTROL_KEYS } from '../config/controls';
import { TUNING } from '../config/tuning';
import { aabbFromCenter, AABB } from '../map/Collider';
import { MovementCourseHud, formatTime } from './MovementCourseHud';
import { MovementCourseStorage } from './MovementCourseStorage';
import {
  COMBAT,
  COURSE_LOBBY_RETURN,
  COURSE_REGION,
  COURSE_RESTART_KEY,
  COURSE_SPAWN,
  GATES,
  GATE_DEBOUNCE_SECONDS,
  LEAVE_PORTAL,
  START_PAD,
  START_PAD_DEBOUNCE_SECONDS,
  pointInBounds,
  type GateConfig
} from './MovementCourseConfig';

export type CourseAction = 'leave';

type CourseState = 'exploring' | 'running' | 'finished';
type ObjectivePhase = 'idle' | 'serving' | 'live' | 'caught' | 'done';

const COURSE_BOX_ID_PREFIX = 'course_';

/**
 * The local Movement Course. Fully offline/practice-only: it owns its own cheap modular geometry,
 * trigger volumes, run state machine, the catch-and-return combat objective (a course-owned thrower,
 * ball, and target), the local timer/splits/leaderboard HUD, and safe placement. It never reads or
 * writes online/server/snapshot/prediction state, and it only updates while the course is active
 * (ArenaScene calls update() from the offline step path, never from stepOnline).
 *
 * Spatially the course is a folded route through the gym shell — the offline MovementController
 * hard-clamps the player to the gym bounds and only wall-runs on the four perimeter walls, so the
 * course lives inside that footprint and the clamp is the outer safety boundary.
 */
export class MovementCourse {
  public active = false;

  private readonly hud: MovementCourseHud;
  private readonly storage = new MovementCourseStorage();
  private readonly root: TransformNode;
  private readonly materials: StandardMaterial[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  // AABBs this course adds to the gym collision worlds while active (tagged course_* so they can be
  // removed cleanly). `ball` = also add to the ball-collision world.
  private readonly collisionBoxes: Array<{ box: AABB; ball: boolean }> = [];
  private built = false;
  private nextBoxId = 0;

  // --- Shared materials (created once, reused) ---
  private deckMat!: StandardMaterial;
  private padMat!: StandardMaterial;
  private laneMat!: StandardMaterial;
  private startMat!: StandardMaterial;
  private cpMat!: StandardMaterial;
  private finishMat!: StandardMaterial;
  private throwerMat!: StandardMaterial;
  private targetMat!: StandardMaterial;
  private arrowTexture!: DynamicTexture;

  // --- Run state ---
  private state: CourseState = 'exploring';
  private runStartMs = 0;
  private finalMs = 0;
  private nextGateIndex = 0;
  private readonly splitMs: Array<number | null> = [null, null, null];
  private gateCooldown = 0;
  private startPadCooldown = 0;
  private backflipUsedThisRun = false;
  private prevBackflipActive = false;
  private leaveHold = 0;
  private leaveLatched = false;

  // --- Combat objective ---
  private courseBall: Ball | null = null;
  private targetMesh: Mesh | null = null;
  private objPhase: ObjectivePhase = 'idle';
  private objectiveComplete = false;
  private serveTimer = 0;
  private reserveTimer = 0;
  private prevBallState: BallState = BallState.Held;
  private targetFlash = 0;

  constructor(
    private readonly scene: Scene,
    private readonly gym: GymArena,
    private readonly ballManager: BallManager,
    hudParent: HTMLElement
  ) {
    this.root = new TransformNode('movement_course_root', scene);
    this.root.setEnabled(false);
    this.hud = new MovementCourseHud(hudParent);
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /** Enter the course in free-exploration mode (no timer). Builds geometry lazily on first entry. */
  enter(player: PlayerController): void {
    if (this.active) return;
    if (!this.built) this.build();
    this.active = true;

    this.root.setEnabled(true);
    this.addCollisionToGym();
    this.gym.setHalfCourtConesVisible(false);
    this.hideGymMats();
    this.ensureCourseBall();

    this.resetRunState('exploring');
    player.teleportTo(COURSE_SPAWN.position, COURSE_SPAWN.yaw, 0);

    this.hud.setState('exploring');
    this.hud.renderLeaderboard(this.storage.load());
    this.hud.setClock(0);
    this.hud.clearSplits();
    this.hud.showBanner('FREE PRACTICE', 'neutral', 2.0);
  }

  /** Leave the course: tear down active state but keep built geometry for cheap re-entry. */
  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.root.setEnabled(false);
    this.removeCollisionFromGym();
    this.gym.setHalfCourtConesVisible(true);
    this.restoreGymMats();
    this.removeCourseBall();
    this.hud.setState('hidden');
    this.resetRunState('exploring');
  }

  /** Final teardown (scene dispose). */
  dispose(): void {
    this.removeCourseBall();
    this.hud.dispose();
    for (const d of this.disposables) d.dispose();
    for (const m of this.materials) m.dispose();
    this.root.dispose();
  }

  /** Where the player should be placed in the lobby after leaving (consumed by ArenaScene). */
  get lobbyReturn(): { position: Vector3; yaw: number } {
    return COURSE_LOBBY_RETURN;
  }

  // ---------------------------------------------------------------------------------------------
  // Per-frame update (offline step only)
  // ---------------------------------------------------------------------------------------------

  update(dt: number, player: PlayerController, input: InputManager, onAction: (action: CourseAction) => void): void {
    if (!this.active) return;

    const pos = player.root.position;
    const vel = player.movement.velocity;
    const px = pos.x, py = pos.y, pz = pos.z;

    this.hud.update(dt);
    if (this.startPadCooldown > 0) this.startPadCooldown = Math.max(0, this.startPadCooldown - dt);
    if (this.gateCooldown > 0) this.gateCooldown = Math.max(0, this.gateCooldown - dt);

    // Manual restart (unbound T key): clear the run and return to the start pad in exploring mode.
    if (input.wasKeyPressed(COURSE_RESTART_KEY)) {
      this.restart(player);
      return;
    }

    this.updateLeavePortal(dt, px, pz, input, onAction);
    this.updateBackflipTracking(player);
    this.updateObjective(dt, player);
    this.updateTargetFlash(dt);

    if (this.state === 'exploring') {
      this.hud.setClock(0);
      this.tryStartRun(player);
    } else if (this.state === 'running') {
      const clock = this.currentClockMs();
      this.hud.setClock(clock);
      this.checkGates(px, py, pz, vel.x, vel.z, clock);
    }

    this.hud.setHint(this.computeHint());
  }

  // ---------------------------------------------------------------------------------------------
  // Run state machine
  // ---------------------------------------------------------------------------------------------

  private tryStartRun(player: PlayerController): void {
    if (this.startPadCooldown > 0) return;
    const pos = player.root.position;
    if (!player.movement.grounded) return;
    if (!pointInBounds(START_PAD.bounds, pos.x, pos.y, pos.z)) return;

    // Don't start while holding unrelated balls — prompt to drop rather than silently deleting them.
    if (player.hands.heldBallCount() > 0) {
      this.startPadCooldown = START_PAD_DEBOUNCE_SECONDS;
      this.hud.showBanner('DROP BALLS TO START', 'warn', 1.6);
      return;
    }

    this.startRun();
  }

  private startRun(): void {
    this.resetRunState('running');
    this.runStartMs = performance.now();
    this.hud.setState('running');
    this.hud.clearSplits();
    this.hud.setClock(0);
    this.hud.showBanner('GO!', 'good', 1.2);
  }

  private checkGates(px: number, py: number, pz: number, vx: number, vz: number, clock: number): void {
    if (this.gateCooldown > 0) return;
    const gate = GATES[this.nextGateIndex];
    if (!gate) return;
    if (!pointInBounds(gate.bounds, px, py, pz)) return;

    if (gate.id === 'finish') {
      // The finish gate is the high backflip volume — it's reached vertically (no forward direction),
      // and only counts after all three checkpoints, the objective, AND an actual backflip this run.
      if (this.nextGateIndex === GATES.length - 1 && this.objectiveComplete && this.backflipUsedThisRun) {
        this.finishRun();
      }
      return;
    }

    // One-way: only count when travelling in the gate's forward direction (backward never registers).
    const movingForward = vx * gate.forward.x + vz * gate.forward.z > 0.3;
    if (!movingForward) return;

    // Sequence-aware: the required objective must be done before its gate (cp2) is accepted.
    if (gate.requiresObjective && !this.objectiveComplete) return;

    // Checkpoint: record the raw split (cumulative time from start) and advance.
    this.splitMs[this.nextGateIndex] = clock;
    this.hud.setSplit(this.nextGateIndex, clock);
    this.gateCooldown = GATE_DEBOUNCE_SECONDS;
    this.nextGateIndex += 1;
    this.hud.showBanner(`${gate.label.toUpperCase()}  ${formatTime(clock)}`, 'good', 1.6);
  }

  private finishRun(): void {
    this.finalMs = this.currentClockMs();
    this.state = 'finished';
    this.hud.setState('finished');
    this.hud.setClock(this.finalMs);
    for (let i = 0; i < this.splitMs.length; i += 1) this.hud.setSplit(i, this.splitMs[i]);

    const placement = this.storage.submit(this.finalMs);
    const records = this.storage.load();
    this.hud.renderLeaderboard(records, placement !== null ? placement - 1 : -1);

    if (placement !== null) {
      this.hud.showBanner(`FINISH ${formatTime(this.finalMs)} — TOP ${placement}!`, 'good', 4.0);
    } else {
      this.hud.showBanner(`FINISH ${formatTime(this.finalMs)}`, 'neutral', 4.0);
    }
  }

  private restart(player: PlayerController): void {
    this.resetRunState('exploring');
    player.teleportTo(COURSE_SPAWN.position, COURSE_SPAWN.yaw, 0);
    this.hud.setState('exploring');
    this.hud.renderLeaderboard(this.storage.load());
    this.hud.setClock(0);
    this.hud.clearSplits();
    this.hud.showBanner('RESTART', 'neutral', 1.2);
  }

  private resetRunState(state: CourseState): void {
    this.state = state;
    this.runStartMs = 0;
    this.finalMs = 0;
    this.nextGateIndex = 0;
    this.splitMs[0] = this.splitMs[1] = this.splitMs[2] = null;
    this.gateCooldown = 0;
    this.startPadCooldown = 0;
    this.backflipUsedThisRun = false;
    this.prevBackflipActive = false;
    // Re-arm the combat objective for a fresh run.
    this.objectiveComplete = false;
    this.objPhase = 'idle';
    this.serveTimer = 0;
    this.reserveTimer = 0;
    this.parkCourseBall();
  }

  /** Monotonic wall-clock run time so stutters / tab-focus changes don't distort the timer. */
  private currentClockMs(): number {
    if (this.state === 'finished') return this.finalMs;
    if (this.runStartMs === 0) return 0;
    return Math.max(0, performance.now() - this.runStartMs);
  }

  private updateBackflipTracking(player: PlayerController): void {
    const active = player.backflip.active;
    if (active && !this.prevBackflipActive && this.state === 'running') {
      this.backflipUsedThisRun = true;
    }
    this.prevBackflipActive = active;
  }

  // ---------------------------------------------------------------------------------------------
  // Leave portal (hold E)
  // ---------------------------------------------------------------------------------------------

  private updateLeavePortal(dt: number, px: number, pz: number, input: InputManager, onAction: (a: CourseAction) => void): void {
    const dx = px - LEAVE_PORTAL.position.x;
    const dz = pz - LEAVE_PORTAL.position.z;
    const near = dx * dx + dz * dz <= LEAVE_PORTAL.radius * LEAVE_PORTAL.radius;
    const held = input.isKeyDown(CONTROL_KEYS.interact);

    if (!near) {
      this.leaveHold = 0;
      this.leaveLatched = false;
      return;
    }
    if (!held) {
      this.leaveHold = 0;
      this.leaveLatched = false;
      return;
    }
    if (this.leaveLatched) return;

    this.leaveHold = Math.min(LEAVE_PORTAL.holdSeconds, this.leaveHold + dt);
    if (this.leaveHold >= LEAVE_PORTAL.holdSeconds) {
      this.leaveLatched = true;
      onAction('leave');
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Catch-and-return combat objective (course-owned bot + ball + target)
  // ---------------------------------------------------------------------------------------------

  private updateObjective(dt: number, player: PlayerController): void {
    const ball = this.courseBall;
    if (!ball) return;
    const tracking = this.state === 'running';

    // Already satisfied for this run — park the ball and stop serving.
    if (tracking && this.objectiveComplete) {
      this.parkCourseBall();
      this.prevBallState = ball.state;
      return;
    }

    switch (this.objPhase) {
      case 'idle': {
        this.parkCourseBall();
        const pp = player.root.position;
        if (pointInBounds(COMBAT.arena, pp.x, pp.y, pp.z)) {
          this.objPhase = 'serving';
          this.serveTimer = COMBAT.serveWindupSeconds;
        }
        break;
      }
      case 'serving': {
        this.parkCourseBall();
        this.serveTimer -= dt;
        if (this.serveTimer <= 0) {
          this.serve(player);
          this.objPhase = 'live';
        }
        break;
      }
      case 'live': {
        // Real catch: a Live ball that became Held in the player's hand this frame.
        if (this.prevBallState === BallState.Live && ball.state === BallState.Held && ball.owner === 'player') {
          this.objPhase = 'caught';
          this.reserveTimer = 0;
          break;
        }
        if (this.isBallMissed(ball)) this.beginReserve();
        if (this.tickReserve(dt)) this.resetServe();
        break;
      }
      case 'caught': {
        if (ball.state === BallState.Live && ball.owner === 'player') {
          // Thrown back — did it hit the target?
          if (this.ballHitsTarget(ball, dt)) {
            this.completeObjective(tracking);
          } else if (this.isBallMissed(ball)) {
            this.beginReserve();
            if (this.tickReserve(dt)) this.resetServe();
          }
        } else if (ball.state === BallState.Held && ball.owner === 'player') {
          this.reserveTimer = 0; // still holding, waiting for the throw
        } else {
          // Dropped / went loose without scoring — re-serve after the delay.
          this.beginReserve();
          if (this.tickReserve(dt)) this.resetServe();
        }
        break;
      }
      case 'done':
        this.parkCourseBall();
        break;
    }

    this.prevBallState = ball.state;
  }

  private serve(player: PlayerController): void {
    const ball = this.courseBall;
    if (!ball) return;
    const aim = player.root.position.add(new Vector3(0, 1.1, 0)).subtract(COMBAT.serveOrigin);
    const len = aim.length() || 1;
    aim.scaleInPlace(1 / len);
    aim.y += COMBAT.serveArc;
    this.ballManager.throwBall(ball, COMBAT.serveOrigin, aim, COMBAT.serveSpeed, 'bot', false, 1);
  }

  private completeObjective(tracking: boolean): void {
    this.targetFlash = 1;
    if (tracking) {
      this.objectiveComplete = true;
      this.objPhase = 'done';
      this.parkCourseBall();
      this.hud.showBanner('OBJECTIVE COMPLETE', 'good', 2.2);
    } else {
      // Free practice: re-arm so the section stays usable.
      this.objPhase = 'idle';
      this.parkCourseBall();
      this.hud.showBanner('NICE — TARGET HIT', 'good', 1.6);
    }
  }

  private isBallMissed(ball: Ball): boolean {
    if (ball.state === BallState.Held && ball.owner === 'player') return false;
    if (ball.state === BallState.Dead || ball.state === BallState.Loose) return true;
    const p = ball.mesh.position;
    return !pointInBounds(COMBAT.arena, p.x, p.y, p.z);
  }

  private beginReserve(): void {
    if (this.reserveTimer <= 0) this.reserveTimer = COMBAT.reserveDelaySeconds;
  }

  /** Returns true on the frame the reserve delay elapses. */
  private tickReserve(dt: number): boolean {
    if (this.reserveTimer <= 0) return false;
    this.reserveTimer -= dt;
    return this.reserveTimer <= 0;
  }

  private resetServe(): void {
    this.reserveTimer = 0;
    this.objPhase = 'idle';
    this.parkCourseBall();
  }

  /** Hold the course ball at the thrower's hand (no physics) between serves. */
  private parkCourseBall(): void {
    const ball = this.courseBall;
    if (!ball) return;
    ball.state = BallState.Held;
    ball.owner = 'bot';
    ball.heldHand = null;
    ball.isSuper = false;
    ball.bounceCount = 0;
    ball.velocity.setAll(0);
    ball.mesh.position.copyFrom(COMBAT.serveOrigin);
  }

  private ballHitsTarget(ball: Ball, dt: number): boolean {
    if (ball.state !== BallState.Live || ball.owner !== 'player') return false;
    const t = COMBAT.target;
    const h = COMBAT.targetHalf;
    const r = TUNING.ball.radius;
    const minX = t.x - h.x - r, maxX = t.x + h.x + r;
    const minY = t.y - h.y - r, maxY = t.y + h.y + r;
    const minZ = t.z - h.z - r, maxZ = t.z + h.z + r;
    // Sample a few points along this tick's segment so a fast throw can't tunnel through the target.
    const cx = ball.mesh.position.x, cy = ball.mesh.position.y, cz = ball.mesh.position.z;
    const sx = ball.velocity.x * dt, sy = ball.velocity.y * dt, sz = ball.velocity.z * dt;
    for (let i = 0; i <= 3; i += 1) {
      const f = i / 3;
      const x = cx - sx * f, y = cy - sy * f, z = cz - sz * f;
      if (x >= minX && x <= maxX && y >= minY && y <= maxY && z >= minZ && z <= maxZ) return true;
    }
    return false;
  }

  private updateTargetFlash(dt: number): void {
    if (this.targetFlash <= 0) return;
    this.targetFlash = Math.max(0, this.targetFlash - dt * 2.2);
    const glow = 0.12 + this.targetFlash * 0.9;
    this.targetMat.emissiveColor.set(glow, glow * 0.25, glow * 0.18);
  }

  private ensureCourseBall(): void {
    if (this.courseBall) return;
    const ball = this.ballManager.createBall('course_obj_ball', COMBAT.serveOrigin.clone());
    this.ballManager.balls.push(ball);
    this.courseBall = ball;
    this.parkCourseBall();
    this.prevBallState = BallState.Held;
  }

  private removeCourseBall(): void {
    const ball = this.courseBall;
    if (!ball) return;
    const index = this.ballManager.balls.indexOf(ball);
    if (index >= 0) this.ballManager.balls.splice(index, 1);
    ball.mesh.dispose();
    this.courseBall = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Hints
  // ---------------------------------------------------------------------------------------------

  private computeHint(): string {
    if (this.state === 'finished') return 'T to run again  ·  hold E at the portal to leave';
    if (this.state === 'exploring') return 'Step on the START pad to begin  ·  T restart  ·  hold E to leave';
    // running
    if (this.objPhase === 'live') return 'CATCH the served ball (M1/M2)';
    if (this.objPhase === 'caught') return 'THROW it at the target';
    switch (this.nextGateIndex) {
      case 0: return 'Bhop the runway, air-strafe the sweep';
      case 1: return this.objectiveComplete ? 'Cross Checkpoint 2' : 'Catch the ball, hit the target';
      case 2: return 'Wall-run, wall-jump, then climb';
      case 3: return 'Final combo — BACKFLIP (Q) onto the finish';
      default: return '';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Gym prop management while the course is active
  // ---------------------------------------------------------------------------------------------

  private hideGymMats(): void {
    for (const mat of this.gym.mats) {
      mat.mesh.setEnabled(false);
      this.gym.removeMatCollision(mat);
    }
  }

  private restoreGymMats(): void {
    this.gym.resetMats();
    for (const mat of this.gym.mats) mat.mesh.setEnabled(true);
  }

  private addCollisionToGym(): void {
    for (const entry of this.collisionBoxes) {
      this.gym.collision.add(entry.box);
      if (entry.ball) this.gym.ballCollision.add(entry.box);
    }
  }

  private removeCollisionFromGym(): void {
    for (const world of [this.gym.collision, this.gym.ballCollision]) {
      for (let i = world.boxes.length - 1; i >= 0; i -= 1) {
        if (world.boxes[i].id?.startsWith(COURSE_BOX_ID_PREFIX)) world.boxes.splice(i, 1);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry construction (built once, lazily, on first entry)
  // ---------------------------------------------------------------------------------------------

  private build(): void {
    if (this.built) return;
    this.createMaterials();
    this.buildStaging();
    this.buildRunwayAndSweep();
    this.buildSlideZone();
    this.buildDashGap();
    this.buildCombatZone();
    this.buildWallRunZone();
    this.buildVerticalZone();
    this.buildFinalAndFinish();
    this.buildGates();
    // Static geometry — freeze the world matrices for the per-frame CPU/GC win (matches GymArena).
    for (const child of this.root.getChildMeshes(false)) {
      if (child instanceof Mesh) {
        child.isPickable = false;
        child.freezeWorldMatrix();
      }
    }
    this.built = true;
  }

  private createMaterials(): void {
    this.deckMat = this.solid('course_deck', new Color3(0.80, 0.74, 0.56), new Color3(0.04, 0.045, 0.05));
    this.padMat = this.solid('course_pad', new Color3(0.12, 0.28, 0.6), new Color3(0.02, 0.05, 0.12));
    this.laneMat = this.emissive('course_lane', new Color3(0.08, 0.34, 0.78));
    this.startMat = this.emissive('course_start', new Color3(0.08, 0.5, 0.22));
    this.cpMat = this.emissive('course_cp', new Color3(0.55, 0.42, 0.06));
    this.finishMat = this.emissive('course_finish', new Color3(0.05, 0.62, 0.6), 0.34);
    this.throwerMat = this.solid('course_thrower', new Color3(0.85, 0.45, 0.1), new Color3(0.18, 0.07, 0.01));
    this.targetMat = this.solid('course_target', new Color3(0.85, 0.16, 0.13), new Color3(0.16, 0.02, 0.02));

    this.arrowTexture = new DynamicTexture('course_arrow_tex', { width: 128, height: 128 }, this.scene, false);
    this.arrowTexture.hasAlpha = true;
    const ctx = this.arrowTexture.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 128, 128);
    ctx.fillStyle = 'rgba(120, 200, 255, 0.9)';
    ctx.beginPath();
    ctx.moveTo(64, 16);
    ctx.lineTo(112, 72);
    ctx.lineTo(84, 72);
    ctx.lineTo(84, 112);
    ctx.lineTo(44, 112);
    ctx.lineTo(44, 72);
    ctx.lineTo(16, 72);
    ctx.closePath();
    ctx.fill();
    this.arrowTexture.update(true);
    this.disposables.push(this.arrowTexture);
  }

  // --- Zone builders ---------------------------------------------------------------------------

  private buildStaging(): void {
    // Start pad (emissive green deck pad).
    this.pad('course_start_pad', START_PAD.center.x, 0.04, START_PAD.center.z, 3.0, 1.6, this.startMat);
    this.sign('start_sign', 'STEP ON THE PAD\nTO START A TIMED RUN', new Vector3(0, 2.1, 11.9), 3.0, 1.1);
    this.sign('mech_sign', 'BHOP · STRAFE · SLIDE · DASH\nWALL-RUN · BACKFLIP', new Vector3(3.6, 1.7, 13.6), 3.0, 0.95);

    // Leave-course portal frame (hold E).
    const post = (x: number) => {
      const p = MeshBuilder.CreateBox(`leave_post_${x}`, { width: 0.18, height: 2.4, depth: 0.18 }, this.scene);
      p.position.set(LEAVE_PORTAL.position.x + x, 1.2, LEAVE_PORTAL.position.z);
      p.material = this.padMat;
      p.parent = this.root;
    };
    post(-0.7); post(0.7);
    const beam = MeshBuilder.CreateBox('leave_beam', { width: 1.7, height: 0.2, depth: 0.18 }, this.scene);
    beam.position.set(LEAVE_PORTAL.position.x, 2.3, LEAVE_PORTAL.position.z);
    beam.material = this.laneMat;
    beam.parent = this.root;
    this.sign('leave_sign', 'LEAVE COURSE\nHOLD E', new Vector3(LEAVE_PORTAL.position.x, 2.95, LEAVE_PORTAL.position.z), 1.8, 0.8);

    // Leaderboard stand prop (the live board is the HTML HUD; this is just the physical sign).
    const board = MeshBuilder.CreateBox('lb_board', { width: 2.2, height: 1.3, depth: 0.12 }, this.scene);
    board.position.set(4.2, 1.5, 13.8);
    board.material = this.padMat;
    board.parent = this.root;
    this.sign('lb_sign', 'LOCAL TOP 10\n→ see panel', new Vector3(4.2, 1.5, 13.72), 1.9, 1.0);
  }

  private buildRunwayAndSweep(): void {
    // Runway: flat lane on the gym floor (y=0) with emissive edge trim + forward arrows. No collision.
    for (const x of [-1.7, 1.7]) this.trim(`runway_trim_${x}`, x, 0.02, 7.0, 0.16, 8.0);
    for (const z of [9.5, 7.0, 4.5]) this.arrow(`runway_arrow_${z}`, 0, z, 0);
    this.sign('runway_sign', 'BUILD SPEED — JUMP ON LANDING', new Vector3(0, 1.7, 9.0), 3.4, 0.7);

    // Air-strafe sweep: low guide walls along a westward arc (readable, hop-overable — not forced).
    const arc: Array<[number, number, number]> = [
      [-1.0, 2.6, -0.5], [-2.6, 1.8, -0.7], [-4.3, 1.0, -0.95], [-6.0, 0.2, -1.2], [-7.4, -0.6, -1.45]
    ];
    let i = 0;
    for (const [x, z, yaw] of arc) {
      this.guideWall(`sweep_outer_${i}`, x - 1.9, z, 0.8, yaw);
      this.arrow(`sweep_arrow_${i}`, x, z, yaw);
      i += 1;
    }
    this.sign('sweep_sign', 'AIR-STRAFE THE CURVE', new Vector3(-3.5, 1.6, 1.4), 2.8, 0.7);
  }

  private buildSlideZone(): void {
    // Slide tunnel: a floating overhead slab (underside 1.45m) you must slide/crouch under, with
    // padded side walls so it reads as a tunnel. Heading -Z from cp1.
    const cx = -8;
    this.box('slide_roof', cx, 1.7, -4.5, 3.0, 0.45, 3.6, this.padMat, { collide: true, ball: true });
    this.box('slide_wall_w', cx - 1.65, 1.0, -4.5, 0.3, 2.0, 3.6, this.padMat, { collide: true, ball: true });
    this.box('slide_wall_e', cx + 1.65, 1.0, -4.5, 0.3, 2.0, 3.6, this.padMat, { collide: true, ball: true });
    this.sign('slide_sign', 'SLIDE (C) UNDER', new Vector3(cx, 2.3, -2.9), 2.4, 0.6);

    // Slide-jump carry: a low ledge just past the tunnel rewards jumping out of the slide with speed.
    this.box('slide_ledge', cx, 0.25, -7.3, 3.0, 0.5, 1.4, this.deckMat, { collide: true, ball: true });
    this.arrow('slide_arrow', cx, -6.2, 0);
  }

  private buildDashGap(): void {
    // Two raised platforms with a ~3m gap: a directional dash (or dash-jump) clears it cleanly, while
    // a plain jump falls short and drops to the open combat floor below (y=0) — a time loss, not a
    // reset. There is no pit; the floor itself is the safe recovery, and it feeds straight into Zone 5.
    const cx = -8;
    this.box('dash_takeoff', cx, 0.6, -8.8, 3.2, 1.2, 1.8, this.deckMat, { collide: true, ball: true });
    this.box('dash_landing', cx, 0.6, -13.8, 3.4, 1.2, 2.0, this.deckMat, { collide: true, ball: true });
    this.trim('dash_edge_a', cx, 1.24, -9.7, 3.2, 0.12);
    this.trim('dash_edge_b', cx, 1.24, -12.8, 3.4, 0.12);
    this.arrow('dash_arrow', cx, -8.8, 0);
    this.sign('dash_sign', 'DASH (SHIFT) THE GAP', new Vector3(cx, 2.0, -8.8), 2.8, 0.7);
    this.sign('recover_sign', 'MISS = DROP TO THE FLOOR\n(slower, not a reset)', new Vector3(cx, 0.8, -11.3), 2.6, 0.7);
  }

  private buildCombatZone(): void {
    // Open bay at floor level. Thrower (west) serves the course ball; player catches and returns it
    // to the target (east). Both are simple stationary props.
    this.buildThrower(COMBAT.thrower);
    this.targetMesh = this.buildTarget(COMBAT.target);
    this.sign('combat_sign', 'CATCH THE SERVE → HIT THE TARGET', new Vector3(0, 2.4, -11.0), 4.2, 0.7);
    this.arrow('combat_arrow', 0, -13, Math.PI / 2); // points east toward the target / cp2
  }

  private buildThrower(pos: Vector3): void {
    const body = MeshBuilder.CreateCapsule('course_thrower_body', { height: 1.8, radius: 0.32, tessellation: 12 }, this.scene);
    body.position.set(pos.x, 0.9, pos.z);
    body.material = this.throwerMat;
    body.parent = this.root;
    const head = MeshBuilder.CreateSphere('course_thrower_head', { diameter: 0.46, segments: 12 }, this.scene);
    head.position.set(pos.x, 1.95, pos.z);
    head.material = this.throwerMat;
    head.parent = this.root;
    this.sign('thrower_sign', 'SERVER', new Vector3(pos.x, 2.5, pos.z), 1.3, 0.5);
  }

  private buildTarget(pos: Vector3): Mesh {
    const body = MeshBuilder.CreateBox('course_target_body', {
      width: COMBAT.targetHalf.x * 2, height: COMBAT.targetHalf.y * 2, depth: COMBAT.targetHalf.z * 2
    }, this.scene);
    body.position.copyFrom(pos);
    body.material = this.targetMat;
    body.parent = this.root;
    const ring = MeshBuilder.CreateTorus('course_target_ring', { diameter: 0.9, thickness: 0.12, tessellation: 18 }, this.scene);
    ring.position.set(pos.x - COMBAT.targetHalf.x - 0.02, pos.y, pos.z);
    ring.rotation.z = Math.PI / 2;
    ring.material = this.laneMat;
    ring.parent = this.root;
    this.sign('target_sign', 'TARGET', new Vector3(pos.x, pos.y + 1.4, pos.z), 1.4, 0.5);
    return body;
  }

  private buildWallRunZone(): void {
    // Wall-run along the SOUTH perimeter wall (z = -18). The bleachers line the X-side walls (they
    // span z∈[-13,13]), so the north/south walls are the clear perimeter the offline controller can
    // wall-run on. The player runs west along the floor lane hugging the wall, jumps to start the
    // wall-run, climbs, then wall-jumps north onto the landing platform.
    this.trim('wr_lane_trim', 6.5, 0.02, -17.1, 7.6, 0.18);
    for (const [x, z] of [[8.4, -17.1], [6.4, -17.1], [4.6, -17.1]] as Array<[number, number]>) {
      this.arrow(`wr_arrow_${x}`, x, z, -Math.PI / 2); // along the wall, heading west
    }
    this.sign('wr_sign', 'RUN THE SOUTH WALL ←\nJUMP TO WALL-RUN · SPACE = WALL-JUMP', new Vector3(7.0, 2.4, -16.0), 4.4, 1.0);

    // Wall-jump landing platform (north of the wall-run lane).
    this.box('wr_landing', 3.2, 1.1, -14.6, 3.0, 2.2, 2.2, this.deckMat, { collide: true, ball: true });

    // Slow fallback: jumpable steps from the floor up to the landing so a failed wall-run still
    // progresses (loses time rather than dead-ending).
    this.box('wr_step1', 6.0, 0.4, -15.7, 1.4, 0.8, 1.2, this.deckMat, { collide: true, ball: false });
    this.box('wr_step2', 4.8, 0.9, -15.2, 1.4, 1.8, 1.2, this.deckMat, { collide: true, ball: false });
  }

  private buildVerticalZone(): void {
    // Moderate vertical climb from the wall-jump landing (y≈2.2) up to cp3 (y≈3.85), in jumpable
    // steps. The optional optimisation: a jump + upward-dash from the landing reaches the top step
    // directly (~1.65m), skipping the middle steps and saving time. Marked with a pad.
    this.box('vert_step1', 3.2, 2.45, -13.7, 2.6, 0.5, 1.3, this.deckMat, { collide: true, ball: true });
    this.box('vert_step2', 3.2, 3.0, -13.1, 2.6, 0.5, 1.3, this.deckMat, { collide: true, ball: true });
    this.box('vert_top', 3.2, 3.6, -12.4, 3.2, 0.5, 1.8, this.deckMat, { collide: true, ball: true });
    this.trim('vert_top_trim', 3.2, 3.86, -11.7, 3.2, 0.14);
    this.pad('vert_dashpad', 3.2, 2.27, -14.4, 1.4, 1.0, this.laneMat);
    this.sign('vert_sign', 'CLIMB TO CP3\n(↑DASH skip optional)', new Vector3(3.2, 4.9, -13.0), 3.0, 0.9);
  }

  private buildFinalAndFinish(): void {
    // Final approach: a descending walkway from cp3 that reaches the FLOOR before the finish zone, so
    // the run-in is at ground level and the high finish gate can only be cleared with a backflip.
    this.box('final_walk1', 2.6, 3.1, -10.6, 2.6, 0.5, 2.2, this.deckMat, { collide: true, ball: true });
    this.box('final_walk2', 1.8, 2.3, -8.8, 2.4, 0.5, 2.0, this.deckMat, { collide: true, ball: true });
    this.box('final_walk3', 1.0, 1.5, -7.2, 2.2, 0.5, 1.8, this.deckMat, { collide: true, ball: true });
    this.box('final_walk4', 0.4, 0.8, -5.8, 2.0, 0.5, 1.6, this.deckMat, { collide: true, ball: true });
    for (const [x, z, yaw] of [[2.2, -10.0, Math.PI], [1.2, -8.2, Math.PI], [0.4, -6.2, Math.PI]] as Array<[number, number, number]>) {
      this.arrow(`final_arrow_${x}`, x, z, yaw);
    }

    // Finish pad (floor level) + a HIGH transparent finish ribbon. The player backflips straight up
    // off the pad; their body rises through the ribbon (y≈2.2–2.9) which a normal jump can't reach.
    this.pad('finish_pad', 0, 0.05, -4.0, 3.0, 2.6, this.finishMat);
    this.trim('finish_pad_trim_n', 0, 0.06, -2.8, 3.0, 0.16);
    this.trim('finish_pad_trim_s', 0, 0.06, -5.2, 3.0, 0.16);
    const corners: Array<[number, number]> = [[-1.6, -2.9], [1.6, -2.9], [-1.6, -5.1], [1.6, -5.1]];
    for (const [x, z] of corners) {
      const post = MeshBuilder.CreateBox(`finish_post_${x}_${z}`, { width: 0.16, height: 2.3, depth: 0.16 }, this.scene);
      post.position.set(x, 1.15, z);
      post.material = this.laneMat;
      post.parent = this.root;
    }
    const ribbon = MeshBuilder.CreateBox('finish_ribbon', { width: 3.4, height: 0.14, depth: 2.4 }, this.scene);
    ribbon.position.set(0, 2.25, -4.0);
    ribbon.material = this.finishMat;
    ribbon.parent = this.root;
    this.sign('final_sign', 'BACKFLIP (Q) UP\nTHROUGH THE FINISH', new Vector3(0, 3.1, -4.0), 3.2, 1.0);
  }

  private buildGates(): void {
    // Visual gate frames at each checkpoint (gold) — the trigger volumes themselves live in config.
    for (const gate of GATES) {
      if (gate.id === 'finish') continue; // finish has its own transparent gate
      this.gateFrame(gate);
    }
  }

  private gateFrame(gate: GateConfig): void {
    const b = gate.bounds;
    const cx = (b.minX + b.maxX) / 2;
    const cz = (b.minZ + b.maxZ) / 2;
    const baseY = b.minY;
    const width = Math.max(b.maxX - b.minX, b.maxZ - b.minZ) + 0.6;
    const alongX = b.maxX - b.minX >= b.maxZ - b.minZ;
    const height = 2.6;
    const mk = (name: string, x: number, y: number, z: number, w: number, h: number, d: number) => {
      const m = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
      m.position.set(x, y, z);
      m.material = this.cpMat;
      m.parent = this.root;
    };
    const half = width / 2;
    if (alongX) {
      mk(`${gate.id}_postA`, cx - half, baseY + height / 2, cz, 0.18, height, 0.18);
      mk(`${gate.id}_postB`, cx + half, baseY + height / 2, cz, 0.18, height, 0.18);
      mk(`${gate.id}_top`, cx, baseY + height, cz, width, 0.18, 0.18);
    } else {
      mk(`${gate.id}_postA`, cx, baseY + height / 2, cz - half, 0.18, height, 0.18);
      mk(`${gate.id}_postB`, cx, baseY + height / 2, cz + half, 0.18, height, 0.18);
      mk(`${gate.id}_top`, cx, baseY + height, cz, 0.18, 0.18, width);
    }
    this.sign(`${gate.id}_label`, gate.label.toUpperCase(), new Vector3(cx, baseY + height + 0.4, cz), 1.8, 0.5);
  }

  // --- Low-level builders ----------------------------------------------------------------------

  /**
   * Solid box with a visual mesh + optional collision AABB(s). `collide` adds it to the player
   * collision world; `ball` (default = collide) also adds it to the ball collision world.
   */
  private box(
    name: string,
    cx: number, cy: number, cz: number,
    w: number, h: number, d: number,
    material: StandardMaterial,
    opts: { collide?: boolean; ball?: boolean } = {}
  ): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
    mesh.position.set(cx, cy, cz);
    mesh.material = material;
    mesh.parent = this.root;
    const collide = opts.collide ?? true;
    if (collide) {
      const ball = opts.ball ?? true;
      const aabb = aabbFromCenter(cx, cy, cz, w / 2, h / 2, d / 2);
      aabb.id = `${COURSE_BOX_ID_PREFIX}${this.nextBoxId++}`;
      this.collisionBoxes.push({ box: aabb, ball });
    }
    return mesh;
  }

  /** Flat emissive deck pad (no collision) — start pad, dash markers, etc. */
  private pad(name: string, cx: number, cy: number, cz: number, w: number, d: number, material: StandardMaterial): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width: w, height: 0.06, depth: d }, this.scene);
    mesh.position.set(cx, cy, cz);
    mesh.material = material;
    mesh.parent = this.root;
    return mesh;
  }

  /** Thin emissive floor trim strip (no collision). */
  private trim(name: string, cx: number, cy: number, cz: number, w: number, d: number): Mesh {
    const mesh = MeshBuilder.CreateBox(name, { width: w, height: 0.05, depth: d }, this.scene);
    mesh.position.set(cx, cy, cz);
    mesh.material = this.laneMat;
    mesh.parent = this.root;
    return mesh;
  }

  /** Low channelling guide wall (collision) — readable but hop-overable, so the line isn't forced. */
  private guideWall(name: string, cx: number, cz: number, height: number, yaw: number): Mesh {
    const mesh = this.box(name, cx, height / 2, cz, 0.3, height, 2.2, this.padMat, { collide: true, ball: false });
    mesh.rotation.y = yaw;
    return mesh;
  }

  /** Flat floor arrow decal pointing along travel (yaw radians; 0 = -Z). */
  private arrow(name: string, cx: number, cz: number, yaw: number): Mesh {
    const mesh = MeshBuilder.CreatePlane(name, { size: 1.4 }, this.scene);
    mesh.position.set(cx, 0.03, cz);
    mesh.rotation.x = Math.PI / 2;
    mesh.rotation.y = yaw;
    const mat = this.arrowMaterial();
    mesh.material = mat;
    mesh.parent = this.root;
    return mesh;
  }

  private _arrowMat: StandardMaterial | null = null;
  private arrowMaterial(): StandardMaterial {
    if (this._arrowMat) return this._arrowMat;
    const mat = new StandardMaterial('course_arrow_mat', this.scene);
    mat.diffuseColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(0.4, 0.7, 1.0);
    mat.emissiveTexture = this.arrowTexture;
    mat.opacityTexture = this.arrowTexture;
    mat.disableLighting = true;
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.materials.push(mat);
    this._arrowMat = mat;
    return mat;
  }

  /** Text sign plane (cheap DynamicTexture). */
  private sign(name: string, text: string, position: Vector3, width: number, height: number): Mesh {
    const tex = new DynamicTexture(`${name}_tex`, { width: 512, height: 256 }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 256);
    ctx.fillStyle = 'rgba(10, 16, 38, 0.86)';
    roundRect(ctx, 12, 12, 488, 232, 22);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 200, 255, 0.6)';
    ctx.lineWidth = 4;
    roundRect(ctx, 12, 12, 488, 232, 22);
    ctx.stroke();
    ctx.fillStyle = '#eef4ff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = text.split('\n');
    const fontSize = lines.length > 1 ? 52 : 64;
    ctx.font = `900 ${fontSize}px Arial`;
    const lineH = fontSize + 12;
    const startY = 128 - ((lines.length - 1) * lineH) / 2;
    lines.forEach((line, i) => ctx.fillText(line, 256, startY + i * lineH));
    tex.update(true);

    const mat = new StandardMaterial(`${name}_mat`, this.scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.opacityTexture = tex;
    mat.emissiveColor = new Color3(0.9, 0.94, 1.0);
    mat.disableLighting = true;
    mat.specularColor = new Color3(0, 0, 0);
    mat.backFaceCulling = false;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;

    const mesh = MeshBuilder.CreatePlane(name, { width, height }, this.scene);
    mesh.position.copyFrom(position);
    mesh.material = mat;
    mesh.parent = this.root;
    this.disposables.push(tex, mat);
    return mesh;
  }

  private solid(name: string, diffuse: Color3, emissive: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = diffuse;
    m.emissiveColor = emissive;
    m.specularColor = new Color3(0.05, 0.05, 0.05);
    this.materials.push(m);
    return m;
  }

  private emissive(name: string, color: Color3, alpha = 1): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseColor = new Color3(0.02, 0.02, 0.02);
    m.emissiveColor = color;
    m.specularColor = new Color3(0, 0, 0);
    m.disableLighting = true;
    if (alpha < 1) {
      m.alpha = alpha;
      m.transparencyMode = Material.MATERIAL_ALPHABLEND;
      m.backFaceCulling = false;
    }
    this.materials.push(m);
    return m;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
