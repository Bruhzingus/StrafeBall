import type { HandSide, PlayerInput, RoomState, Vec3 } from './types';

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

export type ClientMessage =
  | InputCommand
  | PickupRequest
  | DropRequest
  | ThrowRequest
  | CatchParryRequest
  | ResetRequest
  | { type: 'join-room'; roomId: string; playerId: string }
  | { type: 'leave-room'; roomId: string; playerId: string }
  | { type: 'ping'; clientTimeMs: number };

export type ServerMessage =
  | ServerSnapshot
  | { type: 'joined-room'; room: RoomState; playerId: string }
  | { type: 'player-joined'; playerId: string }
  | { type: 'player-left'; playerId: string }
  | { type: 'input-rejected'; sequence: number; reason: string }
  | { type: 'request-rejected'; request: ClientMessage['type']; reason: string }
  | { type: 'pong'; clientTimeMs: number; serverTimeMs: number };
