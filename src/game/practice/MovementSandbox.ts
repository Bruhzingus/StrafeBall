import {
  Color3,
  Color4,
  DynamicTexture,
  Material,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  Vector4
} from '@babylonjs/core';
import { GymArena } from '../map/GymArena';
import { PlayerController } from '../player/PlayerController';
import { MovementWorld } from '../player/MovementController';
import { InputManager } from '../input/InputManager';
import { CONTROL_KEYS } from '../config/controls';
import { AABB } from '../map/Collider';
import {
  BOUNDARY_HEIGHT,
  BOUNDARY_THICKNESS,
  SANDBOX_CEILING_Y,
  SANDBOX_CENTER,
  sandboxLeaveWorld
} from './MovementSandboxLayout';
import {
  collectSpawnerMarkers,
  layoutCourseSpawn,
  type CreatorLayout,
  type CreatorSpawnerMarkers
} from './creator/CreatorLayout';
import {
  buildCreatorCollisionBoxes,
  buildCreatorWallBounceFaces,
  buildCreatorWallFaces,
  layoutWorldBounds,
  type CreatorWallFace
} from './creator/CreatorWorld';
import { loadCurrentCourseLayout } from './creator/CreatorStorage';
import { CreatorGeometry } from './creator/CreatorGeometry';
import { CreatorPads } from './creator/CreatorPads';
import { CreatorMovers } from './creator/CreatorMovers';
import { CourseRunTracker } from './creator/CourseRun';
import { CourseRunHud } from './creator/CourseRunHud';
import { TUNING } from '../config/tuning';
import type { RaceRunEvent } from '../../../shared/courseRace';
import { PortalArch, type PortalPalette } from './PortalArch';
import { getGraphicsQuality } from '../config/graphicsConfig';
import {
  enterSandboxAtmosphere,
  exitSandboxAtmosphere,
  competitiveSandboxSkyStyle,
  registerSandboxShadowGeometry,
  setSandboxSkyPreset
} from './SandboxAtmosphere';

export type SandboxAction = 'leave' | 'race' | 'coop';

const COLLISION_ID_PREFIX = 'sandbox_';
const WALL_RUN_MARGIN = 1.0;
/** World size (metres) of one grid cell on the ground + walls — large + spaced out, consistent on every face. */
const GRID_CELL_METRES = 10;

const BACK_TO_LOBBY_PALETTE: PortalPalette = {
  edge: new Color3(0.22, 0.88, 0.42),
  status: new Color3(0.14, 0.62, 0.3),
  surfaceBack: new Color3(0.03, 0.32, 0.12),
  surfaceFront: new Color3(0.22, 0.72, 0.35)
};

const RACE_ONLINE_PALETTE: PortalPalette = {
  edge: new Color3(1.0, 0.56, 0.14),
  status: new Color3(0.85, 0.42, 0.06),
  surfaceBack: new Color3(0.5, 0.2, 0.02),
  surfaceFront: new Color3(0.95, 0.55, 0.14)
};

// Co-op build-together portal — magenta, deliberately distinct from the purple Course Creator entry
// (solo build), the orange Race Online, and the green Back to Lobby. Channels kept non-equal so the
// scene's ACES tonemap can't clip it toward white.
const CO_OP_PALETTE: PortalPalette = {
  edge: new Color3(1.0, 0.32, 0.72),
  status: new Color3(0.82, 0.2, 0.56),
  surfaceBack: new Color3(0.52, 0.05, 0.34),
  surfaceFront: new Color3(0.95, 0.3, 0.68)
};

/**
 * Local outdoor Movement Sandbox: a large free-movement yard placed far from the gym, running the
 * user's published Creator course (else the committed one) with FULL playtest parity: the same
 * renderer (solids with real textures, ability pads, kill blocks, gates, signs, arrows, labels via
 * CreatorGeometry with editor overlays off), the same pad/kill-block/checkpoint runtime
 * (CreatorPads), and the same spawner markers (balls/bots/dummies — spawned by ArenaScene from
 * getSpawnerMarkers()). The yard owns its own ground + outer boundary + spawn/leave furniture,
 * implements the offline MovementController's world override, and a single hold-E leave portal.
 *
 * Strictly offline/practice-only: ArenaScene updates it only from the offline step path, never from
 * stepOnline, and tears it down before connected play. It implements MovementWorld so the offline
 * controller can clamp to the yard and wall-run the course walls.
 */
export class MovementSandbox implements MovementWorld {
  public active = false;
  private readonly polishedAtmosphere = getGraphicsQuality() === 'polished';

