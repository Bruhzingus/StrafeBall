/**
 * Creator Sandbox — timed course run controller (offline only).
 *
 * Consumes the layout's trigger markers (start_pad / checkpoint_gate / finish_gate metadata
 * triggerType 'start' | 'checkpoint' | 'finish') and turns them into a speedrun: crossing the start
 * volume starts the timer, checkpoints must be crossed IN ORDER (metadata.checkpointOrder, then
 * layout order as the tiebreak), and crossing the finish with every checkpoint collected stops the
 * clock. Runs identically in creator Playtest and the live Movement Sandbox.
 *
 * Design notes:
 *   - CourseRunState is a PURE state machine (no Babylon, no DOM, explicit nowMs) — unit-tested.
 *   - CourseRunTracker adds edge-triggered volume crossing (enter events, not while-inside) on top,
 *     using the shared oriented trigger test from CreatorPads.
 *   - Layouts with no start OR no finish gate produce an INERT tracker: zero behavior change for
 *     pure free-practice layouts.
 *   - A local Top-10 + last time persist per LAYOUT CONTENT (an FNV-1a hash of objects + ground):
 *     editing the route starts a fresh board, while renames/timestamps don't.
 *   - Dying to a kill block mid-run resets the run (the checkpoint respawn itself stays, unchanged).
 *
 * Never read by the server, shared simulation, prediction, or networking.
 */

import { CreatorLayout, CreatorLayoutObject } from './CreatorLayout';
import { insideObjectTrigger, segmentCrossesObjectTrigger } from './CreatorPads';

export type CourseRunPhase = 'idle' | 'running' | 'finished';

export interface CourseGates {
  start: CreatorLayoutObject | null;
  checkpoints: CreatorLayoutObject[]; // in required crossing order
  finish: CreatorLayoutObject | null;
}

/** Extract the course gates from a layout. Pure; exported for tests. */
export function extractCourseGates(layout: CreatorLayout): CourseGates {
  let start: CreatorLayoutObject | null = null;
  let finish: CreatorLayoutObject | null = null;
  const checkpoints: Array<{ obj: CreatorLayoutObject; order: number; index: number }> = [];
  layout.objects.forEach((o, index) => {
    const t = o.metadata?.triggerType;
    if (t === 'start' && !start) start = o;
    else if (t === 'finish' && !finish) finish = o;
    else if (t === 'checkpoint') {
      const order = typeof o.metadata?.checkpointOrder === 'number' ? o.metadata.checkpointOrder : Number.MAX_SAFE_INTEGER;
      checkpoints.push({ obj: o, order, index });
    }
  });
  checkpoints.sort((a, b) => a.order - b.order || a.index - b.index);
  return { start, checkpoints: checkpoints.map((c) => c.obj), finish };
}

/** A layout is a timed course only when it has BOTH a start and a finish gate. */
export function isTimedCourse(gates: CourseGates): boolean {
  return gates.start !== null && gates.finish !== null;
}

export type CheckpointResult = 'progress' | 'skip' | 'repeat' | 'inactive';
export type FinishResult = { ok: true; timeMs: number } | { ok: false; missedCheckpoint: number } | null;

/** Pure run state machine. All times are explicit ms so tests never depend on wall clocks. */
export class CourseRunState {
  phase: CourseRunPhase = 'idle';
  startedAtMs = 0;
  finishedTimeMs: number | null = null;
  /** Index of the NEXT checkpoint that must be crossed. */
  nextCheckpoint = 0;
  /** 1-based number of the first checkpoint that was skipped, or null while the run is clean. */
  missedCheckpoint: number | null = null;
  /** Elapsed ms at each collected checkpoint (splits), in order. */
  readonly splits: number[] = [];

  constructor(readonly checkpointCount: number) {}

  /** Crossing the start (re)arms a fresh attempt — restarting mid-run is a new attempt. */
  start(nowMs: number): void {
    this.phase = 'running';
    this.startedAtMs = nowMs;
    this.finishedTimeMs = null;
    this.nextCheckpoint = 0;
    this.missedCheckpoint = null;
    this.splits.length = 0;
  }

  elapsedMs(nowMs: number): number {
    if (this.phase === 'running') return Math.max(0, nowMs - this.startedAtMs);
    return this.finishedTimeMs ?? 0;
  }

  hitCheckpoint(index: number, nowMs: number): CheckpointResult {
    if (this.phase !== 'running') return 'inactive';
    if (index < this.nextCheckpoint) return 'repeat'; // re-crossing an already-collected gate
    if (index > this.nextCheckpoint) {
      // Skipped one or more gates: remember the FIRST miss; the finish will refuse.
      if (this.missedCheckpoint === null) this.missedCheckpoint = this.nextCheckpoint + 1;
      return 'skip';
    }
    this.splits.push(this.elapsedMs(nowMs));
    this.nextCheckpoint += 1;
    return 'progress';
  }

