import type { HandSide, PlayerInput, RoomState, Vec3 } from './types';
import type { CompactServerSnapshot, PlayerRoster, TieredCompactServerSnapshot } from './snapshotCodec';
import type { BattleMusicSyncState } from './music/BattleMusic';
import type { NetFlightRecorderClientReport, NetFlightRecorderConfigMessage } from './netFlightRecorder';
import type { RoomSettingsPatch } from './roomSettings';

export type { RoomSettingsPatch } from './roomSettings';

/**
 * The on-the-wire form of PlayerInput. `dashDirection` is OMITTED when it is a zero vector — which
 * is every non-dash tick and a dash-with-no-movement tick — because the server's movement sim only
 * reads it on the `dashPressed` tick and, when absent, derives the dash direction from the same
 * move keys (the wish direction, which is mathematically identical to what the client computed) or
 * the facing. Omitting it shaves a 3-number object off the dominant outbound packet (one per fixed
 * step at up to 180Hz) with zero gameplay effect. The server defaults an absent dashDirection to a
 * ZERO vector (never the previous input), so an omitted field is sim-equivalent to a zero one.
 */
export type WireInput = Partial<Omit<PlayerInput, 'dashDirection' | 'sequence' | 'clientTimeMs'>> &
  Pick<PlayerInput, 'lookYawRadians' | 'lookPitchRadians'> & {
    dashDirection?: Vec3;
  };
// The historical comment above talks about dashDirection because that was the first trim. The type
// now also supports previous-input delta packets for the high-frequency input stream.

/** Vectors at or below this length are treated as "no dash direction" — matches the sim's EPS. */
const WIRE_DASH_DIRECTION_EPS = 0.001;

/**
 * Encode a PlayerInput for the wire, omitting `dashDirection` when it is effectively zero. A zero
 * dash direction carries no information: the sim ignores dashDirection on non-dash ticks entirely,
 * and on a dash tick a zero/absent direction makes it fall back to the wish/facing direction — the
 * exact behavior a zero vector already produces. The local prediction copy keeps the full input
 * untouched (only the transmitted object is trimmed), so reconciliation is unaffected.
 */
export function toWireInput(input: PlayerInput, previous?: PlayerInput): WireInput {
  const { sequence: _sequence, clientTimeMs: _clientTimeMs, dashDirection, ...rest } = input;
  const dx = dashDirection?.x ?? 0;
  const dz = dashDirection?.z ?? 0;
  const hasDashDirection = input.dashPressed && Math.hypot(dx, dz) > WIRE_DASH_DIRECTION_EPS;

  if (!previous) {
    return hasDashDirection ? { ...rest, dashDirection } : rest;
  }

  const wire: WireInput = {
    lookYawRadians: input.lookYawRadians,
    lookPitchRadians: input.lookPitchRadians
  };

  copyChangedInputField(wire, input, previous, 'moveX');
  copyChangedInputField(wire, input, previous, 'moveZ');
  copyChangedInputField(wire, input, previous, 'jumpHeld');
  copyChangedInputField(wire, input, previous, 'crouchHeld');
  copyChangedInputField(wire, input, previous, 'slideHeld');
  copyChangedInputField(wire, input, previous, 'fakeThrowHeld');
  copyChangedInputField(wire, input, previous, 'leftHandHeld');
  copyChangedInputField(wire, input, previous, 'rightHandHeld');
  copyChangedInputField(wire, input, previous, 'resetSerial');
  copyChangedInputField(wire, input, previous, 'interactHeld');

  copyEdgeInputField(wire, input, previous, 'jumpPressed');
  copyEdgeInputField(wire, input, previous, 'dashPressed');
  copyEdgeInputField(wire, input, previous, 'crouchPressed');
  copyEdgeInputField(wire, input, previous, 'slidePressed');
  copyEdgeInputField(wire, input, previous, 'backflipPressed');
  copyEdgeInputField(wire, input, previous, 'pickupPressed');
  copyEdgeInputField(wire, input, previous, 'dropPressed');
  copyEdgeInputField(wire, input, previous, 'fakeThrowPressed');
  copyEdgeInputField(wire, input, previous, 'leftHandPressed');
  copyEdgeInputField(wire, input, previous, 'rightHandPressed');
  copyEdgeInputField(wire, input, previous, 'leftHandReleased');
  copyEdgeInputField(wire, input, previous, 'rightHandReleased');

  copyLatchedNumberInputField(wire, input, previous, 'leftCatchAttemptId');
  copyLatchedNumberInputField(wire, input, previous, 'rightCatchAttemptId');
  copyLatchedNumberInputField(wire, input, previous, 'backflipThrowTier');

  if (hasDashDirection) wire.dashDirection = dashDirection;
  return wire;
}

