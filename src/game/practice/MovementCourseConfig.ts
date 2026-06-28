import { Vector3 } from '@babylonjs/core';

/**
 * Local Movement Course — data-driven layout & tuning.
 *
 * Everything here is local/offline-only. No part of this file is read by the online step path,
 * the server, shared simulation, prediction, or networking. Coordinates live inside the gym
 * footprint (X∈[-13,13], Z∈[-18,18], Y≲6.3) because the offline MovementController hard-clamps
 * the player to the gym bounds and only wall-runs on the four perimeter walls — so the course is
 * a folded route through the gym shell rather than a spatially separate room, and the bounds clamp
 * doubles as the outer safety boundary. See MovementCourse.ts for how these anchors are built.
 */

/** Bump when the route / required objectives / timing change materially, so old times are dropped. */
export const COURSE_VERSION = 1;
export const LEADERBOARD_STORAGE_KEY = 'strafeball:movement-course:v1:top10';
export const LEADERBOARD_MAX_ENTRIES = 10;

/** Unbound key (see config/controls.ts) — restart the run from the start pad. */
export const COURSE_RESTART_KEY = 'KeyT';

/** Where the player is placed when entering the course (staging area), facing down-course (−Z). */
export const COURSE_SPAWN = { position: new Vector3(0, 0, 13.2), yaw: Math.PI };

/** Where the player is placed back in the practice lobby after leaving the course. */
export const COURSE_LOBBY_RETURN = { position: new Vector3(2, 0, -8.2), yaw: Math.PI };

/** Axis-aligned bounds used for cheap trigger volumes (no per-frame allocation). */
export interface CourseBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export function bounds(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): CourseBounds {
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

export function pointInBounds(b: CourseBounds, x: number, y: number, z: number): boolean {
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY && z >= b.minZ && z <= b.maxZ;
}

/**
 * A sequence-aware, one-way gate. `forward` is the unit horizontal direction the player must be
 * travelling when they cross for the crossing to count — crossing backward never registers.
 */
export interface GateConfig {
  id: 'cp1' | 'cp2' | 'cp3' | 'finish';
  label: string;
  bounds: CourseBounds;
  forward: { x: number; z: number };
  /** cp2 sits after the combat gate, so it only accepts once the catch-and-return objective is done. */
  requiresObjective?: boolean;
}

/** Start pad — stepping onto it (grounded, unarmed, while exploring) begins a timed run. */
export const START_PAD = {
  center: new Vector3(0, 0, 10.6),
  bounds: bounds(-1.5, 1.5, -0.2, 0.9, 9.7, 11.5)
};

/** Three ordered checkpoints + the finish, checked only while a run is active. */
export const GATES: readonly GateConfig[] = [
  {
    id: 'cp1',
    label: 'Checkpoint 1',
    bounds: bounds(-10.2, -5.8, 0, 3.0, -1.4, -0.6),
    forward: { x: 0, z: -1 }
  },
  {
    id: 'cp2',
    label: 'Checkpoint 2',
    bounds: bounds(5.6, 7.4, 0, 3.0, -14.6, -11.4),
    forward: { x: 1, z: 0 },
    requiresObjective: true
  },
  {
    id: 'cp3',
    label: 'Checkpoint 3',
    bounds: bounds(1.5, 4.9, 3.4, 6.2, -13.1, -11.5),
    forward: { x: 0, z: 1 }
  },
  {
    // The finish is a HIGH gate volume over the finish pad: only a backflip lifts the player's root
    // (~2.9m peak) into y≥2.2 — a normal jump (~0.69m) or jump+upward-dash (~1.7m) can't reach it.
    // Direction-agnostic on purpose (the backflip is mostly vertical); validity is gated instead by
    // ordered checkpoints + objective + an actual backflip this run (see MovementCourse.checkGates).
    id: 'finish',
    label: 'Finish',
    bounds: bounds(-2.4, 2.4, 2.2, 3.8, -5.7, -2.3),
    forward: { x: 0, z: 0 }
  }
];

/** Crossing debounce so movement jitter can't double-register a single pass. */
export const GATE_DEBOUNCE_SECONDS = 0.6;
export const START_PAD_DEBOUNCE_SECONDS = 0.5;

/**
 * Zone 5 — catch-and-return combat objective. A course-owned thrower lobs a tagged course ball at
 * the player (caught with the real catch mechanic); the player throws it back at the target. All
 * positions are local; the bot/target are simple stationary props.
 */
export const COMBAT = {
  /** Where the player fights from (used to aim the serve). */
  playerAnchor: new Vector3(-2.5, 0, -13),
  thrower: new Vector3(-5.5, 0, -13),
  target: new Vector3(5.5, 0, -13),
  /** Half-extents of the target's hittable box (course ball vs target). */
  targetHalf: new Vector3(0.55, 1.0, 0.55),
  /** Where the served ball spawns (thrower chest) and is reset to between serves. */
  serveOrigin: new Vector3(-5.2, 1.4, -13),
  serveSpeed: 15,
  /** Upward arc bias added to the aim before renormalising, so the lob reads as catchable. */
  serveArc: 0.16,
  /** Time the thrower winds up before releasing a fresh serve. */
  serveWindupSeconds: 0.7,
  /** After a miss (ball dead/loose/strayed), wait this long, then re-serve. Timer keeps running. */
  reserveDelaySeconds: 1.1,
  /** If the ball leaves this box it's considered strayed and is re-served. */
  arena: bounds(-9, 9, -1, 6, -17, -10)
} as const;

/** Leave-course portal near the staging area (hold E). */
export const LEAVE_PORTAL = {
  position: new Vector3(-4, 0, 13.4),
  radius: 2.4,
  holdSeconds: 0.6
};

/** A rough AABB enclosing the whole course; used only for a generous "fell out of the run" guard. */
export const COURSE_REGION = bounds(-12.5, 12.5, -3, 7, -17.5, 15.5);