  // MovementWorld bounds (world space).
  public readonly minX: number;
  public readonly maxX: number;
  public readonly minZ: number;
  public readonly maxZ: number;
  public readonly ceilingY = SANDBOX_CEILING_Y;
  public readonly floorY: number;

  private readonly root: TransformNode;
  private readonly materials: StandardMaterial[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly collisionBoxes: AABB[] = [];
  private wallRunFaces: CreatorWallFace[] = [];
  private wallBounceFaces: CreatorWallFace[] = [];
  private built = false;

  // The committed course layout the yard renders. `courseLayout` excludes the outer boundary walls
  // (the yard draws + clamps its own boundary), leaving the editable course pieces. `visualLayout`
  // further drops the spawn/leave/test-spawn markers whose furniture the yard builds itself.
  private readonly fullLayout: CreatorLayout;
  private readonly courseLayout: CreatorLayout;
  private readonly visualLayout: CreatorLayout;
  private readonly leavePoint: { x: number; z: number; yaw: number; radius: number; holdSeconds: number };
  // Portal props for the leave/race/coop hold-E points (built lazily in buildSpawn()); animated per-frame.
  private leavePortalArch: PortalArch | null = null;
  private racePortalArch: PortalArch | null = null;
  private coopPortalArch: PortalArch | null = null;
  private elapsed = 0;
  // Course visuals: the SAME renderer the Creator editor uses (solids incl. real textures, ability
  // pads, kill blocks, gates, signs, arrows, labels) with every editor-only overlay disabled — so a
  // published course looks exactly like its playtest. Built lazily with the rest of the yard.
  private geometry: CreatorGeometry | null = null;
  // Course effects: the SAME pad/kill-block/checkpoint runtime playtest uses.
  private readonly pads = new CreatorPads();
  // Moving platforms — same deterministic runtime as creator playtest.
  private readonly movers = new CreatorMovers();
  // Timed course run (start → checkpoints → finish). Inert unless the layout has BOTH gates.
  private courseRun: CourseRunTracker | null = null;
  private courseHud: CourseRunHud | null = null;
  private suspended = false;

  // Saved scene sky/fog state, restored on exit.
  private savedClearColor: Color4 | null = null;
  private savedFog: { mode: number; color: Color3; start: number; end: number; density: number } | null = null;

  private leaveHold = 0;
  private leaveLatched = false;
  private racePoint: { x: number; z: number; yaw: number; radius: number; holdSeconds: number };
  private raceHold = 0;
  private raceLatched = false;
  private coopPoint: { x: number; z: number; yaw: number; radius: number; holdSeconds: number };
  private coopHold = 0;
  private coopLatched = false;
  /** Slot for the Course Creator's own entry portal (built separately by CreatorEditor), kept in the
   *  same row as leave/race so all three read as one connected hub regardless of course layout. */
  private readonly creatorEntrySlot: { x: number; y: number; z: number; yaw: number };
  /** Optional tee of course-run events (start/checkpoint/finish/reset) for the online race relay. */
  private runEventListener: ((event: RaceRunEvent) => void) | null = null;

  /**
   * @param layoutOverride A specific course to build instead of the player's own (used when
   * JOINING an online race — the yard runs the host's course). Omitted = the player's active
   * Creator project working copy, else the committed default.
   */
  constructor(private readonly scene: Scene, private readonly gym: GymArena, layoutOverride?: CreatorLayout) {
    // The map is the most recent state the player had: the Creator's latest working copy
    // (autosave/quick-save), else the committed default. Local only — reverting to the default is
    // a manual editor action (Revert to Default Map).
    const layout = layoutOverride ?? loadCurrentCourseLayout();
    this.fullLayout = layout;
    this.floorY = layout.ground.bounds.y ?? 0;
    this.courseLayout = { ...layout, objects: layout.objects.filter((o) => o.type !== 'boundary_wall') };
    const yardFurniture = new Set(['spawn_point', 'leave_portal', 'test_spawn']);
    this.visualLayout = { ...layout, objects: this.courseLayout.objects.filter((o) => !yardFurniture.has(o.type)) };

    const b = layoutWorldBounds(layout);
    this.minX = b.minX;
    this.maxX = b.maxX;
    this.minZ = b.minZ;
    this.maxZ = b.maxZ;

    // All four portals sit in ONE row anchored to the course's spawn, so they land right where the
    // player arrives (clear ground the author kept walkable) and every one is reachable the moment you
    // load in. They're a consistent, single hub — not scattered — but still spawn-relative: a fixed
    // WORLD location instead drifts into the course's own geometry and leaves most portals unreachable
    // (only whichever slot happens to land in the clear still works). The player spawns at the same
    // marker, so the row is always a few steps in front of you.
    const fallbackLeave = sandboxLeaveWorld();
    const spawnPoint = layoutCourseSpawn(layout);
    const fwdX = Math.sin(spawnPoint.yaw);
    const fwdZ = Math.cos(spawnPoint.yaw);
    const rightX = Math.cos(spawnPoint.yaw);
    const rightZ = -Math.sin(spawnPoint.yaw);
    const PORTAL_FORWARD_OFFSET = 5;
    const PORTAL_SPACING = 5;
    const rowX = spawnPoint.x + fwdX * PORTAL_FORWARD_OFFSET;
    const rowZ = spawnPoint.z + fwdZ * PORTAL_FORWARD_OFFSET;
    // Slot n = offset along the row (in PORTAL_SPACING units); each portal faces back toward spawn so
    // its front reads as you approach. Order: Back to Lobby · Course Creator · Co-op Build · Race Online.
    const portalSlot = (n: number) => {
      const x = rowX + rightX * PORTAL_SPACING * n;
      const z = rowZ + rightZ * PORTAL_SPACING * n;
      return {
        x,
        y: this.floorY,
        z,
        yaw: Math.atan2(spawnPoint.x - x, spawnPoint.z - z),
        radius: fallbackLeave.radius,
        holdSeconds: fallbackLeave.holdSeconds
      };
    };
    this.leavePoint = portalSlot(-1.5);
    this.creatorEntrySlot = portalSlot(-0.5); // Course Creator entry (portal built by CreatorEditor)
    this.coopPoint = portalSlot(0.5);
    this.racePoint = portalSlot(1.5);

    this.root = new TransformNode('movement_sandbox_root', scene);
    this.root.setEnabled(false);
  }

  // ---------------------------------------------------------------------------------------------
  // MovementWorld
  // ---------------------------------------------------------------------------------------------

  /** Nearest wall-run face within range (below its top, within its span, on its open side), else null. */
  wallNormalAt(x: number, z: number, y: number): Vector3 | null {
    return this.normalAt(this.wallRunFaces, x, z, y);
  }

  wallBounceNormalAt(x: number, z: number, y: number): Vector3 | null {
    return this.normalAt(this.wallBounceFaces, x, z, y);
  }

  private normalAt(faces: CreatorWallFace[], x: number, z: number, y: number): Vector3 | null {
    let best: CreatorWallFace | null = null;
    let bestDist = WALL_RUN_MARGIN;
    for (const f of faces) {
      if (y > f.topY) continue;
      const d = (x - f.ox) * f.nx + (z - f.oz) * f.nz; // distance along the outward normal
      if (d < 0 || d > bestDist) continue;
      const t = (x - f.ox) * f.tx + (z - f.oz) * f.tz; // position along the face tangent
      if (t < -f.halfLen || t > f.halfLen) continue;
      best = f;
      bestDist = d;
    }
    return best ? new Vector3(best.nx, 0, best.nz) : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  enter(player: PlayerController): void {
    if (this.active) return;
    if (!this.built) this.build();
    this.active = true;

    this.root.setEnabled(true);
    this.geometry?.setEnabled(true);
    this.suspended = false;
    this.pads.reset();
    this.movers.resetPhase();
    this.ensureCourseRun();
    this.courseRun?.reset('leave');
    if (this.courseRun?.isTimed()) {
      this.courseHud?.renderLeaderboard(this.courseRun.localRecords());
      this.courseHud?.setVisible(true);
      this.courseHud?.showIdle(this.courseRun.bestMs());
    }
    for (const box of this.collisionBoxes) this.gym.collision.add(box);
    if (this.polishedAtmosphere) {
      setSandboxSkyPreset(this.scene, this.fullLayout.sky ?? 'clear');
      enterSandboxAtmosphere(this.scene);
    }
    else this.applyOutdoorSky();

    player.hands.clearHands();
    player.movement.setWorld(this);
    const spawn = layoutCourseSpawn(this.fullLayout);
    player.setRespawn(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw);
    player.teleportTo(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw, 0);

    this.leaveHold = 0;
    this.leaveLatched = false;
  }

  exit(player?: PlayerController): void {
    if (!this.active) return;
    this.active = false;
    this.root.setEnabled(false);
    this.geometry?.setEnabled(false);
    this.courseRun?.reset('leave');
    this.courseHud?.setVisible(false);
    this.movers.resetPhase();
    this.removeCollisionFromGym();
    if (this.polishedAtmosphere) exitSandboxAtmosphere(this.scene);
    else this.restoreSky();
    if (player) {
      player.movement.setWorld(null);
      player.setRespawn();
    }
  }

  /** Ball/bot/dummy spawner markers of the course this yard is running (shared collector). */
  getSpawnerMarkers(): CreatorSpawnerMarkers {
    return collectSpawnerMarkers(this.fullLayout);
  }

  /** The complete course layout this yard is running (what an online race host shares). */
  getFullLayout(): CreatorLayout {
    return this.fullLayout;
  }

  /** World position + facing for the Course Creator's own entry portal (built by CreatorEditor),
   *  kept in the same row as the leave/race portals so all three read as one connected hub. */
  creatorEntryPoint(): { x: number; y: number; z: number; yaw: number } {
    return this.creatorEntrySlot;
  }

  /** Tee course-run events (start/checkpoint/finish/reset) — used by the online race relay. */
  setRunEventListener(listener: ((event: RaceRunEvent) => void) | null): void {
    this.runEventListener = listener;
  }

  /**
   * Reset the run and put the player back at the start — used when an online race host restarts
   * everyone. Mirrors a fresh playtest start: full stamina, pads/movers/timer reset.
   */
  restartRun(player: PlayerController): void {
    if (!this.active || this.suspended) return;
    this.courseRun?.reset('reset');
    this.pads.reset();
    this.movers.resetPhase();
    player.dash.refill();
    player.backflip.cooldown = 0;
    const spawn = layoutCourseSpawn(this.fullLayout);
    player.setRespawn(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw);
    player.teleportTo(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw, 0);
    if (this.courseRun?.isTimed()) this.courseHud?.showIdle(this.courseRun.bestMs());
  }

  /** Lazily build the timed-course tracker + HUD (only shows anything for layouts with both gates). */
  private ensureCourseRun(): void {
    if (this.courseRun) return;
    const hud = new CourseRunHud(document.getElementById('hud-root') ?? document.body, this.fullLayout.name);
    this.courseHud = hud;
    this.courseRun = new CourseRunTracker(this.fullLayout, {
      onRunStart: () => {
        // Deterministic routes: every attempt sees the platforms at their starting phase.
        this.movers.resetPhase();
        hud.tick(0, 0, this.courseRun?.state.checkpointCount ?? 0);
        this.runEventListener?.({ kind: 'start' });
      },
      onCheckpoint: (collected, total, splitMs) => {
        hud.showCheckpoint(collected, total, splitMs);
        this.runEventListener?.({ kind: 'checkpoint', checkpoint: collected, checkpointTotal: total, timeMs: splitMs });
      },
      onMissedCheckpoint: (n) => hud.showMissedCheckpoint(n),
      onFinish: (timeMs, bestMs, isPb, placement, records) => {
        hud.renderLeaderboard(records, placement);
        hud.showFinish(timeMs, bestMs, isPb);
        this.runEventListener?.({ kind: 'finish', timeMs });
      },
      onRunReset: (reason) => {
        hud.showRunReset(reason);
        this.runEventListener?.({ kind: 'reset' });
      }
    });
    hud.renderLeaderboard(this.courseRun.localRecords());
  }

  dispose(): void {
    // ArenaScene normally exits first. Keep direct disposal safe as well (scene teardown / future
    // callers) so a live yard can never leave the gym renderer paused.
    if (this.active) {
      if (this.polishedAtmosphere) exitSandboxAtmosphere(this.scene);
      else this.restoreSky();
      this.active = false;
    }
    this.courseHud?.dispose();
    this.geometry?.dispose();
    this.leavePortalArch?.dispose();
    this.racePortalArch?.dispose();
    this.coopPortalArch?.dispose();
    for (const d of this.disposables) d.dispose();
    for (const m of this.materials) m.dispose();
    this.root.dispose();
  }

  /**
   * Yield to the Creator Sandbox editor: hide the static walls + remove the sandbox's collision so
   * the editor's own geometry/collision can take over. Stays `active` (the outdoor sky is kept) and
   * is fully reversible via resume(). Offline-only; never touched while online.
   */
  suspend(): void {
    if (!this.active) return;
    this.suspended = true;
    this.root.setEnabled(false);
    this.geometry?.setEnabled(false);
    this.courseRun?.reset('leave');
    this.courseHud?.setVisible(false);
    this.movers.resetPhase(); // platforms home while the editor owns the yard
    this.removeCollisionFromGym();
  }

  /** Resume the sandbox after the editor exits: re-show walls, re-add collision, respawn the player. */
  resume(player: PlayerController): void {
    if (!this.active) return;
    this.root.setEnabled(true);
    this.geometry?.setEnabled(true);
    this.suspended = false;
    this.pads.reset();
    this.movers.resetPhase();
    if (this.courseRun?.isTimed()) {
      this.courseHud?.renderLeaderboard(this.courseRun.localRecords());
      this.courseHud?.setVisible(true);
      this.courseHud?.showIdle(this.courseRun.bestMs());
    }
    for (const box of this.collisionBoxes) this.gym.collision.add(box);
    player.hands.clearHands();
    player.movement.setWorld(this);
    const spawn = layoutCourseSpawn(this.fullLayout);
    player.setRespawn(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw);
    player.teleportTo(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw, 0);
  }

  get lobbyReturn(): { position: Vector3; yaw: number } {
    return { position: new Vector3(2, 0, -8.2), yaw: Math.PI };
  }

  // ---------------------------------------------------------------------------------------------
  // Per-frame update (offline step only) — only the hold-E leave portal; pure free practice.
  // ---------------------------------------------------------------------------------------------

  /**
   * PRE-movement update, called by ArenaScene BEFORE player.update each frame while the yard is
   * active: moving platforms advance, carry their rider, and translate their colliders so this
   * frame's movement resolves against the new positions.
   */
  preMovementUpdate(dt: number, player: PlayerController): void {
    if (!this.active || this.suspended) return;
    this.movers.update(dt, player);
  }

  update(dt: number, player: PlayerController, input: InputManager, onAction: (action: SandboxAction) => void): void {
    if (!this.active) return;
    this.elapsed += dt;
    // Ability pads / kill blocks / checkpoint respawns — the SAME runtime creator Playtest runs,
    // called (like playtest) AFTER the player's movement update for this frame, so velocity written
    // by a pad carries into the next tick.
    const resetPressed = input.wasKeyPressed(CONTROL_KEYS.reset);
    if (resetPressed) this.pads.reset(); // K teleports; never sweep that discontinuity through pads.
    const killed = this.pads.update(dt, this.fullLayout, player);

    // Timed course run: start/checkpoint/finish gate crossings + live clock. A kill-block death or
    // the K reset cancels a live attempt (the checkpoint respawn itself is unchanged).
    const run = this.courseRun;
    if (run?.isTimed()) {
      if (resetPressed) run.reset('reset');
      const p = player.root.position;
      run.update(performance.now(), p.x, p.y, p.z, TUNING.player.radius, killed);
      if (run.state.phase === 'running') {
        this.courseHud?.tick(run.state.elapsedMs(performance.now()), run.state.nextCheckpoint, run.state.checkpointCount);
      } else if (run.state.phase === 'finished') {
        this.courseHud?.showFinished(run.state.finishedTimeMs ?? 0, run.bestMs());
      } else {
        this.courseHud?.showIdle(run.bestMs());
      }
    }

    const p = player.root.position;
    const held = input.isKeyDown(CONTROL_KEYS.interact);

    // Leave portal (hold E).
    const leave = this.leavePoint;
    const ldx = p.x - leave.x;
    const ldz = p.z - leave.z;
    const nearLeave = ldx * ldx + ldz * ldz <= leave.radius * leave.radius;
    let leaveFired = false;
    if (!nearLeave || !held) {
      this.leaveHold = 0;
      this.leaveLatched = false;
    } else if (!this.leaveLatched) {
      this.leaveHold = Math.min(leave.holdSeconds, this.leaveHold + dt);
      if (this.leaveHold >= leave.holdSeconds) {
        this.leaveLatched = true;
        leaveFired = true;
      }
    }
    this.leavePortalArch?.update(this.elapsed, nearLeave ? 1 : 0, this.leaveHold / leave.holdSeconds);
    if (leaveFired) {
      onAction('leave');
      // Leaving the yard tears the sandbox down; never also fire the RACE hold on the same frame
      // (a creator can place the leave portal within the RACE sign's radius, overlapping them).
      return;
    }

    // RACE ONLINE sign (hold E) — same interaction as the leave portal.
    const race = this.racePoint;
    const rdx = p.x - race.x;
    const rdz = p.z - race.z;
    const nearRace = rdx * rdx + rdz * rdz <= race.radius * race.radius;
    if (!nearRace || !held) {
      this.raceHold = 0;
      this.raceLatched = false;
    } else if (!this.raceLatched) {
      this.raceHold = Math.min(race.holdSeconds, this.raceHold + dt);
      if (this.raceHold >= race.holdSeconds) {
        this.raceLatched = true;
        onAction('race');
      }
    }
    this.racePortalArch?.update(this.elapsed, nearRace ? 1 : 0, this.raceHold / race.holdSeconds);

    // CO-OP BUILD portal (hold E) — opens the editor straight into the co-op create/join overlay.
    const coop = this.coopPoint;
    const cdx = p.x - coop.x;
    const cdz = p.z - coop.z;
    const nearCoop = cdx * cdx + cdz * cdz <= coop.radius * coop.radius;
    let coopFired = false;
    if (!nearCoop || !held) {
      this.coopHold = 0;
      this.coopLatched = false;
    } else if (!this.coopLatched) {
      this.coopHold = Math.min(coop.holdSeconds, this.coopHold + dt);
      if (this.coopHold >= coop.holdSeconds) {
        this.coopLatched = true;
        coopFired = true;
      }
    }
    this.coopPortalArch?.update(this.elapsed, nearCoop ? 1 : 0, this.coopHold / coop.holdSeconds);
    if (coopFired) {
      // Entering the co-op editor suspends the yard; nothing else should run for this frame.
      onAction('coop');
      return;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Sky / fog (outdoor look; restored on exit)
  // ---------------------------------------------------------------------------------------------

  private applyOutdoorSky(): void {
    this.savedClearColor = this.scene.clearColor.clone();
    this.savedFog = {
      mode: this.scene.fogMode,
      color: this.scene.fogColor.clone(),
      start: this.scene.fogStart,
      end: this.scene.fogEnd,
      density: this.scene.fogDensity
    };
    const style = competitiveSandboxSkyStyle(this.fullLayout.sky ?? 'clear');
    const sky = new Color3(style.horizon[0], style.horizon[1], style.horizon[2]);
    this.scene.clearColor = new Color4(sky.r, sky.g, sky.b, 1);
    // Light linear distance fog gives the open yard depth and (with the 22 m perimeter walls) keeps
    // the faraway gym out of sight, while leaving the ~330 m playable area clearly readable.
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogColor = sky;
    this.scene.fogStart = style.fogStart;
    this.scene.fogEnd = style.fogEnd;
  }

  private restoreSky(): void {
    if (this.savedClearColor) this.scene.clearColor = this.savedClearColor;
    if (this.savedFog) {
      this.scene.fogMode = this.savedFog.mode;
      this.scene.fogColor = this.savedFog.color;
      this.scene.fogStart = this.savedFog.start;
      this.scene.fogEnd = this.savedFog.end;
      this.scene.fogDensity = this.savedFog.density;
    }
    this.savedClearColor = null;
    this.savedFog = null;
  }

  private removeCollisionFromGym(): void {
    const boxes = this.gym.collision.boxes;
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      if (boxes[i].id?.startsWith(COLLISION_ID_PREFIX)) boxes.splice(i, 1);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Geometry (built once, lazily, on first entry)
  // ---------------------------------------------------------------------------------------------

  private build(): void {
    if (this.built) return;
    this.createMaterials();
    this.buildGround();
    this.buildBoundary();
    this.buildCourseGeometry();
    this.buildSpawn();

    this.collisionBoxes.push(...buildCreatorCollisionBoxes(this.courseLayout, COLLISION_ID_PREFIX));
    this.wallRunFaces = buildCreatorWallFaces(this.courseLayout);
    this.wallBounceFaces = buildCreatorWallBounceFaces(this.courseLayout);
    // Bind moving platforms to the built colliders + visuals (same runtime as creator playtest).
    this.movers.build(this.courseLayout, this.collisionBoxes, this.geometry, COLLISION_ID_PREFIX);

    for (const child of this.root.getChildMeshes(false)) {
      if (child instanceof Mesh) {
        child.isPickable = false;
        child.freezeWorldMatrix();
      }
    }
    this.built = true;
  }

  /**
   * Render the course through the Creator editor's own renderer so a published course looks exactly
   * like its playtest: solids with their real textures, ability pads, kill-block hazard volumes,
   * gates, signs, arrows, and labels. Every editor-only aid is off: overlays (trigger wireframes,
   * collision debug, ghosted invisible objects, pick proxies) via setOverlaysEnabled(false), and the
   * editor's grid floor via setGridVisible(false) — the yard draws its own ground. Enabled/disabled
   * with the yard in enter/exit/suspend/resume; starts disabled like the root.
   */
  private buildCourseGeometry(): void {
    this.geometry = new CreatorGeometry(this.scene);
    this.geometry.rebuild(this.visualLayout);
    this.geometry.setOverlaysEnabled(false);
    this.geometry.setGridVisible(false);
    this.geometry.setTriggersVisible(false);
    this.geometry.setCollisionVisible(false);
    this.geometry.setEnabled(false);
  }

  private deckMat!: StandardMaterial;
  private accentMat!: StandardMaterial;
  private boundaryMat!: StandardMaterial;

  private createMaterials(): void {
    this.deckMat = this.gridMaterial('sandbox_ground', new Color3(0.40, 0.43, 0.47));
    this.accentMat = this.gridMaterial('sandbox_accent', new Color3(0.10, 0.40, 0.52));
    this.boundaryMat = this.gridMaterial('sandbox_boundary', new Color3(0.30, 0.33, 0.38));
  }

  private buildGround(): void {
    const width = this.maxX - this.minX;
    const depth = this.maxZ - this.minZ;
    this.gridBox(
      'sandbox_ground',
      SANDBOX_CENTER.x, this.floorY - 0.5, SANDBOX_CENTER.z,
      width + BOUNDARY_THICKNESS * 2, 1, depth + BOUNDARY_THICKNESS * 2,
      this.deckMat
    );
  }

  private buildBoundary(): void {
    const b = { minX: this.minX, maxX: this.maxX, minZ: this.minZ, maxZ: this.maxZ };
    const h = BOUNDARY_HEIGHT;
    const t = BOUNDARY_THICKNESS;
    const fullX = b.maxX - b.minX + t * 2;
    const fullZ = b.maxZ - b.minZ;
    // Visual-only perimeter (the controller's bounds clamp is the real barrier). Inner faces are
    // wall-run surfaces (see buildWallRunFaces).
    const walls: Array<[string, number, number, number, number]> = [
      ['bnd_w', b.minX - t / 2, SANDBOX_CENTER.z, t, fullZ],
      ['bnd_e', b.maxX + t / 2, SANDBOX_CENTER.z, t, fullZ],
      ['bnd_s', SANDBOX_CENTER.x, b.minZ - t / 2, fullX, t],
      ['bnd_n', SANDBOX_CENTER.x, b.maxZ + t / 2, fullX, t]
    ];
    for (const [name, cx, cz, w, d] of walls) {
      this.gridBox(name, cx, this.floorY + h / 2, cz, w, h, d, this.boundaryMat);
    }
  }

  private buildSpawn(): void {
    const spawn = layoutCourseSpawn(this.fullLayout);

    // Spawn pad + title sign.
    this.gridBox('sandbox_spawn_pad', spawn.x, spawn.y + 0.04, spawn.z, 6, 0.08, 6, this.accentMat);
    this.sign('sandbox_title', 'MOVEMENT SANDBOX', new Vector3(spawn.x + 1.5, spawn.y + 2.4, spawn.z), 4.0, 0.9);
    this.sign('sandbox_sub', 'FREE MOVEMENT PRACTICE', new Vector3(spawn.x + 1.5, spawn.y + 1.5, spawn.z), 3.6, 0.6);

    // Back to Lobby portal (hold E) — same visual language as the practice-lobby mode portals
    // (see PortalArch), tinted green. Parented to this.root so it enables/disables with the yard.
    const leave = this.leavePoint;
    this.leavePortalArch = new PortalArch({
      id: 'sandbox_leave',
      scene: this.scene,
      position: new Vector3(leave.x, this.floorY, leave.z),
      yaw: leave.yaw,
      title: 'BACK TO LOBBY',
      palette: BACK_TO_LOBBY_PALETTE
    });
    this.leavePortalArch.root.parent = this.root;

    // Race Online portal (hold E) — private ghost races on this course with friends, tinted orange.
    const race = this.racePoint;
    this.racePortalArch = new PortalArch({
      id: 'sandbox_race',
      scene: this.scene,
      position: new Vector3(race.x, this.floorY, race.z),
      yaw: race.yaw,
      title: 'RACE ONLINE',
      palette: RACE_ONLINE_PALETTE
    });
    this.racePortalArch.root.parent = this.root;

    // Co-op Build portal (hold E) — jumps straight into the collaborative editor's create/join overlay.
    const coop = this.coopPoint;
    this.coopPortalArch = new PortalArch({
      id: 'sandbox_coop',
      scene: this.scene,
      position: new Vector3(coop.x, this.floorY, coop.z),
      yaw: coop.yaw,
      title: 'CO-OP BUILD',
      palette: CO_OP_PALETTE
    });
    this.coopPortalArch.root.parent = this.root;
  }

  // --- helpers ---------------------------------------------------------------------------------

  /** A material whose surface colour is a tileable grid texture (cells = base, lines = lighter base). */
  private gridMaterial(name: string, base: Color3): StandardMaterial {
    const m = new StandardMaterial(name, this.scene);
    m.diffuseTexture = this.gridTexture(`${name}_grid`, base);
    m.diffuseColor = new Color3(1, 1, 1); // colour comes from the texture
    m.emissiveColor = base.scale(0.06);   // small lift so shadowed faces aren't pure black
    m.specularColor = new Color3(0.04, 0.04, 0.045);
    this.materials.push(m);
    return m;
  }

  /**
   * Procedural tileable grid: cell interior filled with `base`, with one line along the top + left
   * edges in a lighter shade. Tiling (via per-box world-scale UVs in gridBox) makes those edge lines
   * meet across cells into continuous large grid lines.
   */
  private gridTexture(name: string, base: Color3): DynamicTexture {
    const size = 256;
    const lineW = 6;
    const tex = new DynamicTexture(name, { width: size, height: size }, this.scene, true);
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    const lighten = (c: number) => Math.min(1, c + 0.26);
    const line = new Color3(lighten(base.r), lighten(base.g), lighten(base.b));
    ctx.fillStyle = toCss(base);
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = toCss(line);
    ctx.fillRect(0, 0, size, lineW); // top edge
    ctx.fillRect(0, 0, lineW, size); // left edge
    tex.update(true);
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    this.disposables.push(tex);
    return tex;
  }

  /** Box whose grid texture tiles at a consistent ~GRID_CELL_METRES world size on every face. */
  private gridBox(name: string, cx: number, cy: number, cz: number, w: number, h: number, d: number, material: StandardMaterial): Mesh {
    const c = GRID_CELL_METRES;
    const uv = (a: number, b: number) => new Vector4(0, 0, Math.max(1, a / c), Math.max(1, b / c));
    // Box face order: front, back, right, left, top, bottom. front/back = w×h, right/left = d×h, top/bottom = w×d.
    const faceUV = [uv(w, h), uv(w, h), uv(d, h), uv(d, h), uv(w, d), uv(w, d)];
    const mesh = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d, wrap: true, faceUV }, this.scene);
    mesh.position.set(cx, cy, cz);
    mesh.material = material;
    mesh.parent = this.root;
    // The enormous ground only receives; every raised yard block/wall both casts and receives.
    registerSandboxShadowGeometry(mesh, name !== 'sandbox_ground');
    return mesh;
  }

  private sign(name: string, text: string, position: Vector3, width: number, height: number): Mesh {
    const tex = new DynamicTexture(`${name}_tex`, { width: 512, height: 256 }, this.scene, true);
    tex.hasAlpha = true;
    const ctx = tex.getContext() as CanvasRenderingContext2D;
    ctx.clearRect(0, 0, 512, 256);
    ctx.fillStyle = 'rgba(12, 20, 42, 0.86)';
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
    const fontSize = lines.length > 1 ? 54 : 64;
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
    // Double-sided geometry supplies a real back face, so cull each face's back (front would
    // otherwise bleed through and z-fight the mirror-corrected back).
    mat.backFaceCulling = true;
    mat.transparencyMode = Material.MATERIAL_ALPHABLEND;

    // DOUBLESIDE + horizontally-flipped backUVs so the sign reads correctly from BOTH sides instead
    // of showing mirrored text (e.g. "MOVEMENT SANDBOX") when viewed from behind.
    const mesh = MeshBuilder.CreatePlane(name, {
      width,
      height,
      sideOrientation: Mesh.DOUBLESIDE,
      frontUVs: new Vector4(0, 0, 1, 1),
      backUVs: new Vector4(1, 0, 0, 1)
    }, this.scene);
    mesh.position.copyFrom(position);
    mesh.material = mat;
    mesh.parent = this.root;
    this.disposables.push(tex, mat);
    return mesh;
  }
}

function toCss(c: Color3): string {
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${ch(c.r)}, ${ch(c.g)}, ${ch(c.b)})`;
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