function copyChangedInputField<K extends keyof WireInput>(
  wire: WireInput,
  input: PlayerInput,
  previous: PlayerInput,
  key: K
): void {
  if (input[key as keyof PlayerInput] !== previous[key as keyof PlayerInput]) {
    (wire as Record<K, WireInput[K]>)[key] = input[key as keyof PlayerInput] as WireInput[K];
  }
}

function copyEdgeInputField<K extends keyof WireInput>(
  wire: WireInput,
  input: PlayerInput,
  previous: PlayerInput,
  key: K
): void {
  if (input[key as keyof PlayerInput] === true || input[key as keyof PlayerInput] !== previous[key as keyof PlayerInput]) {
    (wire as Record<K, WireInput[K]>)[key] = input[key as keyof PlayerInput] as WireInput[K];
  }
}

function copyLatchedNumberInputField<K extends keyof WireInput>(
  wire: WireInput,
  input: PlayerInput,
  previous: PlayerInput,
  key: K
): void {
  const value = input[key as keyof PlayerInput];
  if (value !== 0 || value !== previous[key as keyof PlayerInput]) {
    (wire as Record<K, WireInput[K]>)[key] = value as WireInput[K];
  }
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

export type SnapshotPayload = ServerSnapshot | CompactServerSnapshot | TieredCompactServerSnapshot;

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

/**
 * Host-only request to change the room's authoritative settings. `settings` is a PARTIAL patch — only
 * the fields being changed are sent (the derived team shape is never sent; it follows `format`). The
 * server is the source of truth: it checks host identity + lifecycle phase, then strictly validates
 * the patch (validateRoomSettingsPatch). A rejected update comes back as a `request-rejected` message
 * carrying request:'update-room-settings' and the RoomSettingsRejectReason; an accepted one is
 * reflected in the next snapshot's `room.settings` (and the derived match fields).
 */
export interface UpdateRoomSettingsRequest {
  type: 'update-room-settings';
  playerId: string;
  settings: RoomSettingsPatch;
}

/**
 * End-the-live-game-early vote (Stage 4). The host's first send OPENS the vote (and counts as their
 * yes); connected players then send it to cast their yes. When the vote reaches the shared 70%
 * supermajority threshold the server returns the room to the lobby/setup phase. A rejected send
 * (e.g. a non-host opening it, or sending while not live) comes back as `request-rejected` with
 * request:'end-vote'.
 */
export interface EndVoteRequest {
  type: 'end-vote';
  playerId: string;
}

/**
 * Host-only "start the configured match now" request (Stage 4). Begins the pre-round countdown from
 * the lobby for BOTH formats when enough players are present (and, for 2v2, teams are chosen). This is
 * the host's lobby start button — distinct from 2v2's player-driven start vote, which still works.
 */
export interface StartMatchRequest {
  type: 'start-match';
  playerId: string;
}

/**
 * Between-rounds / post-match vote cast over the report card. `choice` selects which button the
 * player is voting for: 'next-round' (start the next round; intermission only) or 'to-lobby' (end
 * the match, return to the pregame lobby). A player's vote is exclusive — switching choices moves
 * their vote. Either option needs a 70% supermajority of connected players to pass.
 */
export interface IntermissionVoteRequest {
  type: 'intermission-vote';
  playerId: string;
  choice: 'next-round' | 'to-lobby';
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
  | UpdateRoomSettingsRequest
  | EndVoteRequest
  | StartMatchRequest
  | IntermissionVoteRequest
  | NetFlightRecorderClientReport
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
  | NetFlightRecorderConfigMessage
  | {
      type: 'pong';
      clientTimeMs: number;
      serverTimeMs: number;
      /**
       * Diagnostic mirror of the SERVER's side of this client's connection, sampled at pong time —
       * the two numbers that disambiguate "why is my ping spiking" from the client's Tab HUD alone:
       *  - outBufferedB: bytes the server has queued toward THIS client that the socket hasn't
       *    flushed yet. Balloons when the client's DOWNSTREAM path is congested/lossy (TCP
       *    retransmit stalls) even while the client's own WS buffer reads 0.
       *  - loopP95Ms: server event-loop delay p95 over the current perf window. Elevated for
       *    EVERYONE when the shared-CPU host stalls — high here + clean outBufferedB = the host.
       * Optional so mixed-version client/server pairs interop cleanly.
       */
      outBufferedB?: number;
      loopP95Ms?: number;
    };
