import type { HandSide, PlayerInput, RoomState, Vec3 } from './types';
import type { CompactServerSnapshot, PlayerRoster } from './snapshotCodec';
import type { BattleMusicSyncState } from './music/BattleMusic';

/**
 * The on-the-wire form of PlayerInput. `dashDirection` is OMITTED when it is a zero vector — which
 * is every non-dash tick and a dash-with-no-movement tick — because the server's movement sim only
 * reads it on the `dashPressed` tick and, when absent, derives the dash direction from the same
 * move keys (the wish direction, which is mathematically identical to what the client computed) or
 * the facing. Omitting it shaves a 3-number object off the dominant outbound packet (one per fixed
 * step at up to 180Hz) with zero gameplay effect. The server defaults an absent dashDirection to a
 * ZERO vector (never the previous input), so an omitted field is sim-equivalent to a zero one.
 */
export type WireInput = Omit<PlayerInput, 'dashDirection'> & { dashDirection?: Vec3 };

/** Vectors at or below this length are treated as "no dash direction" — matches the sim's EPS. */
const WIRE_DASH_DIRECTION_EPS = 0.001;

/**
 * Encode a PlayerInput for the wire, omitting `dashDirection` when it is effectively zero. A zero
 * dash direction carries no information: the sim ignores dashDirection on non-dash ticks entirely,
 * and on a dash tick a zero/absent direction makes it fall back to the wish/facing direction — the
 * exact behavior a zero vector already produces. The local prediction copy keeps the full input
 * untouched (only the transmitted object is trimmed), so reconciliation is unaffected.
 */
export function toWireInput(input: PlayerInput): WireInput {
  const { dashDirection, ...rest } = input;
  const dx = dashDirection?.x ?? 0;
  const dz = dashDirection?.z ?? 0;
  if (Math.hypot(dx, dz) <= WIRE_DASH_DIRECTION_EPS) return rest;
  return { ...rest, dashDirection };
}

export interface InputCommand {
  type: 'input';
  playerId: string;
  sequence: number;
  clientTimeMs: number;
  /** Client-measured round-trip time in ms. Used server-side only to size lag-comp catch rewind. */
  rttMs?: number;
  input: WireInput;
}

export interface ServerSnapshot {
  type: 'snapshot';
  tick: number;
  serverTimeMs: number;
  room: RoomState;
}

export type SnapshotPayload = ServerSnapshot | CompactServerSnapshot;

/**
 * Authoritative throw event (Phase 4). Broadcast the instant the server accepts a throw, BEFORE the
 * next snapshot, so the client can start deterministic visual prediction of the live ball from the
 * exact origin/velocity/curve the server simulated. Purely informational — the ball's real state
 * still flows in snapshots; this only seeds + identifies the prediction. `throwId` is unique per
 * throw so the client can ignore stale events and snap on identity changes.
 */
export interface ThrowEvent {
  type: 'throw-event';
  throwId: number;
  ballId: string;
  ownerId: string;
  hand: HandSide;
  serverTick: number;
  serverTimeMs: number;
  origin: Vec3;
  velocity: Vec3;
  curveAccel: Vec3;
  dropScale: number;
  isSuper: boolean;
  isCurve: boolean;
  charge01: number;
  resetSerial: number;
}

/**
 * Immediate combat events broadcast BEFORE the next snapshot so clients react in the same
 * render frame. Numeric enums keep payloads tiny (no string discriminators on the wire).
 */
export interface CatchEvent {
  type: 'catch-event';
  ballId: string;
  catcherId: string;
  hand: HandSide;
  absorbedSpeed: number;
  incomingVelocity: Vec3;
  serverTick: number;
  serverTimeMs: number;
  /** True when lag-comp reclaim caught a ball that had already hit/passed the defender. */
  reclaim: boolean;
}

export interface ParryEvent {
  type: 'parry-event';
  ballId: string;
  deflectorId: string;
  serverTick: number;
  serverTimeMs: number;
}

export interface HitEvent {
  type: 'hit-event';
  ballId: string;
  throwerId: string;
  targetId: string;
  serverTick: number;
  serverTimeMs: number;
}

export interface HitRevertEvent {
  type: 'hit-revert-event';
  ballId: string;
  throwerId: string;
  targetId: string;
  serverTick: number;
  serverTimeMs: number;
}

export interface BattleMusicSyncMessage {
  type: 'music-sync';
  serverTimeMs: number;
  music: BattleMusicSyncState;
}

export interface PickupRequest {
  type: 'pickup';
  playerId: string;
}

export interface DropRequest {
  type: 'drop';
  playerId: string;
  hand?: HandSide;
}

export interface ThrowRequest {
  type: 'throw';
  playerId: string;
  hand: HandSide;
  direction: Vec3;
  charge01: number;
}

export interface CatchParryRequest {
  type: 'catch-parry';
  playerId: string;
  hand?: HandSide;
  facing?: Vec3;
}

export interface ResetRequest {
  type: 'reset';
  playerId: string;
  mode?: 'same-teams' | 'reset-teams';
}

export interface StartVoteRequest {
  type: 'start-vote';
  playerId: string;
}

export interface SwitchTeamRequest {
  type: 'switch-team';
  playerId: string;
  teamId: string;
  teamSlotIndex?: number;
}

export type ClientMessage =
  | InputCommand
  | PickupRequest
  | DropRequest
  | ThrowRequest
  | CatchParryRequest
  | ResetRequest
  | StartVoteRequest
  | SwitchTeamRequest
  | { type: 'join-room'; roomId: string; playerId: string }
  | { type: 'leave-room'; roomId: string; playerId: string }
  | { type: 'ping'; clientTimeMs: number };

export type ServerMessage =
  | SnapshotPayload
  | ThrowEvent
  | CatchEvent
  | ParryEvent
  | HitEvent
  | HitRevertEvent
  | BattleMusicSyncMessage
  | { type: 'joined-room'; room: RoomState; playerId: string }
  | { type: 'roster-update'; roster: PlayerRoster }
  | { type: 'player-joined'; playerId: string }
  | { type: 'player-left'; playerId: string }
  | { type: 'input-rejected'; sequence: number; reason: string }
  | { type: 'request-rejected'; request: ClientMessage['type']; reason: string }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number };
