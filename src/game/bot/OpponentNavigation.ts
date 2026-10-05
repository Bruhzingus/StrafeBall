import { Vector3 } from '@babylonjs/core';
import type { AABB, CollisionWorld } from '../map/Collider';
import { TUNING } from '../config/tuning';

export interface OpponentNavigationBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorY: number;
}

type Point = { x: number; z: number };
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
type Edge = { to: number; distance: number };
type BoxSnapshot = {
  box: AABB;
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
  enabled: boolean; ramp: boolean;
};
type Route = { distance: number; points: Point[] };
type CachedRoute = { target: Point; version: number; points: Point[] };

const OBSTACLE_PADDING = 0.02;
const CORNER_MARGIN = 0.07;
const TARGET_TOLERANCE = 0.3;
const EPSILON = 1e-8;
const PICKUP_REACH = Math.min(TUNING.ball.pickupRadius, 1.65);

/**
 * Visibility-graph route planner for a grounded opponent. The graph is rebuilt only when a
 * collider is added, removed, enabled, disabled, or resized. Routes may end at a legal point
 * within pickup reach when the ball itself sits beyond the body-safe boundary or beside a mat.
 */
export class OpponentNavigation {
  private readonly limits: Rect;
  private readonly clearance: number;
  private snapshot: BoxSnapshot[] = [];
  private obstacles: Rect[] = [];
  private nodes: Point[] = [];
  private edges: Edge[][] = [];
  private dirty = true;
  private version = 0;
  private cachedRoute: CachedRoute | null = null;

  constructor(
    private readonly bounds: OpponentNavigationBounds,
    private readonly collision?: CollisionWorld,
    radius = 0.38
  ) {
    const bodyRadius = Math.max(0, radius);
    this.clearance = bodyRadius + OBSTACLE_PADDING;
    this.limits = {
      minX: bounds.minX + bodyRadius,
      maxX: bounds.maxX - bodyRadius,
      minZ: bounds.minZ + bodyRadius,
      maxZ: bounds.maxZ - bodyRadius
    };
  }

  /** Forget the graph and committed route after a reset or a known map change. */
  clear(): void {
    this.dirty = true;
    this.cachedRoute = null;
  }

  /** True only when the whole body-safe segment stays in bounds and avoids standing cover. */
  pathClear(from: Vector3, to: Vector3): boolean {
    this.ensureGraph();
    return this.segmentClear(from, to);
  }

  /** Ground-plane travel distance to a reachable target or pickup point; Infinity if blocked off. */
  routeDistance(from: Vector3, target: Vector3): number {
    this.ensureGraph();
    return this.solve(from, target).distance;
  }

  /** Next body-safe point on a committed route; null if no route exists. */
  nextWaypoint(from: Vector3, target: Vector3): Vector3 | null {
    this.ensureGraph();
    const cached = this.cachedRoute;
    if (cached && cached.version === this.version &&
        distance(cached.target, target) <= TARGET_TOLERANCE) {
      const point = this.skipVisibleWaypoints(from, cached);
      if (point) return new Vector3(point.x, target.y, point.z);
    }

    const route = this.solve(from, target);
    if (!Number.isFinite(route.distance)) {
      this.cachedRoute = null;
      return null;
    }
    this.cachedRoute = {
      target: { x: target.x, z: target.z },
      version: this.version,
      points: route.points
    };
    const point = this.skipVisibleWaypoints(from, this.cachedRoute);
    return point ? new Vector3(point.x, target.y, point.z) : null;
  }

  private skipVisibleWaypoints(from: Point, route: CachedRoute): Point | null {
    // A bot that reached a corner should take the next leg, not repeatedly return that corner.
    while (route.points.length > 1 && distance(from, route.points[0]) < 0.2) route.points.shift();
    for (let i = route.points.length - 1; i >= 0; i -= 1) {
      if (!this.segmentClear(from, route.points[i])) continue;
      if (i > 0) route.points.splice(0, i);
      return route.points[0];
    }
    return null;
  }

