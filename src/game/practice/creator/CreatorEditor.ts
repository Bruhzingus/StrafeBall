/**
 * Creator Sandbox — editor orchestrator.
 *
 * Owns the whole developer-only movement-course editor: access gate, layout state + history,
 * geometry, the offline movement world + collision used in Playtest, the free-fly Build camera, the
 * editor input handling, Babylon gizmos, and the DOM UI. It is strictly offline/practice-only and
 * fully self-contained: ArenaScene only routes entry, the per-frame step, and the online lockout.
 *
 * Lifecycle:
 *   locked  → (correct password) → unlocked + active in BUILD mode
 *   BUILD  ↔ PLAYTEST  (free toggle within an unlocked session, no re-prompt)
 *   exit / lock / going online  → torn down, sandbox restored, access re-locked
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
  CREATOR_MODULES,
  CreatorLayout,
  CreatorLayoutObject,
  CreatorObjectMetadata,
  cloneLayout,
  committedCourseLayout,
  createObjectId,
  enforceSingleDefaultSpawn,
  isLayoutValid,
  layoutSpawn,
  moduleDef,
  objectDimensions,
  objectWorldAabb,
  scaleForDimensions,
  type Vec3Tuple
} from './CreatorLayout';
import { CreatorWorld, buildCreatorCollisionBoxes } from './CreatorWorld';
import { CreatorGeometry } from './CreatorGeometry';
import { CreatorHistory } from './CreatorHistory';
import { CreatorAccessLatch, isCreatorConfigured, verifyCreatorPassword } from './CreatorAccess';
import { CreatorBridge, CreatorSnapSettings, CreatorUI } from './CreatorUI';
import {
  exportLayoutToFile,
  importLayoutFromFile,
  loadLocalLayout,
  saveAutosave,
  saveLocalLayout
} from './CreatorStorage';

const COLLISION_ID_PREFIX = 'creator_';
const FLY_BASE_SPEED = 20;
const FLY_SPRINT = 3;
const LOOK_SENSITIVITY = 0.0024;
const PITCH_LIMIT = 1.52;

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
}

type Mode = 'build' | 'playtest';

export class CreatorEditor implements CreatorBridge {
  private active = false;
  private mode: Mode = 'build';

  private layout: CreatorLayout;
  private readonly history: CreatorHistory;
  private readonly access = new CreatorAccessLatch();
  private readonly geometry: CreatorGeometry;
  private readonly world: CreatorWorld;
  private readonly ui: CreatorUI;

  private editorCamera: FreeCamera | null = null;
  private gizmoManager: GizmoManager | null = null;
  private creatorCollisionBoxes: AABB[] = [];
  private worldInstalled = false;

  private selectedId: string | null = null;
  private armedModule: string | null = null;

  private readonly snap: CreatorSnapSettings = {
    gridSnap: true,
    gridSize: 1,
    rotationSnapDeg: 15,
    scaleSnap: 0.25,
    showGrid: true,
    showTriggers: true,
    showCollision: false,
    gizmo: 'move'
  };

  // Build-mode fly camera state.
  private readonly flyKeys = new Set<string>();
  private camYaw = 0;
  private camPitch = 0.45;

  // Pointer/gizmo interaction state.
  private looking = false;
  private lookMoved = 0;
  private gizmoDragging = false;
  private ignoreClickUntilMs = 0;

  // Entry sign (3D prop near the sandbox spawn while creator is locked).
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

  constructor(
    private readonly scene: Scene,
    private readonly gym: GymArena,
    private readonly player: PlayerController,
    private readonly input: InputManager,
    private readonly hooks: CreatorEditorHooks
  ) {
    this.layout = loadLocalLayout() ?? committedCourseLayout();
    this.history = new CreatorHistory(this.layout);
    this.geometry = new CreatorGeometry(scene);
    this.geometry.setEnabled(false);
    this.world = new CreatorWorld(this.layout);
    const hud = document.getElementById('hud-root');
    this.ui = new CreatorUI(hud ?? document.body, this);
  }

  // ---------------------------------------------------------------------------------------------
  // Public API used by ArenaScene
  // ---------------------------------------------------------------------------------------------

  isActive(): boolean {
    return this.active;
  }

  /** Active editor session OR an open password modal — i.e. the creator owns the screen + input. */
  isBusy(): boolean {
    return this.active || this.ui.isModalOpen();
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
    if (this.active || this.ui.isModalOpen()) {
      this.ui.setEntryPromptVisible(false, 0);
      return;
    }
    this.ui.setEntryPromptVisible(near, progress);
  }

  /** Open the password gate (called on a completed hold-E at the entry sign). */
  promptUnlock(): void {
    if (this.active || this.hooks.isOnline()) return;
    if (this.ui.isModalOpen()) return;
    if (!isCreatorConfigured()) {
      this.ui.toast('Creator access is not configured.');
      return;
    }
    this.input.setLockSuppressed(true);
    this.ui.openPasswordModal(
      (value) => {
        void this.tryUnlock(value);
      },
      () => {
        if (!this.active) this.input.setLockSuppressed(false);
      }
    );
  }

  private async tryUnlock(value: string): Promise<void> {
    const result = await verifyCreatorPassword(value);
    if (this.hooks.isOnline()) {
      this.ui.closePasswordModal();
      this.input.setLockSuppressed(false);
      return;
    }
    if (result === 'granted') {
      this.access.unlock();
      this.ui.closePasswordModal();
      this.enter();
    } else if (result === 'denied') {
      this.ui.setModalMessage('Access denied');
    } else {
      this.ui.setModalMessage('Creator access is not configured.');
    }
  }

  /** Per-frame update while active. Build: fly camera. Playtest: handled by ArenaScene (player). */
  step(dt: number): void {
    if (!this.active) return;
    if (this.mode === 'build') this.updateFlyCamera(dt);
  }

  /** Hard shutdown for going online: tears down with no sandbox restore (the online path handles it). */
  forceDeactivate(): void {
    if (!this.active) {
      this.ui.closePasswordModal();
      if (!this.hooks.isOnline()) this.input.setLockSuppressed(false);
      return;
    }
    this.teardownActive(false);
    this.access.lock();
  }

  dispose(): void {
    this.removeListeners();
    this.gizmoManager?.dispose();
    this.gizmoManager = null;
    this.geometry.dispose();
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
    this.hooks.suspendSandbox();
    this.hooks.setHudVisible(false);

    this.geometry.setEnabled(true);
    this.geometry.rebuild(this.layout);
    this.geometry.setGridVisible(this.snap.showGrid);
    this.geometry.setTriggersVisible(this.snap.showTriggers);
    this.geometry.setCollisionVisible(this.snap.showCollision);

    this.ensureEditorCamera();
    this.positionEditorCameraAtSpawn();
    this.enterBuildMode();
    this.ui.setToolbarVisible(true);
    this.ui.toast('Creator Mode unlocked — Build Mode');
    this.ui.refresh();
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
    this.mode = 'build';
    this.uninstallWorldAndCollision();
    this.player.movement.setWorld(null);
    this.input.setLockSuppressed(true);
    this.addListeners();
    this.ensureEditorCamera();
    this.scene.activeCamera = this.editorCamera;
    this.geometry.setOverlaysEnabled(true);
    this.applyGizmoMode();
    this.refreshSelectionVisual();
  }

  private enterPlaytestMode(): void {
    this.mode = 'playtest';
    this.removeListeners();
    this.detachGizmo();
    this.geometry.setOverlaysEnabled(false);
    // Install the editable layout's collision + movement world for real movement.
    this.installWorldAndCollision();
    this.scene.activeCamera = this.player.camera;
    this.input.setLockSuppressed(false);
    const spawn = layoutSpawn(this.layout);
    this.player.hands.clearHands();
    this.player.setRespawn(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw);
    this.player.teleportTo(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw, 0);
    this.ui.toast('Playtest Mode — F1 to return to Build');
  }

  exitCreator(): void {
    if (!this.active) return;
    this.teardownActive(true);
    this.ui.toast('Exited Creator Mode');
  }

  lockCreator(): void {
    if (!this.active) {
      this.access.lock();
      return;
    }
    this.teardownActive(true);
    this.access.lock();
    this.ui.toast('Creator Mode locked');
  }

  private teardownActive(restoreSandbox: boolean): void {
    this.removeListeners();
    this.detachGizmo();
    this.uninstallWorldAndCollision();
    this.geometry.setOverlaysEnabled(false);
    this.geometry.setEnabled(false);
    this.ui.setToolbarVisible(false);
    this.ui.setEntryPromptVisible(false, 0);
    this.ui.closePasswordModal();
    this.flyKeys.clear();
    this.looking = false;
    if (document.pointerLockElement === this.canvas()) document.exitPointerLock?.();

    this.scene.activeCamera = this.player.camera;
    this.player.movement.setWorld(null);
    this.hooks.setHudVisible(true);
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
    cam.maxZ = 4000;
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
    const moveX = (this.flyKeys.has('KeyD') ? 1 : 0) - (this.flyKeys.has('KeyA') ? 1 : 0);
    const moveZ = (this.flyKeys.has('KeyW') ? 1 : 0) - (this.flyKeys.has('KeyS') ? 1 : 0);
    const moveY = (this.flyKeys.has('Space') ? 1 : 0) - (this.flyKeys.has('ControlLeft') || this.flyKeys.has('ControlRight') ? 1 : 0);
    const speed = FLY_BASE_SPEED * (this.flyKeys.has('ShiftLeft') ? FLY_SPRINT : 1);

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
    cam.position.y = Math.max(-8, Math.min(160, cam.position.y));
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
    this.flyKeys.clear();
    this.looking = false;
    this.setCanvasCursor('');
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (this.ui.isModalOpen() || isEditableTarget(e.target)) return;
    const code = e.code;

    // Held fly keys.
    if (FLY_CODES.has(code)) {
      this.flyKeys.add(code);
      e.preventDefault();
      return;
    }

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
    if (e.ctrlKey && code === 'KeyD') {
      e.preventDefault();
      this.duplicateSelected();
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
    if (!this.armedModule) return;
    e.preventDefault();
    const types = moduleTypeList();
    const idx = types.indexOf(this.armedModule);
    if (idx < 0) return;
    const next = types[(idx + (e.deltaY > 0 ? 1 : types.length - 1)) % types.length];
    this.armModule(next);
    this.ui.refresh();
  }

  private handleLeftClick(e: PointerEvent): void {
    const canvas = this.canvas();
    if (!canvas || !this.editorCamera) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const pick = this.pickWorld(x, y);
    if (this.armedModule) {
      if (pick) this.placeModule(this.armedModule, pick.point);
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
    this.refreshSelectionVisual();
    this.ui.refresh();
  }

  private refreshSelectionVisual(): void {
    const obj = this.getSelectedObject();
    this.geometry.setSelection(this.mode === 'build' ? obj : null);
    if (this.mode === 'build') this.reattachGizmo();
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
    if (!obj || this.snap.gizmo === 'off' || this.mode !== 'build') {
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
    obj.position = [node.position.x, node.position.y, node.position.z];
    const euler = node.rotationQuaternion ? node.rotationQuaternion.toEulerAngles() : node.rotation;
    const rad2deg = 180 / Math.PI;
    obj.rotation = [euler.x * rad2deg, euler.y * rad2deg, euler.z * rad2deg];
    obj.scale = [node.scaling.x, node.scaling.y, node.scaling.z];
    this.commit(obj.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Layout edits
  // ---------------------------------------------------------------------------------------------

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

  private placeModule(type: string, point: Vector3): void {
    const def = moduleDef(type);
    if (!def) return;
    if (this.layout.objects.length >= 400) {
      this.ui.toast('Object limit reached (400).');
      return;
    }
    const obj: CreatorLayoutObject = {
      id: createObjectId(type),
      type: def.type,
      position: [this.snapValue(point.x), Math.max(this.layout.ground.bounds.y ?? 0, point.y), this.snapValue(point.z)],
      rotation: [0, def.defaultRotationY ?? 0, 0],
      scale: [1, 1, 1],
      material: def.material,
      collision: def.collision,
      visible: true,
      metadata: def.defaultMetadata ? { ...def.defaultMetadata } : undefined
    };
    this.layout.objects.push(obj);
    this.selectedId = obj.id;
    this.commit(obj.id);
  }

  duplicateSelected(): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    if (this.layout.objects.length >= 400) {
      this.ui.toast('Object limit reached (400).');
      return;
    }
    const copy: CreatorLayoutObject = cloneLayout({ version: 0, name: '', updatedAt: '', ground: this.layout.ground, objects: [obj] }).objects[0];
    copy.id = createObjectId(obj.type);
    copy.position = [obj.position[0] + Math.max(2, this.snap.gridSize), obj.position[1], obj.position[2] + Math.max(2, this.snap.gridSize)];
    if (copy.type === 'spawn_point' && copy.metadata) copy.metadata.defaultSpawn = false;
    this.layout.objects.push(copy);
    this.selectedId = copy.id;
    this.commit(copy.id);
  }

  deleteSelected(): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    this.layout.objects = this.layout.objects.filter((o) => o.id !== obj.id);
    this.selectedId = null;
    this.commit(null);
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
    if (!obj || !Number.isFinite(value) || value <= 0) return;
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

  setSelectedCollision(value: boolean): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.collision = value;
    this.commit(obj.id);
  }

  setSelectedVisible(value: boolean): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.visible = value;
    this.commit(obj.id);
  }

  setSelectedMetadata(patch: Partial<CreatorObjectMetadata>): void {
    const obj = this.getSelectedObject();
    if (!obj) return;
    obj.metadata = { ...(obj.metadata ?? {}), ...patch };
    this.commit(obj.id);
  }

  // ---------------------------------------------------------------------------------------------
  // Palette
  // ---------------------------------------------------------------------------------------------

  armModule(type: string | null): void {
    this.armedModule = type && moduleDef(type) ? type : null;
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
    Object.assign(this.snap, patch);
    if (patch.showGrid !== undefined) this.geometry.setGridVisible(this.snap.showGrid);
    if (patch.showTriggers !== undefined) this.geometry.setTriggersVisible(this.snap.showTriggers);
    if (patch.showCollision !== undefined) this.geometry.setCollisionVisible(this.snap.showCollision);
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
    this.rebuildAfterChange();
    saveAutosave(this.layout);
  }

  /** Replace the whole layout (undo/redo/load/import/reset). `record` adds a history entry. */
  private applyLayout(layout: CreatorLayout, record: boolean): void {
    this.layout = layout;
    enforceSingleDefaultSpawn(this.layout);
    if (record) this.history.commit(this.layout);
    if (this.selectedId && !this.findObject(this.selectedId)) this.selectedId = null;
    this.rebuildAfterChange();
    saveAutosave(this.layout);
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
    const ok = saveLocalLayout(this.layout);
    this.ui.toast(ok ? 'Saved to local storage' : 'Save failed — storage unavailable');
  }

  quickLoad(): void {
    const loaded = loadLocalLayout();
    if (!loaded) {
      this.ui.toast('No local save found');
      return;
    }
    if (!window.confirm('Load the last local save? Unsaved changes will be lost.')) return;
    this.selectedId = null;
    this.applyLayout(loaded, true);
    this.ui.toast('Loaded local save');
  }

  exportJson(): void {
    const check = isLayoutValid(this.layout);
    if (!check.valid) this.ui.toast(`Exported (note: ${check.reason})`);
    else this.ui.toast('Exported layout JSON');
    exportLayoutToFile(this.layout);
  }

  importJsonFile(file: File): void {
    if (!window.confirm('Importing replaces the current unsaved layout. Continue?')) return;
    importLayoutFromFile(file)
      .then(({ layout, problems }) => {
        this.selectedId = null;
        this.applyLayout(layout, true);
        this.ui.toast(problems.length ? `Imported with ${problems.length} fix(es)` : 'Imported layout JSON');
      })
      .catch((err: Error) => this.ui.toast(err.message || 'Invalid layout file'));
  }

  resetLayout(): void {
    if (!window.confirm('Reset to the committed Movement Sandbox layout? Unsaved changes will be lost.')) return;
    this.selectedId = null;
    this.applyLayout(committedCourseLayout(), true);
    this.ui.toast('Layout reset to committed layout');
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
    const spawn = layoutSpawn(this.layout);
    this.player.teleportTo(new Vector3(spawn.x, spawn.y, spawn.z), spawn.yaw, 0);
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  return target.closest('[contenteditable="true"]') !== null;
}
