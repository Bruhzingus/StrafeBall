/**
 * Creator Sandbox — editor orchestrator.
 *
 * Owns the whole player-facing course editor: project selection, layout state + history, geometry,
 * the offline movement world + collision used in Playtest, the free-fly Build camera, the editor
 * input handling, Babylon gizmos, and the DOM UI. It is strictly offline/practice-only and fully
 * self-contained: ArenaScene only routes entry, the per-frame step, and the online lockout.
 *
 * Lifecycle:
 *   idle  → (hold E at the entry sign) → active in BUILD mode
 *   BUILD  ↔ PLAYTEST  (free toggle within a session)
 *   exit / going online  → torn down, sandbox restored
 */

import {
  Color3,
  FreeCamera,
  GizmoManager,
  Matrix,
  Mesh,
  MeshBuilder,
  Scene,
  StandardMaterial,
  TransformNode,
  Vector3
} from '@babylonjs/core';
import { GymArena } from '../../map/GymArena';
import { PlayerController } from '../../player/PlayerController';
import { InputManager } from '../../input/InputManager';
import { AABB } from '../../map/Collider';
import { sandboxSpawnWorld } from '../MovementSandboxLayout';
import {
  COURSE_DIFFICULTIES,
  CREATOR_LIMITS,
  CREATOR_MODULES,
  type CourseDifficulty,
  CreatorLayout,
  CreatorLayoutObject,
  CreatorObjectMetadata,
  type CreatorPrefab,
  type CreatorSpawnerMarkers,
  MAX_PREFABS,
  blankCourseLayout,
  cloneLayout,
  collectSpawnerMarkers,
  committedCourseLayout,
  createObjectId,
  enforceSingleDefaultSpawn,
  instantiatePrefab,
  isLayoutValid,
  layoutSpawn,
  makePrefabFromObjects,
  moduleDef,
  objectDimensions,
  objectOpacity,
  objectWorldAabb,
  objectsGroupOrigin,
  prefabWorldBounds,
  rotateObjectsAroundCenterYaw,
  scaleForDimensions,
  setExclusiveDefaultSpawn,
  textureDef,
  type Vec3Tuple
} from './CreatorLayout';
import { CreatorWorld, buildCreatorCollisionBoxes } from './CreatorWorld';
import { CreatorPads } from './CreatorPads';
import { CreatorMovers } from './CreatorMovers';
import { CourseRunTracker } from './CourseRun';
import { CourseRunHud } from './CourseRunHud';
import { TUNING } from '../../config/tuning';
import { CONTROL_KEYS } from '../../config/controls';
import { CreatorReplay } from './CreatorReplay';
import { CreatorGeometry } from './CreatorGeometry';
import { CreatorHistory } from './CreatorHistory';
import { CreatorBridge, CreatorSnapSettings, CreatorUI } from './CreatorUI';
import {
  type ProjectSummary,
  createProject,
  deleteProject,
  duplicateProject,
  exportLayoutToFile,
  hasSeenOnboarding,
  importLayoutFromFile,
  loadPrefabLibrary,
  loadProjectManual,
  loadProjectWorking,
  loadProjectsIndex,
  markOnboardingSeen,
  renameProject,
  savePrefabLibrary,
  saveProjectAutosave,
  saveProjectManual,
  setActiveProject
} from './CreatorStorage';

const COLLISION_ID_PREFIX = 'creator_';
const FLY_BASE_SPEED = 20;
const FLY_SPRINT = 3;
const LOOK_SENSITIVITY = 0.0024;
const PITCH_LIMIT = 1.52;
// Autosave cadence: settle shortly after the last edit, but never let a long burst of continuous
// editing go more than the max interval without a write. Timers only ever start on an edit.
const AUTOSAVE_DEBOUNCE_MS = 1500;
const AUTOSAVE_MAX_INTERVAL_MS = 10000;

export const CREATOR_ENTRY_RADIUS = 2.7;
export const CREATOR_ENTRY_HOLD_SECONDS = 0.6;

export interface CreatorEditorHooks {
  /** True while connected/playing online — the editor must never activate or stay active then. */
  isOnline(): boolean;
  /** Hide the sandbox's static walls + remove its collision (creator takes over). */
  suspendSandbox(): void;
  /** Restore the sandbox visuals + collision + movement world + spawn the player back in. */
  resumeSandbox(): void;
  /** Hide/show the gameplay HUD (scoreboard, hands, crosshair, music…) while the editor is up. */
  setHudVisible(visible: boolean): void;
  /**
   * Dock the game's floating settings panel into the given container (editor active) or return it
   * to its floating top-right home (null) — the two settings surfaces otherwise overlap there.
   */
  setGameSettingsDock(host: HTMLElement | null): void;
  /** Entering Playtest: spawn the layout's functional ball/bot/dummy actors (offline only). */
  onPlaytestStart(markers: CreatorSpawnerMarkers): void;
  /** Leaving Playtest (to Build, exit, or online): despawn those actors. */
  onPlaytestEnd(): void;
}

// Re-exported for existing importers (ArenaScene); the type + collector now live in CreatorLayout so
// the live Movement Sandbox can use them without importing the whole editor.
export type { CreatorSpawnerMarkers } from './CreatorLayout';

type Mode = 'build' | 'playtest';

export class CreatorEditor implements CreatorBridge {
  private active = false;
  private mode: Mode = 'build';

  private layout: CreatorLayout;
  /** The active course project this editor session reads/writes (see CreatorStorage projects). */
  private projectId: string;
  private readonly history: CreatorHistory;
  private readonly geometry: CreatorGeometry;
  private readonly world: CreatorWorld;
  private readonly pads = new CreatorPads();
  /** Moving-platform runtime (Playtest only; Build shows the static piece + its path preview). */
  private readonly movers = new CreatorMovers();
  // Timed course run for Playtest (start → checkpoints → finish). Rebuilt on each playtest entry so
  // it always tracks the CURRENT edited layout; inert unless the layout has both gates.
  private courseRun: CourseRunTracker | null = null;
  private courseHud: CourseRunHud | null = null;
  private readonly replay: CreatorReplay;
  private readonly ui: CreatorUI;

  private editorCamera: FreeCamera | null = null;
  private gizmoManager: GizmoManager | null = null;
  private creatorCollisionBoxes: AABB[] = [];
  private worldInstalled = false;

  private selectedId: string | null = null;
  /** Full multi-selection (always contains selectedId when non-null). selectedId stays the PRIMARY
   *  selection: the inspector target and the gizmo anchor. */
  private readonly selectedIds = new Set<string>();
  /** Clipboard is a GROUP: single-copy is just a group of one. Positions stay absolute; paste keeps
   *  the group's internal offsets around its shared center. */
  private clipboard: CreatorLayoutObject[] | null = null;
  private armedModule: string | null = null;
  // --- Prefab library (saved multi-object assemblies; stamped from the hotbar) ---
  private prefabs: CreatorPrefab[] = loadPrefabLibrary();
  private armedPrefab: CreatorPrefab | null = null;
  private prefabGhost: Mesh | null = null;
  // --- Marquee (drag-rectangle) selection: Select tool + no armed module ---
  private marqueeActive = false;
  private marqueeMoved = false;
  private marqueeStartX = 0;
  private marqueeStartY = 0;
  private marqueeEl: HTMLDivElement | null = null;
  private marqueeAdditive = false;
  // Gizmo group-drag baseline: the primary object's transform when the drag began, so the same
  // delta can be applied to every other selected object on commit.
  private gizmoStart: { pos: Vec3Tuple; yawDeg: number } | null = null;
  private placementPreview: CreatorLayoutObject | null = null;
  private previewPointerX: number | null = null;
  private previewPointerY: number | null = null;
  private previewRotationYDeg = 0;
  private previewYOffset = 0;
  private previewScale: Vec3Tuple = [1, 1, 1];

  private readonly snap: CreatorSnapSettings = {
    gridSnap: true,
    gridSize: 1,
    rotationSnapDeg: 15,
    scaleSnap: 0.25,
    showGrid: true,
    showTriggers: true,
    showCollision: false,
    showReplay: true,
    gizmo: 'move'
  };

  // Build-mode fly camera state.
  private readonly flyKeys = new Set<string>();
  private camYaw = 0;
  private camPitch = 0.45;

  // Free-fly noclip toggled DURING playtest (= key / quick toolbar) — reuses the build fly camera.
  private playtestFly = false;
  private flyListenersActive = false;

  // Pointer/gizmo interaction state.
  private looking = false;
  private lookMoved = 0;
  private gizmoDragging = false;
  private ignoreClickUntilMs = 0;
  // Center-handle free drag: grab the sphere at the move-gizmo origin and carry the object with the
  // mouse; the wheel pushes/pulls it along the view ray. Distinct from Babylon's axis-arrow drags.
  private centerDragging = false;
  private centerDragMoved = false;
  private centerDragDistance = 0;
  private centerDragOrigin: Vec3Tuple | null = null;
  // While the cursor is inside the grab sphere the axis arrows are disabled (the sphere wins).
  private gizmoArrowsLocked = false;
  // While Ctrl/Shift are being used as a CHORD (Ctrl+scroll height, Ctrl+S save, Shift+wheel rotate…)
  // we briefly stop them from also driving the fly camera (down / sprint), so keybinds don't overlap.
  private chordSuppressUntilMs = 0;

  // Entry sign (3D prop near the sandbox spawn while the editor is not active).
  private entrySign: TransformNode | null = null;
  private entrySignMaterials: StandardMaterial[] = [];
  private entrySignBuilt = false;

  // Bound listeners (added in build mode only).
  private readonly onKeyDown = (e: KeyboardEvent) => this.handleKeyDown(e);
  private readonly onKeyUp = (e: KeyboardEvent) => this.handleKeyUp(e);
  private readonly onPointerDown = (e: PointerEvent) => this.handlePointerDown(e);
  private readonly onPointerUp = (e: PointerEvent) => this.handlePointerUp(e);
  private readonly onPointerMove = (e: PointerEvent) => this.handlePointerMove(e);
  private readonly onWheel = (e: WheelEvent) => this.handleWheel(e);
  private readonly onBlur = () => {
    this.flyKeys.clear();
    this.looking = false;
    this.setCanvasCursor('');
  };
  private listenersActive = false;