  private solve(from: Point, target: Point): Route {
    const unreachable: Route = { distance: Number.POSITIVE_INFINITY, points: [] };
    if (!this.pointFree(from)) return unreachable;
    const goals = this.goalCandidates(target);
    if (goals.length === 0) return unreachable;

    // The usual case needs no graph search.
    if (goals.length === 1 && this.segmentClear(from, goals[0])) {
      return { distance: distance(from, goals[0]), points: [goals[0]] };
    }

    const nodeCount = this.nodes.length;
    const costs = new Array<number>(nodeCount).fill(Number.POSITIVE_INFINITY);
    const previous = new Array<number>(nodeCount).fill(-1);
    const visited = new Array<boolean>(nodeCount).fill(false);
    for (let i = 0; i < nodeCount; i += 1) {
      if (this.segmentClear(from, this.nodes[i])) costs[i] = distance(from, this.nodes[i]);
    }
    for (let step = 0; step < nodeCount; step += 1) {
      let current = -1;
      let nearest = Number.POSITIVE_INFINITY;
      for (let i = 0; i < nodeCount; i += 1) {
        if (!visited[i] && costs[i] < nearest) { nearest = costs[i]; current = i; }
      }
      if (current < 0) break;
      visited[current] = true;
      for (const edge of this.edges[current]) {
        const candidate = nearest + edge.distance;
        if (candidate + EPSILON < costs[edge.to]) {
          costs[edge.to] = candidate;
          previous[edge.to] = current;
        }
      }
    }

    let best = Number.POSITIVE_INFINITY;
    let bestNode = -1;
    let bestGoal: Point | null = null;
    for (const goal of goals) {
      if (this.segmentClear(from, goal)) {
        const direct = distance(from, goal);
        if (direct < best) { best = direct; bestNode = -1; bestGoal = goal; }
      }
      for (let i = 0; i < nodeCount; i += 1) {
        if (!Number.isFinite(costs[i]) || !this.segmentClear(this.nodes[i], goal)) continue;
        const candidate = costs[i] + distance(this.nodes[i], goal);
        if (candidate + EPSILON < best) { best = candidate; bestNode = i; bestGoal = goal; }
      }
    }
    if (!bestGoal) return unreachable;
    const points: Point[] = [];
    for (let node = bestNode; node >= 0; node = previous[node]) points.push(this.nodes[node]);
    points.reverse();
    points.push(bestGoal);
    return { distance: best, points };
  }

  private goalCandidates(target: Point): Point[] {
    if (!Number.isFinite(target.x) || !Number.isFinite(target.z) ||
        this.limits.minX > this.limits.maxX || this.limits.minZ > this.limits.maxZ) return [];
    const clamped = {
      x: clamp(target.x, this.limits.minX, this.limits.maxX),
      z: clamp(target.z, this.limits.minZ, this.limits.maxZ)
    };
    if (distance(target, clamped) > PICKUP_REACH) return [];
    if (this.pointFree(clamped) && this.pickupPathClear(clamped, target)) return [clamped];

    const goals: Point[] = [];
    const add = (x: number, z: number): void => {
      const point = { x, z };
      if (distance(target, point) > PICKUP_REACH || !this.pointFree(point) || !this.pickupPathClear(point, target) ||
          goals.some((other) => distance(other, point) < 0.02)) return;
      goals.push(point);
    };
    for (const box of this.obstacles) {
      const left = box.minX - CORNER_MARGIN;
      const right = box.maxX + CORNER_MARGIN;
      const near = box.minZ - CORNER_MARGIN;
      const far = box.maxZ + CORNER_MARGIN;
      add(left, clamp(clamped.z, near, far));
      add(right, clamp(clamped.z, near, far));
      add(clamp(clamped.x, left, right), near);
      add(clamp(clamped.x, left, right), far);
      add(left, near);
      add(left, far);
      add(right, near);
      add(right, far);
    }
    return goals;
  }

  private pickupPathClear(from: Point, target: Point): boolean {
    for (const saved of this.snapshot) {
      const box = saved.box;
      if (!this.standing(box)) continue;
      if (segmentTouchesRect(from, target, {
        minX: box.minX - TUNING.ball.radius, maxX: box.maxX + TUNING.ball.radius,
        minZ: box.minZ - TUNING.ball.radius, maxZ: box.maxZ + TUNING.ball.radius
      })) return false;
    }
    return true;
  }