  finish(nowMs: number): FinishResult {
    if (this.phase !== 'running') return null;
    if (this.missedCheckpoint !== null || this.nextCheckpoint < this.checkpointCount) {
      return { ok: false, missedCheckpoint: this.missedCheckpoint ?? this.nextCheckpoint + 1 };
    }
    this.finishedTimeMs = this.elapsedMs(nowMs);
    this.phase = 'finished';
    return { ok: true, timeMs: this.finishedTimeMs };
  }

  /** Cancel/reset the attempt (leave, K reset, kill-block death, mode change). */
  cancel(): void {
    this.phase = 'idle';
    this.finishedTimeMs = null;
    this.nextCheckpoint = 0;
    this.missedCheckpoint = null;
    this.splits.length = 0;
  }
}

// --- Per-layout local leaderboard persistence ----------------------------------------------------

const TIMES_KEY_PREFIX = 'strafeball:creator-course-times:v1';

/** FNV-1a 32-bit hash of the layout's CONTENT (objects + ground) — name/updatedAt excluded so a
 *  rename or autosave timestamp never invalidates bests, while any real course edit does. */
export function courseContentHash(layout: CreatorLayout): string {
  const content = JSON.stringify({ objects: layout.objects, ground: layout.ground });
  let hash = 0x811c9dc5;
  for (let i = 0; i < content.length; i += 1) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface CourseTimes {
  bestMs: number | null;
  lastMs: number | null;
  /** Fastest local finishes for this exact course content, ascending (browser-local only). */
  records: number[];
}

export const COURSE_LOCAL_LEADERBOARD_SIZE = 10;

function validCourseTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 24 * 60 * 60 * 1000;
}

function sortCourseRecords(values: readonly unknown[]): number[] {
  return values.filter(validCourseTime).sort((a, b) => a - b).slice(0, COURSE_LOCAL_LEADERBOARD_SIZE);
}

export function loadCourseTimes(hash: string): CourseTimes {
  try {
    const raw = window.localStorage.getItem(`${TIMES_KEY_PREFIX}:${hash}`);
    if (!raw) return { bestMs: null, lastMs: null, records: [] };
    const parsed = JSON.parse(raw) as Partial<CourseTimes> | null;
    const bestMs = validCourseTime(parsed?.bestMs) ? parsed.bestMs : null;
    const lastMs = validCourseTime(parsed?.lastMs) ? parsed.lastMs : null;
    // v1 initially stored only best/last. Seed its best into the new board so upgrading never drops
    // the player's record; subsequent finishes naturally build out the Top 10.
    const records = sortCourseRecords(Array.isArray(parsed?.records) ? parsed.records : bestMs !== null ? [bestMs] : []);
    return { bestMs: records[0] ?? bestMs, lastMs, records };
  } catch {
    return { bestMs: null, lastMs: null, records: [] };
  }
}

export function saveCourseTimes(hash: string, times: CourseTimes): void {
  try {
    window.localStorage.setItem(`${TIMES_KEY_PREFIX}:${hash}`, JSON.stringify(times));
  } catch {
    // Storage unavailable/full — times just don't persist this session.
  }
}

// --- Host-facing tracker --------------------------------------------------------------------------

export interface CourseRunListener {
  onRunStart(): void;
  onCheckpoint(collected: number, total: number, splitMs: number): void;
  onMissedCheckpoint(checkpointNumber: number): void;
  onFinish(
    timeMs: number,
    bestMs: number | null,
    isPersonalBest: boolean,
    placement: number | null,
    records: readonly number[]
  ): void;
  onRunReset(reason: 'death' | 'reset' | 'leave'): void;
}

/**
 * Edge-triggered gate crossing + persistence on top of CourseRunState. The host calls update() every
 * frame AFTER the player moved (same phase as CreatorPads), with the player position and whether a
 * kill block killed the player this frame. Inert (update is a cheap early-out) for non-timed layouts.
 */
export class CourseRunTracker {
  readonly gates: CourseGates;
  readonly state: CourseRunState;
  private readonly hash: string;
  private times: CourseTimes;
  private insideStart = false;
  private insideFinish = false;
  private readonly insideCheckpoint: boolean[];
  private readonly missAnnounced = new Set<number>();
  private previousPosition: { x: number; y: number; z: number } | null = null;

  constructor(private readonly layout: CreatorLayout, private readonly listener: CourseRunListener) {
    this.gates = extractCourseGates(layout);
    this.state = new CourseRunState(this.gates.checkpoints.length);
    this.insideCheckpoint = this.gates.checkpoints.map(() => false);
    this.hash = courseContentHash(layout);
    this.times = loadCourseTimes(this.hash);
  }

  isTimed(): boolean {
    return isTimedCourse(this.gates);
  }

  bestMs(): number | null {
    return this.times.bestMs;
  }

  localRecords(): readonly number[] {
    return this.times.records;
  }

