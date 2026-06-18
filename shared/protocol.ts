import type { HandSide, PlayerInput, RoomState, Vec3 } from './types';
import type { CompactServerSnapshot, PlayerRoster } from './snapshotCodec';

export interface InputCommand {
  type: 'input';
  playerId: string;
  sequence: number;
  clientTimeMs: number;
  input: PlayerInput;
}

export interface ServerSnapshot {
  type: 'snapshot';
  tick: number;
  serverTimeMs: number;
  room: RoomState;
}

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
  | ServerSnapshot
  | CompactServerSnapshot
  | ThrowEvent
  | CatchEvent
  | ParryEvent
  | HitEvent
  | HitRevertEvent
  | { type: 'joined-room'; room: RoomState; playerId: string }
  | { type: 'roster-update'; roster: PlayerRoster }
  | { type: 'player-joined'; playerId: string }
  | { type: 'player-left'; playerId: string }
  | { type: 'input-rejected'; sequence: number; reason: string }
  | { type: 'request-rejected'; request: ClientMessage['type']; reason: string }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number };
