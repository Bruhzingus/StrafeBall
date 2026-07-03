/**
 * Creator Sandbox — attempt recorder + last-run replay (editor-only, visual-only).
 *
 * A Geometry-Dash-style design aid. DURING playtest the user presses the record key (7) to start
 * capturing their run — position + yaw sampled over time — and 7 again to stop. Back in BUILD the most
 * recent run is shown two ways at once:
 *   1. A bright-green DOTTED PATH (the whole route at a glance) — small spheres drawn as ONE thin-
 *      instanced mesh, spaced by distance so speed doesn't change the dotting.
 *   2. A green capsule GHOST BODY that auto-loops along the run at the real recorded speed, so jumps,
 *      falls, wall-runs and air time all read back exactly (height is never projected to the ground).
 *
 * Strictly local + editor-only: everything lives on its OWN scene node (never the geometry root, so an
 * object edit's rebuild can't touch it), is non-pickable, is never a layout object, and is never
 * saved / exported / collided with. Hidden during playtest; only ever the single newest run is kept.
 */

import { Color3, Matrix, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';

interface ReplaySample {
  x: number;
  y: number;
  z: number;
  yaw: number;
  t: number; // ms since this run's recording started
}

/** Throttle recording so a high refresh rate can't bloat the buffer (~40 Hz is plenty for smooth replay). */
const SAMPLE_MIN_INTERVAL_MS = 25;
/** Hard cap on samples so a very long run can't grow memory / draw without bound (~150 s at 40 Hz). */
const MAX_SAMPLES = 6000;
/** Distance between dotted-path dots (m) — big enough to read as dots, small enough to trace the curve. */
const DOT_MIN_DISTANCE = 0.6;
/** Small, easy-to-see, non-distracting dots. */
const DOT_DIAMETER = 0.16;
/** Ghost capsule sized to a player (matches the remote-player / bot bodies). */
const GHOST_HEIGHT = 1.8;
const GHOST_RADIUS = 0.32;

export class CreatorReplay {
  private readonly root: TransformNode;
  private dotMesh: Mesh | null = null;
  private dotMat: StandardMaterial | null = null;
  private ghost: Mesh | null = null;
  private ghostMat: StandardMaterial | null = null;

  // Run being recorded now, and the most-recent finished run that the trail + ghost are built from.
  private current: ReplaySample[] = [];
  private lastRun: ReplaySample[] = [];

  private recording = false;
  private recordStartMs = 0;
  private lastSampleMs = 0;

  private inBuild = false; // Build mode is showing (playtest hides the replay)
  private enabled = true; // "Show Replay" toggle
  private playhead = 0; // ms into the looping playback
  private playIndex = 0; // cursor into lastRun for the current playhead (monotonic within a loop)

  constructor(private readonly scene: Scene) {
    this.root = new TransformNode('creator_replay_root', scene);
    this.root.setEnabled(false);
  }

  // ---------------------------------------------------------------------------------------------
  // Recording (playtest)
  // ---------------------------------------------------------------------------------------------

  isRecording(): boolean {
    return this.recording;
  }

  /** Elapsed recording time in seconds (for the HUD), or null when not recording. */
  recordingSeconds(): number | null {
    if (!this.recording) return null;
    return (performance.now() - this.recordStartMs) / 1000;
  }

  /** Record key (7) pressed during playtest: start a fresh run, or stop + save the current one. */
  toggleRecording(position: Vector3, yaw: number): void {
    if (this.recording) this.stopRecording();
    else this.startRecording(position, yaw);
  }

  private startRecording(position: Vector3, yaw: number): void {
    this.recording = true;
    this.recordStartMs = performance.now();
    this.lastSampleMs = 0;
    this.current = [];
    this.pushSample(position, yaw, 0);
  }

  private stopRecording(): void {
    if (!this.recording) return;
    this.recording = false;
    if (this.current.length > 1) {
      this.lastRun = this.current;
      this.playhead = 0;
      this.playIndex = 0;
      this.rebuildTrail();
    }
    this.current = [];
    this.applyVisibility();
  }

  /** Sample the player's pose (call each playtest frame while recording). Time-throttled + capped. */
  record(position: Vector3, yaw: number): void {
    if (!this.recording || this.current.length >= MAX_SAMPLES) return;
    const t = performance.now() - this.recordStartMs;
    if (t - this.lastSampleMs < SAMPLE_MIN_INTERVAL_MS) return;
    this.pushSample(position, yaw, t);
  }

  private pushSample(position: Vector3, yaw: number, t: number): void {
    this.current.push({ x: position.x, y: position.y, z: position.z, yaw, t });
    this.lastSampleMs = t;
  }

  // ---------------------------------------------------------------------------------------------
  // Mode + visibility
  // ---------------------------------------------------------------------------------------------

  /** Entering playtest: hide the replay (never shown while playing). Recording starts on the 7 key. */
  onEnterPlaytest(): void {
    this.inBuild = false;
    this.applyVisibility();
  }

  /** Returning to Build: stop + save any in-progress recording, then show the newest run. */
  onEnterBuild(): void {
    if (this.recording) this.stopRecording();
    this.inBuild = true;
    this.playhead = 0;
    this.playIndex = 0;
    this.applyVisibility();
  }

  /** Editor teardown / going online: hide without discarding the stored run. */
  hide(): void {
    this.recording = false;
    this.inBuild = false;
    this.applyVisibility();
  }

  /** "Show Replay" toggle. Keeps the stored run; only changes whether it's drawn. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.applyVisibility();
  }

  private applyVisibility(): void {
    this.root.setEnabled(this.enabled && this.inBuild && this.lastRun.length > 1);
  }

  // ---------------------------------------------------------------------------------------------
  // Playback (build) — advance the ghost along the recorded run, looping in real time
  // ---------------------------------------------------------------------------------------------

  update(dt: number): void {
    if (!this.enabled || !this.inBuild || this.lastRun.length < 2 || !this.ghost) return;
    const run = this.lastRun;
    const startT = run[0].t;
    const duration = run[run.length - 1].t - startT;
    if (duration <= 0) {
      this.placeGhost(run[0], run[0], 0);
      return;
    }
    this.playhead += dt * 1000;
    if (this.playhead >= duration) {
      this.playhead %= duration;
      this.playIndex = 0; // wrapped back to the start of the loop
    }
    const target = startT + this.playhead;
    while (this.playIndex < run.length - 2 && run[this.playIndex + 1].t <= target) this.playIndex += 1;
    const a = run[this.playIndex];
    const b = run[this.playIndex + 1] ?? a;
    const span = b.t - a.t;
    const f = span > 0 ? Math.min(1, Math.max(0, (target - a.t) / span)) : 0;
    this.placeGhost(a, b, f);
  }

  private placeGhost(a: ReplaySample, b: ReplaySample, f: number): void {
    if (!this.ghost) return;
    const x = a.x + (b.x - a.x) * f;
    const y = a.y + (b.y - a.y) * f;
    const z = a.z + (b.z - a.z) * f;
    // Sample position is the player's FEET (camera sits 1.58 m above root); lift the capsule to its centre.
    this.ghost.position.set(x, y + GHOST_HEIGHT / 2, z);
    this.ghost.rotation.y = lerpAngle(a.yaw, b.yaw, f);
  }

  // ---------------------------------------------------------------------------------------------
  // Mesh build
  // ---------------------------------------------------------------------------------------------

  private rebuildTrail(): void {
    this.ensureMeshes();
    const dots = this.buildDotPositions();
    const matrices = new Float32Array(dots.length * 16);
    for (let i = 0; i < dots.length; i += 1) {
      Matrix.Translation(dots[i].x, dots[i].y, dots[i].z).copyToArray(matrices, i * 16);
    }
    this.dotMesh!.thinInstanceSetBuffer('matrix', matrices, 16, true);
    // Enclose every instance so the trail isn't frustum-culled when the base origin is off-screen.
    this.dotMesh!.thinInstanceRefreshBoundingInfo(true);
  }

  /** Distance-walk the samples, dropping a dot every DOT_MIN_DISTANCE so spacing is even at any speed. */
  private buildDotPositions(): Vector3[] {
    const out: Vector3[] = [];
    const run = this.lastRun;
    if (run.length === 0) return out;
    let acc = DOT_MIN_DISTANCE; // emit the very first point
    let px = run[0].x;
    let py = run[0].y;
    let pz = run[0].z;
    for (const s of run) {
      acc += Math.hypot(s.x - px, s.y - py, s.z - pz);
      px = s.x;
      py = s.y;
      pz = s.z;
      if (acc >= DOT_MIN_DISTANCE) {
        out.push(new Vector3(s.x, s.y, s.z));
        acc = 0;
      }
    }
    return out;
  }

  private ensureMeshes(): void {
    if (this.dotMesh && this.ghost) return;

    const green = new Color3(0.15, 1.0, 0.28);

    if (!this.dotMesh) {
      const mat = new StandardMaterial('creator_replay_dot_mat', this.scene);
      mat.emissiveColor = green;
      mat.diffuseColor = new Color3(0, 0, 0);
      mat.specularColor = new Color3(0, 0, 0);
      mat.disableLighting = true;
      this.dotMat = mat;
      const dot = MeshBuilder.CreateSphere('creator_replay_dot', { diameter: DOT_DIAMETER, segments: 6 }, this.scene);
      dot.material = mat;
      dot.isPickable = false;
      dot.parent = this.root;
      this.dotMesh = dot;
    }

    if (!this.ghost) {
      const mat = new StandardMaterial('creator_replay_ghost_mat', this.scene);
      mat.emissiveColor = new Color3(0.1, 0.75, 0.22);
      mat.diffuseColor = new Color3(0.05, 0.3, 0.1);
      mat.specularColor = new Color3(0, 0, 0);
      mat.alpha = 0.5; // translucent so it reads as a ghost, not a solid actor
      this.ghostMat = mat;
      const ghost = MeshBuilder.CreateCapsule('creator_replay_ghost', { height: GHOST_HEIGHT, radius: GHOST_RADIUS, tessellation: 10 }, this.scene);
      ghost.material = mat;
      ghost.isPickable = false;
      ghost.parent = this.root;
      this.ghost = ghost;
    }
  }

  dispose(): void {
    this.dotMesh?.dispose();
    this.ghost?.dispose();
    this.dotMat?.dispose();
    this.ghostMat?.dispose();
    this.root.dispose();
    this.dotMesh = null;
    this.ghost = null;
    this.dotMat = null;
    this.ghostMat = null;
    this.current = [];
    this.lastRun = [];
  }
}

/** Interpolate between two yaw angles along the shortest arc. */
function lerpAngle(a: number, b: number, f: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * f;
}