  /** Per-frame. `radius` = the player's collision radius (matches the pad runtime's slack). */
  update(nowMs: number, px: number, py: number, pz: number, radius: number, killedThisFrame: boolean): void {
    if (!this.isTimed()) return;

    if (killedThisFrame && this.state.phase === 'running') {
      this.reset('death');
      // The kill respawn teleported the player; recompute inside flags from the new position below.
    }

    // Start gate: entering it starts (or restarts) an attempt.
    const position = { x: px, y: py, z: pz };
    const crossed = (gate: CreatorLayoutObject, inside: boolean) =>
      !inside && (
        insideObjectTrigger(gate, px, py, pz, radius) ||
        (this.previousPosition !== null && segmentCrossesObjectTrigger(gate, this.previousPosition, position, radius))
      );

    const inStart = insideObjectTrigger(this.gates.start!, px, py, pz, radius);
    if (crossed(this.gates.start!, this.insideStart)) {
      this.state.start(nowMs);
      this.missAnnounced.clear();
      this.listener.onRunStart();
    }
    this.insideStart = inStart;

    // Checkpoints (edge-triggered, in order).
    for (let i = 0; i < this.gates.checkpoints.length; i += 1) {
      const inside = insideObjectTrigger(this.gates.checkpoints[i], px, py, pz, radius);
      if (crossed(this.gates.checkpoints[i], this.insideCheckpoint[i])) {
        const result = this.state.hitCheckpoint(i, nowMs);
        if (result === 'progress') {
          this.listener.onCheckpoint(this.state.nextCheckpoint, this.state.checkpointCount, this.state.splits[this.state.splits.length - 1]);
        } else if (result === 'skip' && this.state.missedCheckpoint !== null && !this.missAnnounced.has(this.state.missedCheckpoint)) {
          this.missAnnounced.add(this.state.missedCheckpoint);
          this.listener.onMissedCheckpoint(this.state.missedCheckpoint);
        }
      }
      this.insideCheckpoint[i] = inside;
    }

    // Finish gate.
    const inFinish = insideObjectTrigger(this.gates.finish!, px, py, pz, radius);
    if (crossed(this.gates.finish!, this.insideFinish)) {
      const result = this.state.finish(nowMs);
      if (result) {
        if (result.ok) {
          if (!validCourseTime(result.timeMs)) {
            // Overlapping start/finish volumes can complete on the same timestamp. Let the visual
            // run finish, but never poison this session's board (reload validation uses same rule).
            this.listener.onFinish(result.timeMs, this.times.bestMs, false, null, this.times.records);
            this.previousPosition = position;
            return;
          }
          const isPb = this.times.bestMs === null || result.timeMs < this.times.bestMs;
          // Wrap the submitted time so equal values still identify the newly-added entry reliably.
          const submitted = { timeMs: result.timeMs, submitted: true };
          const ranked = [
            ...this.times.records.map((timeMs) => ({ timeMs, submitted: false })),
            submitted
          ].sort((a, b) => a.timeMs - b.timeMs || Number(a.submitted) - Number(b.submitted));
          const placementIndex = ranked.indexOf(submitted);
          const records = ranked.slice(0, COURSE_LOCAL_LEADERBOARD_SIZE).map((entry) => entry.timeMs);
          const placement = placementIndex < COURSE_LOCAL_LEADERBOARD_SIZE ? placementIndex + 1 : null;
          this.times = { bestMs: records[0] ?? result.timeMs, lastMs: result.timeMs, records };
          saveCourseTimes(this.hash, this.times);
          this.listener.onFinish(result.timeMs, this.times.bestMs, isPb, placement, records);
        } else if (!this.missAnnounced.has(result.missedCheckpoint)) {
          this.missAnnounced.add(result.missedCheckpoint);
          this.listener.onMissedCheckpoint(result.missedCheckpoint);
        }
      }
    }
    this.insideFinish = inFinish;
    this.previousPosition = position;
  }

  /**
   * Forget only the swept-from position, so this frame's gate sweep doesn't span a teleport. A
   * trigger-volume teleport is a shortcut, not a death: the run stays live (unlike reset()), but the
   * pre-jump → post-jump segment must not be dragged through a start/checkpoint/finish gate it never
   * physically crossed. The point-inside test still fires if the teleport lands INSIDE a gate — that
   * is a real touch, and course authors may use it deliberately.
   */
  clearSweep(): void {
    this.previousPosition = null;
  }

  /** Cancel a live attempt (K reset / kill death / leaving the yard / exiting playtest). */
  reset(reason: 'death' | 'reset' | 'leave'): void {
    const wasRunning = this.state.phase === 'running';
    this.state.cancel();
    this.insideStart = false;
    this.insideFinish = false;
    this.insideCheckpoint.fill(false);
    this.missAnnounced.clear();
    this.previousPosition = null;
    if (wasRunning) this.listener.onRunReset(reason);
  }
}