  // Lean listeners used ONLY for the playtest free-fly (movement + RMB look; no tools/placement).
  private readonly onFlyKeyDown = (e: KeyboardEvent) => {
    if (isEditableTarget(e.target)) return;
    // Fly-exit / mode keys MUST be handled here: while flying, input is suppressed (RMB-look needs no
    // pointer lock), and the suppressed InputManager drops every keydown — so ArenaScene.stepCreator
    // never sees `=` / B / F1 / Esc and you'd be stuck in fly (the reported "can't press = to unfly").
    if (e.code === 'Equal' || e.code === 'NumpadAdd') {
      e.preventDefault();
      this.togglePlaytestFly();
      return;
    }
    if (e.code === 'KeyB' || e.code === 'F1' || e.code === 'Escape') {
      e.preventDefault();
      this.setMode('build');
      return;
    }
    if (!FLY_CODES.has(e.code)) return;
    const isFlyModifier = e.code === 'ShiftLeft' || e.code === 'ControlLeft' || e.code === 'ControlRight';
    if (isFlyModifier || (!e.ctrlKey && !e.altKey && !e.metaKey)) {
      this.flyKeys.add(e.code);
      e.preventDefault();
    }
  };
  private readonly onFlyKeyUp = (e: KeyboardEvent) => this.flyKeys.delete(e.code);
  private readonly onFlyPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button === 2) {
      this.looking = true;
      e.preventDefault();
      this.setCanvasCursor('none');
    }
  };
  private readonly onFlyPointerMove = (e: PointerEvent) => {
    if (!this.looking) return;
    this.camYaw += (e.movementX || 0) * LOOK_SENSITIVITY;
    this.camPitch += (e.movementY || 0) * LOOK_SENSITIVITY;
    this.camPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.camPitch));
    this.applyCameraRotation();
  };
  private readonly onFlyPointerUp = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && e.button === 2 && this.looking) {
      this.looking = false;
      this.setCanvasCursor('');
    }
  };

  // --- Autosave (debounced) + crash/close recovery ---
  private autosaveTimer: number | null = null;
  private autosavePending = false;
  private autosaveFirstPendingMs = 0;
  private autosaveFailureNotified = false;
  private readonly onBeforeUnload = () => this.flushAutosave();
  private readonly onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.flushAutosave();
  };

  constructor(
    private readonly scene: Scene,
    private readonly gym: GymArena,
    private readonly player: PlayerController,
    private readonly input: InputManager,
    private readonly hooks: CreatorEditorHooks
  ) {
    // Open on the active project's most recent state — the autosave IS the working copy, so the
    // newest of (autosave, explicit quick-save) always wins. loadProjectsIndex() migrates any legacy
    // single-layout save into the first project and seeds the starter course on a fresh install, so
    // there is always a valid active project. Going back to an older state is manual-only: Load
    // (last explicit save), Load Course (published), or Revert to Default Map (committed).
    const index = loadProjectsIndex();
    this.projectId = index.activeId;
    this.layout = loadProjectWorking(this.projectId) ?? committedCourseLayout();
    this.history = new CreatorHistory(this.layout);
    this.geometry = new CreatorGeometry(scene);
    this.geometry.setEnabled(false);
    this.replay = new CreatorReplay(scene);
    this.world = new CreatorWorld(this.layout);
    const hud = document.getElementById('hud-root');
    this.ui = new CreatorUI(hud ?? document.body, this);
    // Flush any pending debounced autosave when the tab closes or hides. Registered for the editor's
    // whole lifetime (they no-op when nothing is pending) and removed in dispose().
    window.addEventListener('beforeunload', this.onBeforeUnload);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  // ---------------------------------------------------------------------------------------------
  // Public API used by ArenaScene
  // ---------------------------------------------------------------------------------------------

  isActive(): boolean {
    return this.active;
  }

  /** True while the creator owns the screen + input (an active editor session). */
  isBusy(): boolean {
    return this.active;
  }

  getModePublic(): Mode {
    return this.mode;
  }

  entryWorldPoint(): { x: number; z: number } {
    const spawn = sandboxSpawnWorld();
    return { x: spawn.x + 3, z: spawn.z - 4 };
  }

  setEntrySignVisible(visible: boolean): void {
    if (visible && !this.entrySignBuilt) this.buildEntrySign();
    this.entrySign?.setEnabled(visible && !this.active);
  }

  /** Drive the on-screen "hold E" entry prompt (ArenaScene supplies proximity + hold progress). */
  showEntryPrompt(near: boolean, progress: number): void {
    if (this.active) {
      this.ui.setEntryPromptVisible(false, 0);
      return;
    }
    this.ui.setEntryPromptVisible(near, progress);
  }

  /** Open the editor (called on a completed hold-E at the entry sign). Open to every player. */
  requestEntry(): void {
    if (this.active || this.hooks.isOnline()) return;
    this.enter();
  }

  /** Per-frame update while active. Build: fly camera. Playtest: handled by ArenaScene (player). */
  /**
   * PRE-movement update, called by ArenaScene BEFORE player.update each playtest frame: moving
   * platforms advance, carry their rider, and translate their colliders so this frame's movement
   * resolves against the new positions. In free-fly the platforms keep animating (null rider).
   */
  preMovementUpdate(dt: number): void {
    if (!this.active || this.mode !== 'playtest') return;
    this.movers.update(dt, this.playtestFly ? null : this.player);
  }

  step(dt: number): void {
    if (!this.active) return;
    if (this.mode === 'build') {
      this.updateFlyCamera(dt);
      this.updatePlacementPreviewFromPointer();
      // Carried object follows the view even when only the CAMERA moves (WASD fly mid-drag).
      if (this.centerDragging) this.updateCenterDrag();
      this.syncCenterHandle();
      this.updateGizmoArrowLock();
      // Loop the last-attempt ghost along its recorded path.
      this.replay.update(dt);
    } else if (this.playtestFly) {
      this.updateFlyCamera(dt);
    } else {
      // Playtest, first-person: apply ability-pad effects after the movement step ran this frame.
      const killed = this.pads.update(dt, this.layout, this.player);
      // Timed course run (same controller the live yard uses): gate crossings + live clock; a
      // kill-block death or the K reset cancels a live attempt.
      const run = this.courseRun;
      if (run?.isTimed()) {
        if (this.input.wasKeyPressed(CONTROL_KEYS.reset)) run.reset('reset');
        const p = this.player.root.position;
        run.update(performance.now(), p.x, p.y, p.z, TUNING.player.radius, killed);
        if (run.state.phase === 'running') {
          this.courseHud?.tick(run.state.elapsedMs(performance.now()), run.state.nextCheckpoint, run.state.checkpointCount);
        } else {
          this.courseHud?.showIdle(run.bestMs());
        }
      }
      // 7 toggles run recording; while armed, sample the player's pose each frame for the editor replay.
      if (this.input.wasKeyPressed('Digit7') || this.input.wasKeyPressed('Numpad7')) {
        this.replay.toggleRecording(this.player.root.position, this.player.root.rotation.y);
      }
      if (this.replay.isRecording()) this.replay.record(this.player.root.position, this.player.root.rotation.y);
      this.ui.setRecordingTimer(this.replay.recordingSeconds());
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Playtest free-fly (= key / quick toolbar) — fly around the course mid-test without leaving it.
  // ---------------------------------------------------------------------------------------------

  isPlaytestFlying(): boolean {
    return this.active && this.mode === 'playtest' && this.playtestFly;
  }

  togglePlaytestFly(): void {
    if (!this.active || this.mode !== 'playtest') return;
    if (this.playtestFly) this.disablePlaytestFly(true);
    else this.enablePlaytestFly();
  }

  private enablePlaytestFly(): void {
    if (this.playtestFly) return;
    this.playtestFly = true;
    this.ensureEditorCamera();
    const eye = this.player.camera.globalPosition;
    this.editorCamera!.position.set(eye.x, eye.y, eye.z);
    this.camYaw = this.player.root.rotation.y;
    this.camPitch = 0.1;
    this.applyCameraRotation();
    this.scene.activeCamera = this.editorCamera;
    this.input.setLockSuppressed(true); // RMB-look is manual; keep the game from grabbing pointer lock
    this.addFlyListeners();
    this.ui.refresh();
    this.ui.toast('Fly mode — = to land here, B for Build');
  }

  private disablePlaytestFly(returnPlayer: boolean): void {
    if (!this.playtestFly) return;
    this.playtestFly = false;
    this.removeFlyListeners();
    this.flyKeys.clear();
    this.looking = false;
    this.setCanvasCursor('');
    if (returnPlayer && this.editorCamera && this.mode === 'playtest') {
      const c = this.editorCamera.position;
      const groundY = this.layout.ground.bounds.y ?? 0;
      this.player.teleportTo(new Vector3(c.x, Math.max(groundY, c.y - 1.6), c.z), this.camYaw, 0);
      this.scene.activeCamera = this.player.camera;
      this.input.setLockSuppressed(false);
    }
    this.ui.refresh();
  }

  private addFlyListeners(): void {
    if (this.flyListenersActive) return;
    this.flyListenersActive = true;
    const canvas = this.canvas();
    window.addEventListener('keydown', this.onFlyKeyDown);
    window.addEventListener('keyup', this.onFlyKeyUp);
    window.addEventListener('blur', this.onBlur);
    canvas?.addEventListener('pointerdown', this.onFlyPointerDown);
    window.addEventListener('pointerup', this.onFlyPointerUp);
    window.addEventListener('pointermove', this.onFlyPointerMove);
  }

  private removeFlyListeners(): void {
    if (!this.flyListenersActive) return;
    this.flyListenersActive = false;
    const canvas = this.canvas();
    window.removeEventListener('keydown', this.onFlyKeyDown);
    window.removeEventListener('keyup', this.onFlyKeyUp);
    window.removeEventListener('blur', this.onBlur);
    canvas?.removeEventListener('pointerdown', this.onFlyPointerDown);
    window.removeEventListener('pointerup', this.onFlyPointerUp);
    window.removeEventListener('pointermove', this.onFlyPointerMove);
  }

  /** Hard shutdown for going online: tears down with no sandbox restore (the online path handles it). */
  forceDeactivate(): void {
    if (!this.active) return;
    this.teardownActive(false);
  }

  dispose(): void {
    this.flushAutosave();
    // Rescue the docked settings panel before the creator UI (its host) is torn down. No-op when
    // not docked or when the panel itself was already disposed.
    this.hooks.setGameSettingsDock(null);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.courseHud?.dispose();
    this.prefabGhost?.dispose();
    this.marqueeEl?.remove();
    this.removeListeners();
    this.gizmoManager?.dispose();
    this.gizmoManager = null;
    this.geometry.dispose();
    this.replay.dispose();
    this.editorCamera?.dispose();
    this.editorCamera = null;
    for (const m of this.entrySignMaterials) m.dispose();
    this.entrySign?.dispose();
    this.ui.dispose();
  }

  // ---------------------------------------------------------------------------------------------
  // Activation / mode transitions
  // ---------------------------------------------------------------------------------------------

  private enter(): void {
    if (this.active) return;
    this.active = true;
    this.mode = 'build';
    this.setEntrySignVisible(false);
    // ArenaScene's hold-E loop stops calling showEntryPrompt() once isActive() is true, so this is
    // the only place left to hide it — otherwise it freezes on screen at its last (visible) state.
    this.ui.setEntryPromptVisible(false, 0);
    this.hooks.suspendSandbox();
    this.hooks.setHudVisible(false);
    this.hooks.setGameSettingsDock(this.ui.gameSettingsSlot());

    this.geometry.setEnabled(true);
    this.geometry.rebuild(this.layout);
    this.geometry.setGridVisible(this.snap.showGrid);
    this.geometry.setTriggersVisible(this.snap.showTriggers);
    this.geometry.setCollisionVisible(this.snap.showCollision);

    this.ensureEditorCamera();
    this.positionEditorCameraAtSpawn();
    this.enterBuildMode();
    this.ui.setToolbarVisible(true);
    this.ui.toast('Course Creator — Build Mode');
    this.ui.refresh();
    // First visit ever (per browser): a one-time help card. Marked seen only when dismissed.
    if (!hasSeenOnboarding()) this.ui.showOnboarding(() => markOnboardingSeen());
  }

  setMode(mode: Mode): void {
    if (!this.active || mode === this.mode) return;
    if (mode === 'playtest') this.enterPlaytestMode();
    else this.enterBuildMode();
    this.ui.refresh();
  }

  getMode(): Mode {
    return this.mode;
  }

  private enterBuildMode(): void {
    this.disablePlaytestFly(false);
    // Leaving playtest → despawn its functional actors (no-op if none / already in build).
    this.hooks.onPlaytestEnd();
    this.courseRun?.reset('leave');
    this.courseHud?.setVisible(false);
    // Snap moving platforms back to their authored home positions for editing.
    this.movers.resetPhase();
    this.mode = 'build';
    this.uninstallWorldAndCollision();
    this.player.movement.setWorld(null);
    this.hooks.setHudVisible(false);
    this.input.setLockSuppressed(true);
    this.addListeners();
    this.ensureEditorCamera();
    this.scene.activeCamera = this.editorCamera;
    this.geometry.setOverlaysEnabled(true);
    this.applyGizmoMode();
    this.refreshSelectionVisual();
    this.updatePlacementPreviewFromPointer();
    // Show the last recorded run (ghost + dotted path) now we're back in Build; clear the REC HUD.
    this.replay.setEnabled(this.snap.showReplay);
    this.replay.onEnterBuild();
    this.ui.setRecordingTimer(null);
  }

  private enterPlaytestMode(): void {
    this.flushAutosave(); // leaving Build: persist pending edits before the run
    this.disablePlaytestFly(false);
    this.mode = 'playtest';
    this.removeListeners();
    this.detachGizmo();
    this.clearPlacementPreview();
    this.disarmPrefab();
    this.geometry.setOverlaysEnabled(false);
    // Replay is never shown while playing; recording starts when the user presses 7.
    this.replay.onEnterPlaytest();
    this.hooks.setHudVisible(true);
    // Install the editable layout's collision + movement world for real movement.
    this.installWorldAndCollision();
    this.scene.activeCamera = this.player.camera;
    this.input.setLockSuppressed(false);
    const spawn = layoutSpawn(this.layout);
    this.player.hands.clearHands();
    // Fresh run: refill stamina + clear ability-pad state so a playtest always starts from full,
    // regardless of what was spent in a previous playtest session.
    this.player.dash.refill();
    this.player.backflip.cooldown = 0;
    this.pads.reset();
    // Rebuild the timed-course tracker against the CURRENT layout (gates/edits since last playtest).
    this.courseHud ??= new CourseRunHud(document.getElementById('hud-root') ?? document.body, 'COURSE RUN');
    const hud = this.courseHud;
    this.courseRun = new CourseRunTracker(this.layout, {
      onRunStart: () => {
        // Deterministic routes: every attempt sees the platforms at their starting phase.
        this.movers.resetPhase();
        hud.tick(0, 0, this.courseRun?.state.checkpointCount ?? 0);
      },
      onCheckpoint: (collected, total, splitMs) => hud.showCheckpoint(collected, total, splitMs),
      onMissedCheckpoint: (n) => hud.showMissedCheckpoint(n),
      onFinish: (timeMs, bestMs, isPb) => hud.showFinish(timeMs, bestMs, isPb),
      onRunReset: (reason) => hud.showRunReset(reason)
    });
    if (this.courseRun.isTimed()) {
      hud.setVisible(true);
      hud.showIdle(this.courseRun.bestMs());
    } else {
      hud.setVisible(false);
    }
    this.player.setRespawn(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw);
    this.player.teleportTo(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw, 0);
    // Spawn the layout's functional ball/bot/dummy actors for this run (host owns their lifecycle).
    this.hooks.onPlaytestStart(this.collectSpawnerMarkers());
    this.ui.toast('Playtest Mode — F1 to return to Build');
  }

  exitCreator(): void {
    if (!this.active) return;
    this.teardownActive(true);
    this.ui.toast('Exited Course Creator');
  }

  private teardownActive(restoreSandbox: boolean): void {
    this.flushAutosave(); // exit/lock/going-online: never leave a pending write behind
    this.disablePlaytestFly(false);
    this.hooks.onPlaytestEnd(); // despawn any playtest actors before tearing down
    this.courseRun?.reset('leave');
    this.courseHud?.setVisible(false);
    this.movers.resetPhase(); // platforms home before the world tears down
    this.removeListeners();
    this.detachGizmo();
    this.uninstallWorldAndCollision();
    this.geometry.setOverlaysEnabled(false);
    this.geometry.setEnabled(false);
    this.replay.hide();
    this.ui.setRecordingTimer(null);
    this.clearPlacementPreview();
    this.disarmPrefab();
    this.marqueeActive = false;
    if (this.marqueeEl) this.marqueeEl.style.display = 'none';
    this.ui.setToolbarVisible(false);
    this.ui.setEntryPromptVisible(false, 0);
    this.flyKeys.clear();
    this.looking = false;
    if (document.pointerLockElement === this.canvas()) document.exitPointerLock?.();

    this.scene.activeCamera = this.player.camera;
    this.player.movement.setWorld(null);
    this.hooks.setHudVisible(true);
    this.hooks.setGameSettingsDock(null); // settings panel floats top-right again outside the editor
    this.active = false;
    this.mode = 'build';

    if (restoreSandbox && !this.hooks.isOnline()) {
      this.input.setLockSuppressed(false);
      this.hooks.resumeSandbox();
      // Back in the (non-creator) sandbox: the entry sign + hold-E prompt return.
      this.setEntrySignVisible(true);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Movement world + collision (Playtest only)
  // ---------------------------------------------------------------------------------------------

  private installWorldAndCollision(): void {
    this.uninstallWorldAndCollision();
    this.world.rebuild(this.layout);
    this.creatorCollisionBoxes = buildCreatorCollisionBoxes(this.layout, COLLISION_ID_PREFIX);
    for (const box of this.creatorCollisionBoxes) this.gym.collision.add(box);
    this.player.movement.setWorld(this.world);
    this.worldInstalled = true;
    // Bind the moving-platform runtime to the freshly built collider entries + visuals. Rebinding
    // here also covers mid-playtest edits (rebuildAfterChange reinstalls the world).
    this.movers.build(this.layout, this.creatorCollisionBoxes, this.geometry, COLLISION_ID_PREFIX);
    this.movers.resetPhase();
  }

  private uninstallWorldAndCollision(): void {
    if (!this.worldInstalled) return;
    const boxes = this.gym.collision.boxes;
    for (let i = boxes.length - 1; i >= 0; i -= 1) {
      if (boxes[i].id?.startsWith(COLLISION_ID_PREFIX)) boxes.splice(i, 1);
    }
    this.creatorCollisionBoxes = [];
    this.worldInstalled = false;
  }

  // ---------------------------------------------------------------------------------------------
  // Editor camera
  // ---------------------------------------------------------------------------------------------

  private ensureEditorCamera(): void {
    if (this.editorCamera) return;
    const cam = new FreeCamera('creator_editor_cam', new Vector3(0, 12, 0), this.scene);
    cam.minZ = 0.1;
    cam.maxZ = 40000; // generous far plane so very large pieces aren't clipped from view
    cam.fov = 1.1;
    this.editorCamera = cam;
  }

  private positionEditorCameraAtSpawn(): void {
    if (!this.editorCamera) return;
    const spawn = layoutSpawn(this.layout);
    this.editorCamera.position.set(spawn.x - 14, 14, spawn.z);
    this.camYaw = spawn.yaw;
    this.camPitch = 0.5;
    this.applyCameraRotation();
  }

  private applyCameraRotation(): void {
    if (!this.editorCamera) return;
    this.editorCamera.rotation.set(this.camPitch, this.camYaw, 0);
  }

  private updateFlyCamera(dt: number): void {
    const cam = this.editorCamera;
    if (!cam) return;
    // While Ctrl/Shift are being consumed as a chord (Ctrl+scroll height, Ctrl+S…), don't also let them
    // move the camera down / sprint — that was the "Ctrl+scroll sinks the player" overlap.
    const chordActive = performance.now() < this.chordSuppressUntilMs;
    const moveX = (this.flyKeys.has('KeyD') ? 1 : 0) - (this.flyKeys.has('KeyA') ? 1 : 0);
    const moveZ = (this.flyKeys.has('KeyW') ? 1 : 0) - (this.flyKeys.has('KeyS') ? 1 : 0);
    const downHeld = !chordActive && (this.flyKeys.has('ControlLeft') || this.flyKeys.has('ControlRight'));
    const moveY = (this.flyKeys.has('Space') ? 1 : 0) - (downHeld ? 1 : 0);
    const speed = FLY_BASE_SPEED * (this.flyKeys.has('ShiftLeft') && !chordActive ? FLY_SPRINT : 1);

    const sin = Math.sin(this.camYaw);
    const cos = Math.cos(this.camYaw);
    const cosPitch = Math.cos(this.camPitch);
    const fX = sin * cosPitch;
    const fZ = cos * cosPitch;
    const fY = -Math.sin(this.camPitch);
    const rX = cos;
    const rZ = -sin;

    const dirX = fX * moveZ + rX * moveX;
    const dirZ = fZ * moveZ + rZ * moveX;
    const dirY = fY * moveZ + moveY;
    const len = Math.hypot(dirX, dirY, dirZ);
    if (len > 1e-4) {
      const scale = (speed * dt) / len;
      cam.position.x += dirX * scale;
      cam.position.y += dirY * scale;
      cam.position.z += dirZ * scale;
    }
    // Generous fly range: builds can be huge (size limits are ~unlimited), so don't strand the camera
    // below a tall structure's top. Far plane is 40000, so 20000 up still renders everything.
    cam.position.y = Math.max(-1000, Math.min(20000, cam.position.y));
  }

  // ---------------------------------------------------------------------------------------------
  // Input listeners (Build mode only)
  // ---------------------------------------------------------------------------------------------

  private canvas(): HTMLCanvasElement | null {
    return this.scene.getEngine().getRenderingCanvas();
  }

  private addListeners(): void {
    if (this.listenersActive) return;
    this.listenersActive = true;
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    const canvas = this.canvas();
    canvas?.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    canvas?.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private removeListeners(): void {
    if (!this.listenersActive) return;
    this.listenersActive = false;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    const canvas = this.canvas();
    canvas?.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
    canvas?.removeEventListener('wheel', this.onWheel);
    this.endCenterDrag(false);
    this.flyKeys.clear();
    this.looking = false;
    this.setCanvasCursor('');
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.ui.isOverlayOpen() || isEditableTarget(e.target)) return;
    const code = e.code;

    // Escape while carrying an object by the center handle cancels the drag (restores the position).
    if (this.centerDragging && code === 'Escape') {
      e.preventDefault();
      this.endCenterDrag(false);
      return;
    }

    // Held fly keys. The fly modifiers (Ctrl/Shift) are always tracked so Ctrl=down / Shift=sprint
    // work, but a NON-modifier fly key (W/A/S/D/Space) is NOT consumed for movement while Ctrl/Alt/Meta
    // is held — otherwise it would swallow chords like Ctrl+S / Ctrl+D (S and D are also fly keys).
    if (FLY_CODES.has(code)) {
      const isFlyModifier = code === 'ShiftLeft' || code === 'ControlLeft' || code === 'ControlRight';
      if (isFlyModifier || (!e.ctrlKey && !e.altKey && !e.metaKey)) {
        this.flyKeys.add(code);
        e.preventDefault();
        return;
      }
    }
    // Any Ctrl/Meta chord (Ctrl+S/Z/C/V/D/Y…) briefly stops Ctrl/Shift from also driving the camera.
    if (e.ctrlKey || e.metaKey) this.chordSuppressUntilMs = performance.now() + 260;

    if (code === 'F1') {
      e.preventDefault();
      this.setMode(this.mode === 'build' ? 'playtest' : 'build');
      return;
    }
    if (code === 'Escape') {
      if (this.armedModule) {
        this.armModule(null);
        this.ui.refresh();
      } else {
        this.select(null);
      }
      return;
    }
    if (code === 'Delete' || code === 'Backspace') {
      e.preventDefault();
      this.deleteSelected();
      return;
    }
    if (e.ctrlKey && code === 'KeyA') {
      e.preventDefault();
      this.selectAll();
      return;
    }
    if (e.ctrlKey && code === 'KeyD') {
      e.preventDefault();
      this.duplicateSelected();
      return;
    }
    if (e.ctrlKey && code === 'KeyC') {
      e.preventDefault();
      this.copySelected();
      return;
    }
    if (e.ctrlKey && code === 'KeyV') {
      e.preventDefault();
      this.paste();
      return;
    }
    if (e.ctrlKey && code === 'KeyZ' && !e.shiftKey) {
      e.preventDefault();
      this.undo();
      return;
    }
    if ((e.ctrlKey && code === 'KeyY') || (e.ctrlKey && e.shiftKey && code === 'KeyZ')) {
      e.preventDefault();
      this.redo();
      return;
    }
    if (e.ctrlKey && code === 'KeyS') {
      e.preventDefault();
      this.quickSave();
      return;
    }
    if (e.ctrlKey) return; // leave other Ctrl combos to the browser

    if (this.armedModule && this.handlePlacementAdjustKey(e)) return;

    // Arrow keys / PageUp-Down nudge the selected object by the grid step (Shift = fine). Only when a
    // module isn't armed (armed mode steers the placement preview instead).
    if (!this.armedModule && this.handleNudgeKey(e)) return;

    // --- Single-key tools (Fortnite/Blender style) ---
    if (code === 'KeyG') { e.preventDefault(); this.setSnapSettings({ gizmo: 'move' }); return; }
    if (code === 'KeyR') { e.preventDefault(); this.setSnapSettings({ gizmo: 'rotate' }); return; }
    if (code === 'KeyT') { e.preventDefault(); this.setSnapSettings({ gizmo: 'scale' }); return; }
    if (code === 'KeyV') { e.preventDefault(); this.setSnapSettings({ gizmo: 'off' }); return; }
    if (code === 'KeyF') { e.preventDefault(); this.focusSelected(); return; }
    if (code === 'KeyB') { e.preventDefault(); this.duplicateSelected(); return; }

    // --- Number keys arm the first ten modules (the main building blocks) ---
    const digit = /^Digit([0-9])$/.exec(code);
    if (digit) {
      e.preventDefault();
      const n = Number(digit[1]);
      this.armModuleByIndex(n === 0 ? 9 : n - 1);
    }
  }

  private handleKeyUp(e: KeyboardEvent): void {
    // Always release held keys (defensive against stuck keys when focus changes).
    this.flyKeys.delete(e.code);
  }

  private handlePointerDown(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 0 && this.tryStartCenterDrag(e)) {
      e.preventDefault();
      return;
    }
    // Marquee (drag-rectangle) selection: Select tool active, nothing armed, press began on the
    // viewport. A negligible drag still resolves as a normal click in handlePointerUp.
    if (
      e.button === 0 &&
      this.mode === 'build' &&
      !this.armedModule &&
      !this.armedPrefab &&
      this.snap.gizmo === 'off' &&
      !this.gizmoDragging
    ) {
      const target = e.target as Element | null;
      if (!target || target === this.canvas()) this.beginMarquee(e);
    }
    if (e.button === 2) {
      // Free-look on hold-RMB using raw mouse deltas — deliberately NOT pointer-lock based, so it can't
      // be broken by the cursor-lock suppression machinery. Hide the cursor while dragging.
      this.looking = true;
      this.lookMoved = 0;
      e.preventDefault();
      this.setCanvasCursor('none');
    }
  }

  private handlePointerMove(e: PointerEvent): void {
    this.previewPointerX = e.clientX;
    this.previewPointerY = e.clientY;
    if (this.centerDragging) {
      this.updateCenterDrag();
      return;
    }
    if (this.marqueeActive) {
      this.updateMarquee(e.clientX, e.clientY);
      return;
    }
    if (this.armedPrefab && !this.looking) this.updatePrefabGhostFromPointer();
    if (this.armedModule && !this.looking) this.updatePlacementPreviewFromPointer();
    if (!this.looking) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    this.lookMoved += Math.abs(dx) + Math.abs(dy);
    this.camYaw += dx * LOOK_SENSITIVITY;
    this.camPitch += dy * LOOK_SENSITIVITY;
    this.camPitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, this.camPitch));
    this.applyCameraRotation();
  }

  private handlePointerUp(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    if (e.button === 0 && this.centerDragging) {
      this.endCenterDrag(true);
      return;
    }
    if (e.button === 2) {
      if (this.looking) {
        this.looking = false;
        this.setCanvasCursor('');
        // A right-click tap (negligible drag, not a look) cancels placement / deselects.
        if (this.lookMoved < 6) {
          if (this.armedModule) {
            this.armModule(null);
            this.ui.refresh();
          } else {
            this.select(null);
          }
        }
      }
      return;
    }
    if (e.button !== 0) return;
    if (this.marqueeActive) {
      const wasDrag = this.finishMarquee(e);
      if (wasDrag) return; // a real box-select consumed this release
    }
    if (this.looking) return;
    if (performance.now() < this.ignoreClickUntilMs || this.gizmoDragging) return;
    const target = e.target as Element | null;
    if (target && target !== this.canvas()) return; // click landed on UI, not the world
    this.handleLeftClick(e);
  }

  private setCanvasCursor(cursor: string): void {
    const c = this.canvas();
    if (c) c.style.cursor = cursor;
  }

  private handleWheel(e: WheelEvent): void {
    if (this.centerDragging) {
      // Physgun-style carry: wheel up pushes the object away, wheel down pulls it closer. Shift = fine.
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      const step = e.shiftKey ? 1 : Math.max(2, this.centerDragDistance * 0.08);
      this.centerDragDistance = Math.max(2, Math.min(4000, this.centerDragDistance + dir * step));
      this.updateCenterDrag();
      return;
    }
    if (!this.armedModule) {
      // No module armed: the wheel rotates the SELECTED object around Y, so a placed wall (whose thin
      // profile makes the gizmo ring hard to grab) can be spun with the wheel. Shift = fine 1° step;
      // otherwise the rotation snap. Does nothing when nothing is selected.
      const selected = this.getSelectedObject();
      if (!selected) return;
      e.preventDefault();
      this.chordSuppressUntilMs = performance.now() + 220;
      const dir = e.deltaY > 0 ? 1 : -1;
      const stepDeg = e.shiftKey ? 1 : Math.max(1, this.snap.rotationSnapDeg || 15);
      this.rotateSelectedYaw(dir * stepDeg);
      return;
    }
    e.preventDefault();
    // Scrolling to adjust the preview means Ctrl/Shift are held as a chord — keep them from also
    // driving the fly camera for a moment (fixes "Ctrl+scroll height also sinks the camera").
    this.chordSuppressUntilMs = performance.now() + 220;
    if (e.shiftKey) {
      this.rotatePlacementPreview(e.deltaY > 0 ? 1 : -1);
      return;
    }
    if (e.ctrlKey) {
      this.adjustPlacementHeight(e.deltaY < 0 ? 1 : -1);
      return;
    }
    const types = moduleTypeList();
    const idx = types.indexOf(this.armedModule);
    if (idx < 0) return;
    const next = types[(idx + (e.deltaY > 0 ? 1 : types.length - 1)) % types.length];
    this.armModule(next);
    this.ui.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // Marquee (drag-rectangle) selection
  // ---------------------------------------------------------------------------------------------

  private beginMarquee(e: PointerEvent): void {
    this.marqueeActive = true;
    this.marqueeMoved = false;
    this.marqueeStartX = e.clientX;
    this.marqueeStartY = e.clientY;
    this.marqueeAdditive = e.shiftKey;
    if (!this.marqueeEl) {
      const el = document.createElement('div');
      el.className = 'creator-marquee';
      document.body.appendChild(el);
      this.marqueeEl = el;
    }
    this.updateMarquee(e.clientX, e.clientY);
  }

  private updateMarquee(x: number, y: number): void {
    if (!this.marqueeEl) return;
    const left = Math.min(this.marqueeStartX, x);
    const top = Math.min(this.marqueeStartY, y);
    const w = Math.abs(x - this.marqueeStartX);
    const h = Math.abs(y - this.marqueeStartY);
    if (w + h > 6) this.marqueeMoved = true;
    this.marqueeEl.style.display = this.marqueeMoved ? 'block' : 'none';
    this.marqueeEl.style.left = `${left}px`;
    this.marqueeEl.style.top = `${top}px`;
    this.marqueeEl.style.width = `${w}px`;
    this.marqueeEl.style.height = `${h}px`;
  }

  /** Ends the marquee. Returns true when it was a real drag (box-select performed). */
  private finishMarquee(e: PointerEvent): boolean {
    this.marqueeActive = false;
    if (this.marqueeEl) this.marqueeEl.style.display = 'none';
    if (!this.marqueeMoved) return false; // negligible drag → the caller treats it as a click

    const canvas = this.canvas();
    const cam = this.editorCamera;
    if (!canvas || !cam) return true;
    const rect = canvas.getBoundingClientRect();
    const engine = this.scene.getEngine();
    // Screen-project each object's world center; CSS px → render px via the canvas scale ratio.
    const scaleX = engine.getRenderWidth() / Math.max(1, rect.width);
    const scaleY = engine.getRenderHeight() / Math.max(1, rect.height);
    const minX = (Math.min(this.marqueeStartX, e.clientX) - rect.left) * scaleX;
    const maxX = (Math.max(this.marqueeStartX, e.clientX) - rect.left) * scaleX;
    const minY = (Math.min(this.marqueeStartY, e.clientY) - rect.top) * scaleY;
    const maxY = (Math.max(this.marqueeStartY, e.clientY) - rect.top) * scaleY;

    const transform = this.scene.getTransformMatrix();
    const viewport = cam.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight());
    const ids: string[] = [];
    for (const obj of this.layout.objects) {
      const a = objectWorldAabb(obj);
      const center = new Vector3((a.minX + a.maxX) / 2, (a.minY + a.maxY) / 2, (a.minZ + a.maxZ) / 2);
      const p = Vector3.Project(center, Matrix.Identity(), transform, viewport);
      if (p.z <= 0 || p.z >= 1) continue; // behind the camera / past the far plane
      if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) ids.push(obj.id);
    }
    this.selectMany(ids, this.marqueeAdditive);
    if (ids.length > 0) this.ui.toast(`Selected ${this.selectedIds.size} object${this.selectedIds.size === 1 ? '' : 's'}`);
    return true;
  }

  private handleLeftClick(e: PointerEvent): void {
    const canvas = this.canvas();
    if (!canvas || !this.editorCamera) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pick = this.pickWorld(x, y);
    if (this.armedPrefab) {
      if (pick) this.stampPrefab(pick.point);
      return;
    }
    if (this.armedModule) {
      if (pick) {
        this.updatePlacementPreview(pick.point);
        this.placePlacementPreview();
      }
      return;
    }
    // Shift+click toggles membership in the multi-selection; a plain click replaces it.
    if (e.shiftKey && pick?.objectId) {
      this.toggleSelect(pick.objectId);
      return;
    }
    this.select(pick?.objectId ?? null);
  }

  private pickWorld(x: number, y: number): { point: Vector3; objectId: string | null } | null {
    if (!this.editorCamera) return null;
    const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), this.editorCamera);
    const hit = this.scene.pickWithRay(ray, (m) => this.geometry.isPickableObjectMesh(m));
    if (hit?.hit && hit.pickedPoint) {
      return { point: hit.pickedPoint.clone(), objectId: this.geometry.objectIdForMesh(hit.pickedMesh) };
    }
    // Intersect the ground plane.
    const groundY = this.layout.ground.bounds.y ?? 0;
    const dirY = ray.direction.y;
    if (Math.abs(dirY) < 1e-5) return null;
    const t = (groundY - ray.origin.y) / dirY;
    if (t < 0) return null;
    const point = ray.origin.add(ray.direction.scale(t));
    point.y = groundY;
    return { point, objectId: null };
  }

  // ---------------------------------------------------------------------------------------------
  // Selection + gizmos
  // ---------------------------------------------------------------------------------------------

  private select(id: string | null): void {
    this.selectedId = id && this.findObject(id) ? id : null;
    this.selectedIds.clear();
    if (this.selectedId) this.selectedIds.add(this.selectedId);
    this.refreshSelectionVisual();
    this.ui.refresh();
  }

  /** Shift+click: toggle an object in/out of the multi-selection. The primary follows the newest add. */
  private toggleSelect(id: string): void {
    if (!this.findObject(id)) return;
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
      if (this.selectedId === id) this.selectedId = this.selectedIds.values().next().value ?? null;
    } else {
      this.selectedIds.add(id);
      this.selectedId = id;
    }
    this.refreshSelectionVisual();
    this.ui.refresh();
  }

  /** Ctrl+A: select every object in the layout. */
  private selectAll(): void {
    this.selectedIds.clear();
    for (const o of this.layout.objects) this.selectedIds.add(o.id);
    this.selectedId = this.layout.objects.length > 0 ? this.layout.objects[this.layout.objects.length - 1].id : null;
    this.refreshSelectionVisual();
    this.ui.refresh();
  }

  /** Marquee result: replace (or, additive, extend) the selection with the boxed ids. */
  private selectMany(ids: readonly string[], additive: boolean): void {
    if (!additive) this.selectedIds.clear();
    for (const id of ids) if (this.findObject(id)) this.selectedIds.add(id);
    if (!this.selectedId || !this.selectedIds.has(this.selectedId)) {
      this.selectedId = this.selectedIds.values().next().value ?? null;
    }
    this.refreshSelectionVisual();
    this.ui.refresh();
  }

  /** Drop selection ids whose objects no longer exist (after delete/undo/load). */
  private pruneSelection(): void {
    for (const id of [...this.selectedIds]) {
      if (!this.findObject(id)) this.selectedIds.delete(id);
    }
    if (this.selectedId && !this.selectedIds.has(this.selectedId)) {
      this.selectedId = this.selectedIds.values().next().value ?? null;
    }
    if (this.selectedId && !this.selectedIds.has(this.selectedId)) this.selectedIds.add(this.selectedId);
  }

  /** Every selected object, primary first (stable enough for group math; order is not meaningful). */
  private getSelectedObjects(): CreatorLayoutObject[] {
    const out: CreatorLayoutObject[] = [];
    for (const id of this.selectedIds) {
      const obj = this.findObject(id);
      if (obj) out.push(obj);
    }
    return out;
  }

  /** UI accessors (outliner multi-highlight + inspector "N selected"). */
  getSelectedIds(): string[] {
    return [...this.selectedIds];
  }

  selectionCount(): number {
    return this.selectedIds.size;
  }

  toggleSelectObjectById(id: string): void {
    this.toggleSelect(id);
  }

  private refreshSelectionVisual(): void {
    const objs = this.mode === 'build' && !this.armedModule && !this.armedPrefab ? this.getSelectedObjects() : [];
    this.geometry.setSelectionMany(objs);
    if (this.mode === 'build') this.reattachGizmo();
    this.syncCenterHandle();
  }

  private ensureGizmoManager(): GizmoManager {
    if (this.gizmoManager) return this.gizmoManager;
    const gm = new GizmoManager(this.scene);
    gm.usePointerToAttachGizmos = false;
    gm.positionGizmoEnabled = false;
    gm.rotationGizmoEnabled = false;
    gm.scaleGizmoEnabled = false;
    this.gizmoManager = gm;
    return gm;
  }

  private applyGizmoMode(): void {
    const gm = this.ensureGizmoManager();
    gm.positionGizmoEnabled = this.snap.gizmo === 'move';
    gm.rotationGizmoEnabled = this.snap.gizmo === 'rotate';
    gm.scaleGizmoEnabled = this.snap.gizmo === 'scale';
    // Mode switches recreate the position gizmo (drag behaviors re-enabled) — reset the arrow lock.
    this.gizmoArrowsLocked = false;
    if (gm.gizmos.rotationGizmo) {
      // Collision + visuals honour Y-rotation only, so expose just the yaw ring — X/Z tilt would
      // silently snap back and feel broken.
      gm.gizmos.rotationGizmo.xGizmo.isEnabled = false;
      gm.gizmos.rotationGizmo.zGizmo.isEnabled = false;
    }
    this.wireGizmoDrag();
    this.applyGizmoSnapping();
    this.reattachGizmo();
  }

  private wireGizmoDrag(): void {
    const gm = this.gizmoManager;
    if (!gm) return;
    const wire = (gizmo: { onDragStartObservable: { add(cb: () => void): void }; onDragEndObservable: { add(cb: () => void): void } } | null | undefined) => {
      if (!gizmo) return;
      gizmo.onDragStartObservable.add(() => {
        this.gizmoDragging = true;
        // Group-drag baseline: the primary's transform when the drag begins, so its delta can be
        // applied to every other selected object on commit.
        const obj = this.getSelectedObject();
        this.gizmoStart = obj ? { pos: [...obj.position] as Vec3Tuple, yawDeg: obj.rotation[1] ?? 0 } : null;
      });
      gizmo.onDragEndObservable.add(() => {
        this.commitGizmoTransform();
        this.gizmoDragging = false;
        this.ignoreClickUntilMs = performance.now() + 250;
      });
    };
    wire(gm.gizmos.positionGizmo);
    wire(gm.gizmos.rotationGizmo);
    wire(gm.gizmos.scaleGizmo);
  }

  private applyGizmoSnapping(): void {
    const gm = this.gizmoManager;
    if (!gm) return;
    if (gm.gizmos.positionGizmo) gm.gizmos.positionGizmo.snapDistance = this.snap.gridSnap ? this.snap.gridSize : 0;
    if (gm.gizmos.rotationGizmo) gm.gizmos.rotationGizmo.snapDistance = (this.snap.rotationSnapDeg * Math.PI) / 180;
    if (gm.gizmos.scaleGizmo) gm.gizmos.scaleGizmo.snapDistance = this.snap.scaleSnap;
  }

  private reattachGizmo(): void {
    const gm = this.gizmoManager;
    if (!gm) return;
    const obj = this.getSelectedObject();
    if (!obj || this.armedModule || this.snap.gizmo === 'off' || this.mode !== 'build') {
      gm.attachToNode(null);
      return;
    }
    const node = this.geometry.getObjectRoot(obj.id);
    gm.attachToNode(node ?? null);
  }

  private detachGizmo(): void {
    this.gizmoManager?.attachToNode(null);
  }

  private commitGizmoTransform(): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    const node = this.geometry.getObjectRoot(obj.id);
    if (!node) return;
    const start = this.gizmoStart;
    this.gizmoStart = null;
    obj.position = [node.position.x, node.position.y, node.position.z];
    const euler = node.rotationQuaternion ? node.rotationQuaternion.toEulerAngles() : node.rotation;
    const rad2deg = 180 / Math.PI;
    obj.rotation = [euler.x * rad2deg, normalizeDegrees(euler.y * rad2deg), euler.z * rad2deg];
    // The scale gizmo can be dragged through zero into negative values — that would invert the
    // collision boxes (min > max) and make the object unpickable. Mirror back to positive and floor.
    const safeScale = (v: number) => Math.max(CREATOR_LIMITS.minScale, Math.abs(Number.isFinite(v) ? v : 1));
    obj.scale = [safeScale(node.scaling.x), safeScale(node.scaling.y), safeScale(node.scaling.z)];

    // Multi-selection: carry the primary's drag delta onto every OTHER selected object so the group
    // moves/turns as one unit — translation as a plain offset; rotation as a rigid yaw turn around
    // the primary (the gizmo's visible pivot). Scale stays single-object by design.
    if (start && this.selectedIds.size > 1) {
      const others = this.getSelectedObjects().filter((o) => o.id !== obj.id);
      const dx = obj.position[0] - start.pos[0];
      const dy = obj.position[1] - start.pos[1];
      const dz = obj.position[2] - start.pos[2];
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1e-6) {
        for (const o of others) {
          o.position = [o.position[0] + dx, o.position[1] + dy, o.position[2] + dz];
        }
      }
      const dyaw = normalizeDegrees((obj.rotation[1] ?? 0) - start.yawDeg);
      const effectiveYaw = dyaw > 180 ? dyaw - 360 : dyaw; // shortest arc
      if (Math.abs(effectiveYaw) > 1e-4) {
        rotateObjectsAroundCenterYaw(others, obj.position[0], obj.position[2], effectiveYaw);
      }
    }
    this.commit(obj.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Center-handle free drag (grab the sphere where the 3 arrows meet; wheel = carry distance)
  // ---------------------------------------------------------------------------------------------

  /** Keep the center grab sphere glued to the selected object's gizmo origin at ~constant screen size. */
  private syncCenterHandle(): void {
    const cam = this.editorCamera;
    const obj = this.mode === 'build' && !this.armedModule && this.snap.gizmo === 'move' ? this.getSelectedObject() : null;
    const node = obj ? this.geometry.getObjectRoot(obj.id) : undefined;
    if (!cam || !node) {
      this.geometry.setCenterHandle(null, 0);
      return;
    }
    const dist = Vector3.Distance(cam.position, node.position);
    this.geometry.setCenterHandle(node.position, dist * 0.024);
  }

  /** True when the cursor ray currently passes through the center grab sphere (analytic, no scene pick). */
  private pointerOverCenterHandle(): boolean {
    const handle = this.geometry.getCenterHandleMesh();
    const cam = this.editorCamera;
    const canvas = this.canvas();
    if (!handle || !handle.isEnabled() || !cam || !canvas || this.previewPointerX === null || this.previewPointerY === null) return false;
    const rect = canvas.getBoundingClientRect();
    if (this.previewPointerX < rect.left || this.previewPointerX > rect.right || this.previewPointerY < rect.top || this.previewPointerY > rect.bottom) return false;
    const ray = this.scene.createPickingRay(this.previewPointerX - rect.left, this.previewPointerY - rect.top, Matrix.Identity(), cam);
    const toCenter = handle.position.subtract(ray.origin);
    const along = Vector3.Dot(toCenter, ray.direction);
    if (along < 0) return false;
    const radius = handle.scaling.x * 0.5;
    return toCenter.lengthSquared() - along * along <= radius * radius;
  }

  /**
   * The grab sphere OWNS its screen footprint: while the cursor is inside it (or a center drag is
   * running) the position gizmo's drag handles are disabled, so a click there always starts the free
   * drag instead of an axis-arrow drag. Re-enabled the moment the cursor leaves the sphere.
   */
  private updateGizmoArrowLock(): void {
    const pos = this.gizmoManager?.gizmos.positionGizmo;
    const lock = !!pos && (this.centerDragging || this.pointerOverCenterHandle());
    if (lock === this.gizmoArrowsLocked) return;
    this.gizmoArrowsLocked = lock;
    if (pos) {
      for (const g of [pos.xGizmo, pos.yGizmo, pos.zGizmo, pos.xPlaneGizmo, pos.yPlaneGizmo, pos.zPlaneGizmo]) {
        g.dragBehavior.enabled = !lock;
      }
    }
    if (!this.looking && !this.centerDragging) this.setCanvasCursor(lock ? 'grab' : '');
  }

  private tryStartCenterDrag(e: PointerEvent): boolean {
    if (this.mode !== 'build' || this.armedModule || this.looking || this.gizmoDragging) return false;
    const handle = this.geometry.getCenterHandleMesh();
    const obj = this.getSelectedObject();
    const cam = this.editorCamera;
    const canvas = this.canvas();
    if (!handle || !handle.isEnabled() || !obj || !cam || !canvas) return false;
    const node = this.geometry.getObjectRoot(obj.id);
    if (!node) return false;
    const rect = canvas.getBoundingClientRect();
    const ray = this.scene.createPickingRay(e.clientX - rect.left, e.clientY - rect.top, Matrix.Identity(), cam);
    const hit = this.scene.pickWithRay(ray, (m) => m === handle);
    if (!hit?.hit) return false;
    this.centerDragging = true;
    this.centerDragMoved = false;
    this.centerDragOrigin = [obj.position[0], obj.position[1], obj.position[2]];
    // Carry distance = how far along the view ray the object's origin sits (not the sphere-surface hit).
    this.centerDragDistance = Math.max(2, Vector3.Dot(node.position.subtract(ray.origin), ray.direction));
    this.ui.setDragHint(true);
    this.setCanvasCursor('grabbing');
    return true;
  }

  /** Reproject the carried object onto the cursor ray at the current carry distance (grid-snapped). */
  private updateCenterDrag(): void {
    if (!this.centerDragging) return;
    const obj = this.getSelectedObject();
    const node = obj ? this.geometry.getObjectRoot(obj.id) : undefined;
    const cam = this.editorCamera;
    const canvas = this.canvas();
    if (!obj || !node || !cam || !canvas || this.previewPointerX === null || this.previewPointerY === null) return;
    const rect = canvas.getBoundingClientRect();
    const ray = this.scene.createPickingRay(this.previewPointerX - rect.left, this.previewPointerY - rect.top, Matrix.Identity(), cam);
    const p = ray.origin.add(ray.direction.scale(this.centerDragDistance));
    const nx = this.snapValue(p.x);
    const ny = this.snapValue(p.y);
    const nz = this.snapValue(p.z);
    if (nx !== node.position.x || ny !== node.position.y || nz !== node.position.z) this.centerDragMoved = true;
    node.position.set(nx, ny, nz);
  }

  /** End the center drag: commit the move to history, or restore the original position on cancel. */
  private endCenterDrag(commit: boolean): void {
    if (!this.centerDragging) return;
    this.centerDragging = false;
    this.ui.setDragHint(false);
    this.setCanvasCursor(this.pointerOverCenterHandle() ? 'grab' : '');
    this.ignoreClickUntilMs = performance.now() + 250;
    const obj = this.getSelectedObject();
    const node = obj ? this.geometry.getObjectRoot(obj.id) : undefined;
    if (obj && node) {
      if (commit && this.centerDragMoved) this.commitGizmoTransform();
      else if (this.centerDragOrigin) node.position.set(this.centerDragOrigin[0], this.centerDragOrigin[1], this.centerDragOrigin[2]);
    }
    this.centerDragOrigin = null;
  }

  // ---------------------------------------------------------------------------------------------
  // Layout edits
  // ---------------------------------------------------------------------------------------------

  /** World-space positions of the ball/bot/dummy spawner markers for the playtest host. */
  private collectSpawnerMarkers(): CreatorSpawnerMarkers {
    // Shared with the live Movement Sandbox (CreatorLayout.collectSpawnerMarkers) so playtest and a
    // published course spawn identical actors.
    return collectSpawnerMarkers(this.layout);
  }

  private findObject(id: string): CreatorLayoutObject | undefined {
    return this.layout.objects.find((o) => o.id === id);
  }

  getSelectedObject(): CreatorLayoutObject | null {
    return this.selectedId ? this.findObject(this.selectedId) ?? null : null;
  }

  private snapValue(v: number): number {
    if (!this.snap.gridSnap) return v;
    const g = this.snap.gridSize;
    return Math.round(v / g) * g;
  }

  private handlePlacementAdjustKey(e: KeyboardEvent): boolean {
    const reverse = e.shiftKey ? -1 : 1;
    if (e.code === 'KeyR') {
      e.preventDefault();
      this.rotatePlacementPreview(reverse);
      return true;
    }
    if (e.code === 'KeyQ') {
      e.preventDefault();
      this.adjustPlacementHeight(-1);
      return true;
    }
    if (e.code === 'KeyE') {
      e.preventDefault();
      this.adjustPlacementHeight(1);
      return true;
    }
    if (e.code === 'BracketLeft') {
      e.preventDefault();
      this.adjustPlacementScale(-1);
      return true;
    }
    if (e.code === 'BracketRight') {
      e.preventDefault();
      this.adjustPlacementScale(1);
      return true;
    }
    if (e.code === 'KeyC') {
      e.preventDefault();
      this.resetPlacementAdjustments();
      return true;
    }
    return false;
  }

  private rotatePlacementPreview(steps: number): void {
    const snap = Math.max(1, this.snap.rotationSnapDeg || 15);
    this.previewRotationYDeg = normalizeDegrees(this.previewRotationYDeg + steps * snap);
    this.updatePlacementPreviewFromPointer();
  }

  private adjustPlacementHeight(steps: number): void {
    const step = Math.max(0.25, this.snap.gridSize || 1);
    this.previewYOffset = Math.max(-100000, Math.min(100000, this.previewYOffset + steps * step));
    this.updatePlacementPreviewFromPointer();
  }

  private adjustPlacementScale(steps: number): void {
    const step = Math.max(0.05, this.snap.scaleSnap || 0.25);
    // No upper limit by request — only a tiny positive floor so the preview never collapses to zero.
    const next = Math.max(0.01, this.previewScale[0] + steps * step);
    this.previewScale = [next, next, next];
    this.updatePlacementPreviewFromPointer();
  }

  private resetPlacementAdjustments(): void {
    const def = this.armedModule ? moduleDef(this.armedModule) : null;
    this.previewRotationYDeg = def?.defaultRotationY ?? 0;
    this.previewYOffset = 0;
    this.previewScale = [1, 1, 1];
    this.updatePlacementPreviewFromPointer();
  }

  private updatePlacementPreviewFromPointer(): void {
    if (!this.armedModule || this.mode !== 'build') {
      this.clearPlacementPreview();
      return;
    }
    const canvas = this.canvas();
    if (!canvas || !this.editorCamera) {
      this.clearPlacementPreview();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    // Use the cursor when it's actually over the viewport; otherwise fall back to the SCREEN CENTRE so
    // an armed module ALWAYS shows a ghost (e.g. right after clicking a hotbar chip, before the mouse
    // has moved back over the world). This is what makes "where will it land" obvious at all times.
    const px = this.previewPointerX;
    const py = this.previewPointerY;
    const overCanvas =
      px !== null && py !== null &&
      px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom &&
      document.elementFromPoint(px, py) === canvas;
    const localX = overCanvas ? (px as number) - rect.left : rect.width / 2;
    const localY = overCanvas ? (py as number) - rect.top : rect.height / 2;
    const pick = this.pickWorld(localX, localY) ?? (overCanvas ? this.pickWorld(rect.width / 2, rect.height / 2) : null);
    if (!pick) {
      this.clearPlacementPreview();
      return;
    }
    this.updatePlacementPreview(pick.point);
  }

  private updatePlacementPreview(point: Vector3): void {
    if (!this.armedModule) {
      this.clearPlacementPreview();
      return;
    }
    const def = moduleDef(this.armedModule);
    if (!def) {
      this.clearPlacementPreview();
      return;
    }
    this.placementPreview = {
      id: `preview_${def.type}`,
      type: def.type,
      position: [
        this.snapValue(point.x),
        Math.max(this.layout.ground.bounds.y ?? 0, point.y) + this.previewYOffset,
        this.snapValue(point.z)
      ],
      rotation: [0, this.previewRotationYDeg, 0],
      scale: [...this.previewScale],
      material: def.material,
      collision: def.collision,
      opacity: 1,
      wallrunEnabled: true,
      metadata: cloneMetadata(def.defaultMetadata)
    };
    this.geometry.setPlacementPreview(this.placementPreview);
  }

  private clearPlacementPreview(): void {
    this.placementPreview = null;
    this.geometry.clearPlacementPreview();
  }

  /** Shared object-cap guard for place/duplicate/paste (import clamps to the same limit). */
  private atObjectLimit(): boolean {
    if (this.layout.objects.length < CREATOR_LIMITS.maxObjects) return false;
    this.ui.toast(`Object limit reached (${CREATOR_LIMITS.maxObjects}).`);
    return true;
  }

  private placePlacementPreview(): void {
    const preview = this.placementPreview;
    if (!preview) return;
    if (this.atObjectLimit()) return;
    const obj: CreatorLayoutObject = {
      ...preview,
      id: createObjectId(preview.type),
      position: [...preview.position],
      rotation: [...preview.rotation],
      scale: [...preview.scale],
      metadata: cloneMetadata(preview.metadata)
    };
    this.layout.objects.push(obj);
    if (obj.type === 'spawn_point') setExclusiveDefaultSpawn(this.layout, obj.id);
    this.selectedId = obj.id;
    this.commit(obj.id);
    this.updatePlacementPreviewFromPointer();
  }

  duplicateSelected(): void {
    const objs = this.getSelectedObjects();
    if (objs.length === 0) return;
    if (this.layout.objects.length + objs.length > CREATOR_LIMITS.maxObjects) {
      this.ui.toast(`Object limit reached (${CREATOR_LIMITS.maxObjects}).`);
      return;
    }
    // Duplicate the WHOLE selection as one unit (one history entry): each copy exactly on top of its
    // source (same positions) so the group can be dragged out, and the clones become the selection.
    const clones: CreatorLayoutObject[] = [];
    for (const obj of objs) {
      const copy = this.cloneObject(obj);
      copy.id = createObjectId(obj.type);
      copy.position = [...obj.position];
      this.layout.objects.push(copy);
      if (copy.type === 'spawn_point') setExclusiveDefaultSpawn(this.layout, copy.id);
      clones.push(copy);
    }
    this.selectedIds.clear();
    for (const c of clones) this.selectedIds.add(c.id);
    this.selectedId = clones[clones.length - 1].id;
    this.commit(this.selectedId);
  }

  deleteSelected(): void {
    if (this.selectedIds.size === 0) return;
    const doomed = new Set(this.selectedIds);
    this.layout.objects = this.layout.objects.filter((o) => !doomed.has(o.id));
    this.selectedIds.clear();
    this.selectedId = null;
    this.commit(null);
  }

  /** Wheel-rotate the selection around Y by deltaDeg: a single object spins in place; a multi-
   *  selection turns as a rigid group around its shared XZ center. One history entry either way. */
  private rotateSelectedYaw(deltaDeg: number): void {
    const objs = this.getSelectedObjects();
    if (objs.length === 0) return;
    if (objs.length === 1) {
      const obj = objs[0];
      obj.rotation = [obj.rotation[0], normalizeDegrees((obj.rotation[1] ?? 0) + deltaDeg), obj.rotation[2]];
    } else {
      const origin = objectsGroupOrigin(objs);
      rotateObjectsAroundCenterYaw(objs, origin.x, origin.z, deltaDeg);
    }
    this.commit(this.selectedId);
  }

  resetSelectedTransform(): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    const def = moduleDef(obj.type);
    obj.rotation = [0, def?.defaultRotationY ?? 0, 0];
    obj.scale = [1, 1, 1];
    obj.position = [obj.position[0], this.layout.ground.bounds.y ?? 0, obj.position[2]];
    this.commit(obj.id);
  }

  setSelectedName(name: string): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.name = name.slice(0, 48);
    this.commit(obj.id);
  }

  setSelectedTransform(field: 'position' | 'rotation', axis: 0 | 1 | 2, value: number): void {
    const obj = this.getSelectedObject();
    if (!obj || !Number.isFinite(value)) return;
    const v = field === 'position' && (axis === 0 || axis === 2) ? this.snapValue(value) : value;
    obj[field][axis] = v;
    this.commit(obj.id);
  }

  setSelectedDimension(axis: 0 | 1 | 2, value: number): void {
    const obj = this.getSelectedObject();
    if (!obj || !Number.isFinite(value)) return;
    if (value <= 0) {
      // Don't silently swallow a zero/negative size — the input would keep showing a value that was
      // never applied. Clamp to the minimum and commit, so the field snaps to what actually took.
      value = CREATOR_LIMITS.minDimension;
    }
    const dims = objectDimensions(obj);
    dims[axis] = value;
    obj.scale = scaleForDimensions(obj.type, dims as Vec3Tuple);
    this.commit(obj.id);
  }

  setSelectedMaterial(id: string): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.material = id;
    this.commit(obj.id);
  }

  /** Apply a real in-game image texture to the selected solid (null clears it back to the flat material). */
  setSelectedTexture(id: string | null): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    if (id && textureDef(id)) obj.texture = id;
    else delete obj.texture;
    this.commit(obj.id);
  }

  setSelectedCollision(value: boolean): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.collision = value;
    this.commit(obj.id);
  }

  setSelectedOpacity(value: number): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.opacity = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
    delete obj.visible;
    this.commit(obj.id);
  }

  setSelectedWallrun(value: boolean): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.wallrunEnabled = value;
    this.commit(obj.id);
  }

  setSelectedMetadata(patch: Partial<CreatorObjectMetadata>): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    // Choosing a new default spawn must actually switch it: clear the flag on every OTHER spawn first,
    // otherwise the previous default would stay active and your pick could be reverted on commit.
    if (patch.defaultSpawn === true && obj.type === 'spawn_point') {
      setExclusiveDefaultSpawn(this.layout, obj.id);
    }
    obj.metadata = { ...(obj.metadata ?? {}), ...patch };
    this.commit(obj.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Clipboard (Copy / Paste) — distinct from Duplicate: copy once, paste many (at the cursor).
  // ---------------------------------------------------------------------------------------------

  private cloneObject(obj: CreatorLayoutObject): CreatorLayoutObject {
    return cloneLayout({ version: 0, name: '', updatedAt: '', ground: this.layout.ground, objects: [obj] }).objects[0];
  }

  copySelected(): void {
    const objs = this.getSelectedObjects();
    if (objs.length === 0) {
      this.ui.toast('Nothing selected to copy');
      return;
    }
    this.clipboard = objs.map((o) => this.cloneObject(o));
    this.ui.toast(objs.length === 1 ? 'Copied object' : `Copied ${objs.length} objects`);
  }

  hasClipboard(): boolean {
    return this.clipboard !== null && this.clipboard.length > 0;
  }

  paste(): void {
    if (!this.clipboard || this.clipboard.length === 0) {
      this.ui.toast('Clipboard is empty');
      return;
    }
    if (this.layout.objects.length + this.clipboard.length > CREATOR_LIMITS.maxObjects) {
      this.ui.toast(`Object limit reached (${CREATOR_LIMITS.maxObjects}).`);
      return;
    }
    const groundY = this.layout.ground.bounds.y ?? 0;
    const at = this.pasteWorldPoint();
    // Group paste keeps the copies' offsets around their shared XZ center; the center lands at the
    // cursor (or a grid-step offset from the originals when the cursor is off the viewport).
    const origin = objectsGroupOrigin(this.clipboard);
    const off = Math.max(2, this.snap.gridSize);
    const targetX = at ? this.snapValue(at.x) : origin.x + off;
    const targetZ = at ? this.snapValue(at.z) : origin.z + off;
    const pasted: CreatorLayoutObject[] = [];
    for (const source of this.clipboard) {
      const copy = this.cloneObject(source);
      copy.id = createObjectId(copy.type);
      copy.position = [
        targetX + (source.position[0] - origin.x),
        Math.max(groundY, source.position[1]),
        targetZ + (source.position[2] - origin.z)
      ];
      this.layout.objects.push(copy);
      if (copy.type === 'spawn_point') setExclusiveDefaultSpawn(this.layout, copy.id);
      pasted.push(copy);
    }
    this.selectedIds.clear();
    for (const c of pasted) this.selectedIds.add(c.id);
    this.selectedId = pasted[pasted.length - 1].id;
    this.commit(this.selectedId);
    this.ui.toast(pasted.length === 1 ? 'Pasted object' : `Pasted ${pasted.length} objects`);
  }

  /** World XZ under the cursor if it's over the viewport, else null (paste falls back to an offset). */
  private pasteWorldPoint(): { x: number; z: number } | null {
    if (this.previewPointerX === null || this.previewPointerY === null) return null;
    const canvas = this.canvas();
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (
      this.previewPointerX < rect.left || this.previewPointerX > rect.right ||
      this.previewPointerY < rect.top || this.previewPointerY > rect.bottom
    ) {
      return null;
    }
    const pick = this.pickWorld(this.previewPointerX - rect.left, this.previewPointerY - rect.top);
    return pick ? { x: pick.point.x, z: pick.point.z } : null;
  }

  // ---------------------------------------------------------------------------------------------
  // Keyboard nudge of the selected object (arrows = XZ, PageUp/Down = Y, Shift = fine)
  // ---------------------------------------------------------------------------------------------

  private handleNudgeKey(e: KeyboardEvent): boolean {
    const obj = this.getSelectedObject();
    if (!obj) return false;
    const base = this.snap.gridSnap ? this.snap.gridSize : 1;
    const step = e.shiftKey ? Math.max(0.05, base / 4) : base;
    let dx = 0;
    let dy = 0;
    let dz = 0;
    switch (e.code) {
      case 'ArrowLeft': dx = -step; break;
      case 'ArrowRight': dx = step; break;
      case 'ArrowUp': dz = step; break;
      case 'ArrowDown': dz = -step; break;
      case 'PageUp': dy = step; break;
      case 'PageDown': dy = -step; break;
      default: return false;
    }
    e.preventDefault();
    const groundY = this.layout.ground.bounds.y ?? 0;
    // Nudge the WHOLE selection as one unit — one history entry for the group.
    for (const o of this.getSelectedObjects()) {
      o.position = [o.position[0] + dx, Math.max(groundY, o.position[1] + dy), o.position[2] + dz];
    }
    this.commit(this.selectedId);
    return true;
  }

  // ---------------------------------------------------------------------------------------------
  // Outliner (object list) accessors — select/focus/hide/delete any object, incl. hidden/overlapping
  // ---------------------------------------------------------------------------------------------

  listObjects(): CreatorLayoutObject[] {
    return this.layout.objects;
  }

  getSelectedId(): string | null {
    return this.selectedId;
  }

  selectObjectById(id: string): void {
    this.select(id);
  }

  focusObjectById(id: string): void {
    this.select(id);
    this.focusSelected();
  }

  /** Toggle an object's opacity from the outliner. Transparent objects stay listed and selectable. */
  toggleObjectVisibility(id: string): void {
    const obj = this.findObject(id);
    if (!obj) return;
    obj.opacity = objectOpacity(obj) <= 0 ? 1 : 0;
    delete obj.visible;
    this.commit(this.selectedId);
  }

  deleteObjectById(id: string): void {
    if (!this.findObject(id)) return;
    this.layout.objects = this.layout.objects.filter((o) => o.id !== id);
    if (this.selectedId === id) this.selectedId = null;
    this.commit(this.selectedId);
  }

  /** Remove every Test Spawn pad in one shot (the inspector's hold-to-confirm "Destroy All" button). */
  destroyAllTestSpawns(): void {
    const before = this.layout.objects.length;
    this.layout.objects = this.layout.objects.filter((o) => o.type !== 'test_spawn');
    const removed = before - this.layout.objects.length;
    if (removed === 0) {
      this.ui.toast('No test spawns to destroy');
      return;
    }
    if (this.selectedId && !this.findObject(this.selectedId)) this.selectedId = null;
    this.commit(this.selectedId);
    this.ui.toast(`Destroyed ${removed} test spawn${removed === 1 ? '' : 's'}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Palette
  // ---------------------------------------------------------------------------------------------

  armModule(type: string | null): void {
    if (type) this.disarmPrefab(); // modules and prefabs are mutually exclusive placement modes
    this.armedModule = type && moduleDef(type) ? type : null;
    this.resetPlacementAdjustments();
    if (!this.armedModule) this.clearPlacementPreview();
    else this.updatePlacementPreviewFromPointer();
    this.refreshSelectionVisual();
  }

  // ---------------------------------------------------------------------------------------------
  // Prefabs — save the current selection as a reusable assembly; stamp it from the hotbar.
  // ---------------------------------------------------------------------------------------------

  getPrefabNames(): string[] {
    return this.prefabs.map((p) => p.name);
  }

  getArmedPrefabName(): string | null {
    return this.armedPrefab?.name ?? null;
  }

  /** "Save selection as prefab": captures the selected objects with positions relative to the
   *  selection center (XZ centroid, lowest Y) so stamping at a ground point seats it on the ground. */
  savePrefabFromSelection(): void {
    const objs = this.getSelectedObjects();
    if (objs.length === 0) {
      this.ui.toast('Select objects first, then save them as a prefab');
      return;
    }
    const name = window.prompt(`Prefab name for ${objs.length} object${objs.length === 1 ? '' : 's'}:`, 'My Prefab');
    if (!name || !name.trim()) return;
    const prefab = makePrefabFromObjects(name, objs);
    // Same-name replaces; the library is bounded (oldest dropped beyond MAX_PREFABS).
    this.prefabs = [...this.prefabs.filter((p) => p.name !== prefab.name), prefab].slice(-MAX_PREFABS);
    savePrefabLibrary(this.prefabs);
    this.ui.toast(`Saved prefab "${prefab.name}"`);
    this.ui.refresh();
  }

  /** Arm/toggle a prefab for stamping (disarms any module; ghost box follows the cursor). */
  armPrefab(name: string | null): void {
    const next = name ? this.prefabs.find((p) => p.name === name) ?? null : null;
    if (this.armedPrefab && next && this.armedPrefab.name === next.name) {
      this.disarmPrefab();
      this.ui.refresh();
      return;
    }
    this.armedModule = null;
    this.clearPlacementPreview();
    this.armedPrefab = next;
    if (next) this.updatePrefabGhostFromPointer();
    else this.hidePrefabGhost();
    this.refreshSelectionVisual();
    this.ui.refresh();
  }

  deletePrefab(name: string): void {
    if (!window.confirm(`Delete prefab "${name}"?`)) return;
    this.prefabs = this.prefabs.filter((p) => p.name !== name);
    savePrefabLibrary(this.prefabs);
    if (this.armedPrefab?.name === name) this.disarmPrefab();
    this.ui.toast(`Deleted prefab "${name}"`);
    this.ui.refresh();
  }

  private disarmPrefab(): void {
    this.armedPrefab = null;
    this.hidePrefabGhost();
  }

  /** Stamp the armed prefab at a picked world point: fresh ids, per-object validation via the normal
   *  commit path, object cap respected, and the stamped copies become the selection (one history entry). */
  private stampPrefab(point: Vector3): void {
    const prefab = this.armedPrefab;
    if (!prefab) return;
    if (this.layout.objects.length + prefab.objects.length > CREATOR_LIMITS.maxObjects) {
      this.ui.toast(`Object limit reached (${CREATOR_LIMITS.maxObjects}).`);
      return;
    }
    const groundY = this.layout.ground.bounds.y ?? 0;
    const at = { x: this.snapValue(point.x), y: Math.max(groundY, point.y), z: this.snapValue(point.z) };
    const stamped = instantiatePrefab(prefab, at);
    for (const obj of stamped) {
      this.layout.objects.push(obj);
      if (obj.type === 'spawn_point') setExclusiveDefaultSpawn(this.layout, obj.id);
    }
    this.selectedIds.clear();
    for (const obj of stamped) this.selectedIds.add(obj.id);
    this.selectedId = stamped[stamped.length - 1]?.id ?? null;
    this.commit(this.selectedId);
    this.ui.toast(`Placed prefab "${prefab.name}" (${stamped.length})`);
  }

  /** Wireframe bounding-box ghost showing where the armed prefab will land (screen-centre fallback). */
  private updatePrefabGhostFromPointer(): void {
    const prefab = this.armedPrefab;
    const canvas = this.canvas();
    if (!prefab || !canvas || this.mode !== 'build') return;
    const rect = canvas.getBoundingClientRect();
    const inViewport =
      this.previewPointerX !== null && this.previewPointerY !== null &&
      this.previewPointerX >= rect.left && this.previewPointerX <= rect.right &&
      this.previewPointerY >= rect.top && this.previewPointerY <= rect.bottom;
    const sx = inViewport ? this.previewPointerX! - rect.left : rect.width / 2;
    const sy = inViewport ? this.previewPointerY! - rect.top : rect.height / 2;
    const pick = this.pickWorld(sx, sy);
    if (!pick) {
      this.hidePrefabGhost();
      return;
    }
    const groundY = this.layout.ground.bounds.y ?? 0;
    const at = { x: this.snapValue(pick.point.x), y: Math.max(groundY, pick.point.y), z: this.snapValue(pick.point.z) };
    const b = prefabWorldBounds(prefab, at);
    if (!this.prefabGhost) {
      const mat = new StandardMaterial('creator_prefab_ghost_mat', this.scene);
      mat.emissiveColor = new Color3(0.35, 0.9, 1.0);
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.specularColor = new Color3(0, 0, 0);
      mat.disableLighting = true;
      mat.wireframe = true;
      const box = MeshBuilder.CreateBox('creator_prefab_ghost', { size: 1 }, this.scene);
      box.material = mat;
      box.isPickable = false;
      this.prefabGhost = box;
    }
    this.prefabGhost.scaling.set(Math.max(0.2, b.maxX - b.minX), Math.max(0.2, b.maxY - b.minY), Math.max(0.2, b.maxZ - b.minZ));
    this.prefabGhost.position.set((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, (b.minZ + b.maxZ) / 2);
    this.prefabGhost.setEnabled(true);
  }

  private hidePrefabGhost(): void {
    this.prefabGhost?.setEnabled(false);
  }

  getArmedModule(): string | null {
    return this.armedModule;
  }

  /** Arm the Nth module in the palette order (used by the number-key hotbar shortcuts). Toggles off if
   *  the same module is pressed again. */
  armModuleByIndex(index: number): void {
    const mod = CREATOR_MODULES[index];
    if (!mod) return;
    this.armModule(this.armedModule === mod.type ? null : mod.type);
    this.ui.refresh();
  }

  /** Frame the editor camera on the selected object (F), keeping the current view angle. */
  focusSelected(): void {
    const obj = this.getSelectedObject();
    const cam = this.editorCamera;
    if (!obj || !cam) return;
    const a = objectWorldAabb(obj);
    const cx = (a.minX + a.maxX) / 2;
    const cy = (a.minY + a.maxY) / 2;
    const cz = (a.minZ + a.maxZ) / 2;
    const span = Math.max(a.maxX - a.minX, a.maxY - a.minY, a.maxZ - a.minZ, 4);
    const dist = span * 1.6 + 6;
    const cosPitch = Math.cos(this.camPitch);
    const fX = Math.sin(this.camYaw) * cosPitch;
    const fZ = Math.cos(this.camYaw) * cosPitch;
    const fY = -Math.sin(this.camPitch);
    cam.position.set(cx - fX * dist, cy - fY * dist, cz - fZ * dist);
  }

  // ---------------------------------------------------------------------------------------------
  // Grid / snap
  // ---------------------------------------------------------------------------------------------

  getSnapSettings(): CreatorSnapSettings {
    return { ...this.snap };
  }

  setSnapSettings(patch: Partial<CreatorSnapSettings>): void {
    // Choosing a transform tool (Move/Rotate/Scale/Select) exits placement: disarm the held module /
    // prefab so the next click SELECTS what you clicked instead of stamping another copy.
    if (patch.gizmo !== undefined && this.armedModule) this.armModule(null);
    if (patch.gizmo !== undefined && this.armedPrefab) this.disarmPrefab();
    Object.assign(this.snap, patch);
    if (patch.showGrid !== undefined) this.geometry.setGridVisible(this.snap.showGrid);
    if (patch.showTriggers !== undefined) this.geometry.setTriggersVisible(this.snap.showTriggers);
    if (patch.showCollision !== undefined) this.geometry.setCollisionVisible(this.snap.showCollision);
    if (patch.showReplay !== undefined) this.replay.setEnabled(this.snap.showReplay);
    if (patch.gizmo !== undefined) this.applyGizmoMode();
    if (patch.gridSnap !== undefined || patch.gridSize !== undefined || patch.rotationSnapDeg !== undefined || patch.scaleSnap !== undefined) {
      this.applyGizmoSnapping();
    }
    this.ui.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------------------------

  canUndo(): boolean {
    return this.history.canUndo();
  }
  canRedo(): boolean {
    return this.history.canRedo();
  }

  undo(): void {
    const prev = this.history.undo();
    if (prev) this.applyLayout(prev, false);
  }

  redo(): void {
    const next = this.history.redo();
    if (next) this.applyLayout(next, false);
  }

  /** Commit the current (mutated) layout to history + rebuild everything. */
  private commit(reselectId: string | null): void {
    this.layout.updatedAt = new Date().toISOString();
    enforceSingleDefaultSpawn(this.layout);
    this.history.commit(this.layout);
    this.selectedId = reselectId && this.findObject(reselectId) ? reselectId : this.selectedId && this.findObject(this.selectedId) ? this.selectedId : null;
    // Multi-selection follows: a group op keeps its curated set (primary already a member); selecting
    // a brand-new object (place/duplicate-single/paste) collapses the set down to just it.
    if (this.selectedId && !this.selectedIds.has(this.selectedId)) {
      this.selectedIds.clear();
      this.selectedIds.add(this.selectedId);
    } else {
      this.pruneSelection();
    }
    this.rebuildAfterChange();
    this.scheduleAutosave();
  }

  /** Replace the whole layout (undo/redo/load/import/reset). `record` adds a history entry. */
  private applyLayout(layout: CreatorLayout, record: boolean): void {
    this.layout = layout;
    enforceSingleDefaultSpawn(this.layout);
    if (record) this.history.commit(this.layout);
    if (this.selectedId && !this.findObject(this.selectedId)) this.selectedId = null;
    this.pruneSelection();
    this.rebuildAfterChange();
    this.scheduleAutosave();
  }

  // ---------------------------------------------------------------------------------------------
  // Autosave — debounced write of the working layout so a closed tab never loses progress.
  // ---------------------------------------------------------------------------------------------

  /**
   * Mark the layout dirty and (re)start the debounce. Only ever called from committed changes
   * (history commits), never per frame or mid-gizmo-drag. A continuous editing burst still flushes
   * at least every AUTOSAVE_MAX_INTERVAL_MS.
   */
  private scheduleAutosave(): void {
    const now = performance.now();
    if (!this.autosavePending) {
      this.autosavePending = true;
      this.autosaveFirstPendingMs = now;
    }
    if (this.autosaveTimer !== null) window.clearTimeout(this.autosaveTimer);
    const untilMaxFlush = this.autosaveFirstPendingMs + AUTOSAVE_MAX_INTERVAL_MS - now;
    const delay = Math.max(0, Math.min(AUTOSAVE_DEBOUNCE_MS, untilMaxFlush));
    this.autosaveTimer = window.setTimeout(() => this.flushAutosave(), delay);
  }

  /** Cancel any scheduled autosave write without flushing (an explicit save just superseded it). */
  private cancelPendingAutosave(): void {
    this.autosavePending = false;
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
  }

  /**
   * Write a pending autosave NOW — debounce elapsed, max interval hit, entering Playtest, the tab
   * hiding/closing, or the editor tearing down. No-op when nothing is pending. Write failures
   * (private mode / quota) surface as a status message ONCE, not per edit.
   */
  private flushAutosave(): void {
    if (this.autosaveTimer !== null) {
      window.clearTimeout(this.autosaveTimer);
      this.autosaveTimer = null;
    }
    if (!this.autosavePending) return;
    this.autosavePending = false;
    if (saveProjectAutosave(this.projectId, this.layout)) {
      this.autosaveFailureNotified = false;
      this.ui.setAutosaveStatus(`Autosaved ${new Date().toLocaleTimeString()}`);
      this.ui.flashSaveIndicator('Autosaved');
    } else if (!this.autosaveFailureNotified) {
      this.autosaveFailureNotified = true;
      this.ui.setAutosaveStatus('Autosave unavailable');
    }
  }

  private rebuildAfterChange(): void {
    this.geometry.rebuild(this.layout);
    this.geometry.setOverlaysEnabled(this.mode === 'build');
    this.world.rebuild(this.layout);
    if (this.worldInstalled) {
      // Keep an active playtest collision set in sync with edits (rare; edits happen in Build).
      this.uninstallWorldAndCollision();
      this.installWorldAndCollision();
    }
    this.refreshSelectionVisual();
    this.ui.refresh();
  }

  // ---------------------------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------------------------

  quickSave(): void {
    const ok = saveProjectManual(this.projectId, this.layout);
    if (!ok) {
      this.ui.toast('Save failed — storage unavailable');
      return;
    }
    // The explicit save IS the newest state: cancel any pending debounce (a stale write landing
    // after it would be pointless) and refresh the autosave slot to match.
    this.cancelPendingAutosave();
    if (saveProjectAutosave(this.projectId, this.layout)) {
      this.autosaveFailureNotified = false;
      this.ui.setAutosaveStatus(`Autosaved ${new Date().toLocaleTimeString()}`);
    }
    // Quiet on purpose: saving happens constantly (Ctrl+S habit + autosave), so success is a small
    // top-centre flash — the loud toast is reserved for failures.
    this.ui.flashSaveIndicator('Saved');
  }

  quickLoad(): void {
    const loaded = loadProjectManual(this.projectId)?.layout ?? null;
    if (!loaded) {
      this.ui.toast('No manual save found for this course');
      return;
    }
    if (!window.confirm('Load the last manual save of this course? Unsaved changes will be lost.')) return;
    this.selectedId = null;
    this.applyLayout(loaded, true);
    this.ui.toast('Loaded manual save');
  }

  exportJson(): void {
    const check = isLayoutValid(this.layout);
    if (!check.valid) this.ui.toast(`Exported (note: ${check.reason})`);
    else this.ui.toast('Exported — share the downloaded .json file');
    // Carry the prefab library in the export so saved assemblies survive a browser wipe.
    exportLayoutToFile(this.prefabs.length > 0 ? { ...this.layout, prefabs: this.prefabs } : this.layout);
  }

  /**
   * Import a shared course file. The file is validated, its metadata (name/difficulty/description +
   * any auto-fixes) is shown in a preview card, and confirming adds it as a NEW project — it never
   * overwrites the importer's existing courses.
   */
  importJsonFile(file: File): void {
    importLayoutFromFile(file)
      .then(({ layout, problems }) => {
        this.ui.showImportPreview(
          {
            name: layout.name,
            description: layout.description ?? '',
            difficulty: layout.difficulty ?? null,
            objectCount: layout.objects.length,
            problems
          },
          () => {
            // Merge any prefabs the file carries into the local library (same-name entries replaced).
            if (layout.prefabs && layout.prefabs.length > 0) {
              const incoming = layout.prefabs;
              const kept = this.prefabs.filter((p) => !incoming.some((i) => i.name === p.name));
              this.prefabs = [...kept, ...incoming].slice(-MAX_PREFABS);
              savePrefabLibrary(this.prefabs);
              delete layout.prefabs; // the working layout itself never carries the library
            }
            this.createAndOpen(layout, `Added “${layout.name}” to your courses`);
          }
        );
      })
      .catch((err: Error) => this.ui.toast(err.message || 'Invalid layout file'));
  }

  /**
   * The manual revert: replace this course's content with the committed starter map. The old
   * explicit save stays in its slot ('Load' can still bring it back), and the revert itself is a
   * history entry (Ctrl+Z undoes it in-session).
   */
  resetLayout(): void {
    if (!window.confirm('Revert this course to the default Movement Sandbox map? This replaces its current content.')) return;
    this.selectedId = null;
    this.applyLayout(committedCourseLayout(), true);
    this.ui.toast('Reverted to the default map');
  }

  /**
   * Copy the current layout JSON to the clipboard so it can be handed off and saved into the repo
   * (layouts/movementCourseLayout.json) to become the live course. Falls back to a JSON export
   * download if the clipboard API is unavailable.
   */
  copyJson(): void {
    const json = JSON.stringify(this.layout, null, 2);
    const clip = navigator.clipboard;
    if (clip && typeof clip.writeText === 'function') {
      clip.writeText(json).then(
        () => this.ui.toast('Layout JSON copied — paste it to save into the repo'),
        () => {
          exportLayoutToFile(this.layout);
          this.ui.toast('Clipboard blocked — exported JSON file instead');
        }
      );
    } else {
      exportLayoutToFile(this.layout);
      this.ui.toast('Clipboard unavailable — exported JSON file instead');
    }
  }

  resetPlayer(): void {
    this.player.resetPosition();
  }

  // ---------------------------------------------------------------------------------------------
  // Course projects (multiple named local courses; see CreatorStorage)
  // ---------------------------------------------------------------------------------------------

  listProjects(): ProjectSummary[] {
    return loadProjectsIndex().entries;
  }

  getActiveProjectId(): string {
    return this.projectId;
  }

  starterCourseName(): string {
    return committedCourseLayout().name;
  }

  /** Load another project into the editor. Flushes the current project's edits first. */
  openProject(id: string): void {
    if (id === this.projectId) return;
    if (this.mode === 'playtest') this.setMode('build');
    this.flushAutosave();
    if (!setActiveProject(id)) {
      this.ui.toast('Course not found');
      return;
    }
    this.projectId = id;
    this.adoptProjectLayout(loadProjectWorking(id) ?? committedCourseLayout());
    this.ui.toast(`Opened “${this.layout.name}”`);
  }

  createNewProject(): void {
    this.createAndOpen(blankCourseLayout(), 'New course created');
  }

  /** "Open a Copy" on the featured starter course: a fresh project pre-filled with it. */
  createStarterCopyProject(): void {
    const layout = committedCourseLayout();
    layout.name = `${layout.name} (copy)`.slice(0, CREATOR_LIMITS.maxNameLength);
    this.createAndOpen(layout, 'Starter course copied');
  }

  private createAndOpen(layout: CreatorLayout, toast: string): void {
    if (this.mode === 'playtest') this.setMode('build');
    this.flushAutosave();
    const created = createProject(layout);
    if (!created) {
      this.ui.toast('Could not create course — storage unavailable');
      return;
    }
    this.projectId = created.id;
    this.adoptProjectLayout(layout);
    this.ui.toast(toast);
  }

  renameProjectById(id: string): void {
    const current = loadProjectsIndex().entries.find((e) => e.id === id);
    if (!current) return;
    const name = window.prompt('Course name', current.name);
    if (name === null) return;
    const clean = name.trim().slice(0, CREATOR_LIMITS.maxNameLength);
    if (!clean) return;
    if (id === this.projectId) {
      this.setCourseInfo({ name: clean });
    } else if (!renameProject(id, clean)) {
      this.ui.toast('Rename failed — storage unavailable');
    }
    this.ui.refresh();
  }

  duplicateProjectById(id: string): void {
    // Duplicating the active project must include the newest in-memory edits.
    if (id === this.projectId) this.flushAutosave();
    const copy = duplicateProject(id);
    this.ui.toast(copy ? `Duplicated as “${copy.name}”` : 'Duplicate failed — storage unavailable');
    this.ui.refresh();
  }

  deleteProjectById(id: string): void {
    const target = loadProjectsIndex().entries.find((e) => e.id === id);
    if (!target) return;
    if (!window.confirm(`Delete “${target.name}”? This cannot be undone.`)) return;
    const wasActive = id === this.projectId;
    // A pending autosave must never land after the delete — under the OLD id it would resurrect the
    // course; after the id switches it would overwrite the newly adopted project.
    if (wasActive) this.cancelPendingAutosave();
    if (!deleteProject(id)) {
      this.ui.toast('Delete failed');
      return;
    }
    if (wasActive) {
      if (this.mode === 'playtest') this.setMode('build');
      this.projectId = loadProjectsIndex().activeId;
      this.adoptProjectLayout(loadProjectWorking(this.projectId) ?? committedCourseLayout());
    }
    this.ui.toast('Course deleted');
    this.ui.refresh();
  }

  getCourseInfo(): { name: string; description: string; difficulty: CourseDifficulty | null } {
    return {
      name: this.layout.name,
      description: this.layout.description ?? '',
      difficulty: this.layout.difficulty ?? null
    };
  }

  /** Edit the active course's listed metadata. Committed to history + flushed so the list updates. */
  setCourseInfo(patch: { name?: string; description?: string; difficulty?: CourseDifficulty | null }): void {
    if (patch.name !== undefined) {
      const clean = patch.name.trim().slice(0, CREATOR_LIMITS.maxNameLength);
      if (clean) this.layout.name = clean;
    }
    if (patch.description !== undefined) {
      const clean = patch.description.slice(0, CREATOR_LIMITS.maxDescriptionLength);
      if (clean) this.layout.description = clean;
      else delete this.layout.description;
    }
    if (patch.difficulty !== undefined) {
      if (patch.difficulty && (COURSE_DIFFICULTIES as readonly string[]).includes(patch.difficulty)) {
        this.layout.difficulty = patch.difficulty;
      } else {
        delete this.layout.difficulty;
      }
    }
    this.commit(null);
    this.flushAutosave(); // immediate, so the course list + autosave summary reflect it now
  }

  /**
   * Adopt a different project's layout as the editor state. Unlike quickLoad/import (which stay
   * within one project), this RESETS undo history — undoing across a project switch would write one
   * course's content into another's autosave slot.
   */
  private adoptProjectLayout(layout: CreatorLayout): void {
    this.selectedId = null;
    this.selectedIds.clear();
    this.layout = layout;
    enforceSingleDefaultSpawn(this.layout);
    this.history.reset(this.layout);
    this.rebuildAfterChange();
    this.positionEditorCameraAtSpawn();
  }

  // ---------------------------------------------------------------------------------------------
  // Entry sign (3D prop)
  // ---------------------------------------------------------------------------------------------

  private buildEntrySign(): void {
    if (this.entrySignBuilt) return;
    this.entrySignBuilt = true;
    const pt = this.entryWorldPoint();
    const root = new TransformNode('creator_entry_sign', this.scene);
    root.position.set(pt.x, 0, pt.z);

    const postMat = new StandardMaterial('creator_entry_post', this.scene);
    postMat.diffuseColor = new Color3(0.16, 0.5, 0.7);
    postMat.emissiveColor = new Color3(0.06, 0.2, 0.3);
    const panelMat = new StandardMaterial('creator_entry_panel', this.scene);
    panelMat.diffuseColor = new Color3(0.1, 0.14, 0.22);
    panelMat.emissiveColor = new Color3(0.12, 0.3, 0.5);
    this.entrySignMaterials.push(postMat, panelMat);

    const makeBox = (name: string, w: number, h: number, d: number, x: number, y: number, z: number, mat: StandardMaterial): Mesh => {
      const box = MeshBuilder.CreateBox(name, { width: w, height: h, depth: d }, this.scene);
      box.position.set(x, y, z);
      box.material = mat;
      box.parent = root;
      box.isPickable = false;
      return box;
    };
    makeBox('creator_entry_postL', 0.16, 2.6, 0.16, -0.9, 1.3, 0, postMat);
    makeBox('creator_entry_postR', 0.16, 2.6, 0.16, 0.9, 1.3, 0, postMat);
    makeBox('creator_entry_panel', 2.1, 1.1, 0.12, 0, 2.3, 0, panelMat);
    makeBox('creator_entry_pad', 2.4, 0.08, 1.4, 0, 0.04, 0, postMat);

    this.entrySign = root;
    root.setEnabled(false);
  }
}

const FLY_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ControlLeft', 'ControlRight']);

const MODULE_TYPE_LIST = CREATOR_MODULES.map((m) => m.type as string);
function moduleTypeList(): string[] {
  return MODULE_TYPE_LIST;
}

function normalizeDegrees(value: number): number {
  const n = value % 360;
  return n < 0 ? n + 360 : n;
}

function cloneMetadata(metadata: CreatorObjectMetadata | undefined): CreatorObjectMetadata | undefined {
  if (!metadata) return undefined;
  return {
    ...metadata,
    trigger: metadata.trigger ? { ...metadata.trigger } : undefined
  };
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target.closest('[contenteditable="true"]') !== null;
}