  private ensureGraph(): void {
    if (!this.dirty && !this.geometryChanged()) return;
    this.dirty = false;
    this.version += 1;
    this.cachedRoute = null;
    const boxes = this.collision?.boxes ?? [];
    this.snapshot = boxes.map((box) => ({
      box, minX: box.minX, maxX: box.maxX, minY: box.minY, maxY: box.maxY,
      minZ: box.minZ, maxZ: box.maxZ, enabled: box.enabled !== false, ramp: !!box.ramp
    }));
    this.obstacles = [];
    for (const box of boxes) {
      if (!this.standing(box)) continue;
      const rect = {
        minX: box.minX - this.clearance,
        maxX: box.maxX + this.clearance,
        minZ: box.minZ - this.clearance,
        maxZ: box.maxZ + this.clearance
      };
      if (rect.maxX < this.limits.minX || rect.minX > this.limits.maxX ||
          rect.maxZ < this.limits.minZ || rect.minZ > this.limits.maxZ) continue;
      this.obstacles.push(rect);
    }
    this.nodes = [];
    for (const box of this.obstacles) {
      for (const x of [box.minX - CORNER_MARGIN, box.maxX + CORNER_MARGIN]) {
        for (const z of [box.minZ - CORNER_MARGIN, box.maxZ + CORNER_MARGIN]) {
          const point = { x, z };
          if (this.pointFree(point) && !this.nodes.some((other) => distance(other, point) < 0.02)) {
            this.nodes.push(point);
          }
        }
      }
    }
    this.edges = this.nodes.map(() => []);
    for (let i = 0; i < this.nodes.length; i += 1) {
      for (let j = i + 1; j < this.nodes.length; j += 1) {
        if (!this.segmentClear(this.nodes[i], this.nodes[j])) continue;
        const length = distance(this.nodes[i], this.nodes[j]);
        this.edges[i].push({ to: j, distance: length });
        this.edges[j].push({ to: i, distance: length });
      }
    }
  }

  private geometryChanged(): boolean {
    const boxes = this.collision?.boxes ?? [];
    if (boxes.length !== this.snapshot.length) return true;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      const old = this.snapshot[i];
      if (old.box !== box || old.minX !== box.minX || old.maxX !== box.maxX ||
          old.minY !== box.minY || old.maxY !== box.maxY || old.minZ !== box.minZ ||
          old.maxZ !== box.maxZ || old.enabled !== (box.enabled !== false) || old.ramp !== !!box.ramp) return true;
    }
    return false;
  }

  private standing(box: AABB): boolean {
    return box.enabled !== false && !box.ramp &&
      box.maxY > this.bounds.floorY + TUNING.player.stepHeight &&
      box.minY < this.bounds.floorY + TUNING.player.height;
  }

  private pointFree(point: Point): boolean {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.z) ||
        point.x < this.limits.minX || point.x > this.limits.maxX ||
        point.z < this.limits.minZ || point.z > this.limits.maxZ) return false;
    for (const box of this.obstacles) {
      if (point.x >= box.minX && point.x <= box.maxX &&
          point.z >= box.minZ && point.z <= box.maxZ) return false;
    }
    return true;
  }

  private segmentClear(from: Point, to: Point): boolean {
    if (!this.pointFree(from) || !this.pointFree(to)) return false;
    for (const box of this.obstacles) {
      if (segmentTouchesRect(from, to, box)) return false;
    }
    return true;
  }
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Inclusive slab hit keeps exact obstacle tangencies out of movement routes. */
function segmentTouchesRect(from: Point, to: Point, rect: Rect): boolean {
  let near = 0;
  let far = 1;
  for (const [start, end, min, max] of [
    [from.x, to.x, rect.minX, rect.maxX],
    [from.z, to.z, rect.minZ, rect.maxZ]
  ]) {
    const delta = end - start;
    if (Math.abs(delta) < EPSILON) {
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
