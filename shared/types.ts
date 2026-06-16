export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type HandSide = 'left' | 'right';
export type SpawnSide = 'negativeZ' | 'positiveZ';
export type LegalHalf = SpawnSide;

export type BallPhase = 'loose' | 'held' | 'live' | 'dead' | 'deflected';
export type BallOwnerKind = 'player' | 'launcher' | 'bot' | 'dummy' | null;

export interface PlayerInput {
  sequence: number;
  clientTimeMs: number;
  moveX: number;
  moveZ: number;
  dashDirection: Vec3;
  lookYawRadians: number;
  lookPitchRadians: number;
  jumpPressed: boolean;
  jumpHeld: boolean;
  dashPressed: boolean;
  crouchPressed: boolean;
  crouchHeld: boolean;
  slidePressed: boolean;
  slideHeld: boolean;
  backflipPressed: boolean;
  pickupPressed: boolean;
  dropPressed: boolean;
  fakeThrowPressed: boolean;
  fakeThrowHeld: boolean;
  leftHandPressed: boolean;
  leftHandHeld: boolean;
  rightHandPressed: boolean;
  rightHandHeld: boolean;
  leftHandReleased: boolean;
  rightHandReleased: boolean;
}

export type PlayerHandMode = 'empty' | 'holding' | 'charging' | 'catching';

export interface HandState {
  side: HandSide;
  heldBallId: string | null;
  mode: PlayerHandMode;
  chargeSeconds: number;
  cooldownSeconds: number;
  catchTrackingSecondsByBallId: Record<string, number>;
}

export type PlayerHandsState = Record<HandSide, HandState>;

export interface PlayerMovementState {
  position: Vec3;
  velocity: Vec3;
  yawRadians: number;
  pitchRadians: number;
  facing: Vec3;
  grounded: boolean;
  crouching: boolean;
  sliding: boolean;
  wallRunning: boolean;
  dashingThisFrame: boolean;
  speed: number;
}

export interface DashState {
  charges: number;
  rechargeTimerSeconds: number;
  cooldownSeconds: number;
}

/**
 * Persistent, frame-to-frame movement timers that don't belong in the outward-facing
 * PlayerMovementState but must survive across ticks AND be reconciled on the client (the
 * client replays unacknowledged inputs from this state). Mirrors the private fields of the
 * offline MovementController so the shared MovementSim reproduces identical feel.
 */
export interface MovementInternalState {
  slideTimer: number;
  jumpGraceTimer: number;
  wallRunTimer: number;
  wallReattachCooldown: number;
  dashActiveTimer: number;
  catchBoostTimer: number;
  groundHeight: number;
  lastWallNormalX: number;
  lastWallNormalZ: number;
  backflipActive: boolean;
  backflipTimer: number;
  backflipCooldown: number;
}

export interface PlayerState {
  id: string;
  name: string;
  teamId: string;
  spawnSide: SpawnSide;
  legalHalf: LegalHalf;
  movement: PlayerMovementState;
  movementInternal: MovementInternalState;
  hands: PlayerHandsState;
  dash: DashState;
  score: number;
  connected: boolean;
  // Highest input sequence number the server has simulated for this player. The client uses
  // it to discard acknowledged inputs and replay only the unacknowledged ones (reconciliation).
  lastProcessedInputSeq: number;
}

export interface BallState {
  id: string;
  phase: BallPhase;
  position: Vec3;
  velocity: Vec3;
  ownerKind: BallOwnerKind;
  ownerId: string | null;
  heldByPlayerId: string | null;
  heldHand: HandSide | null;
  bounceCount: number;
  isSuper: boolean;
  dropScale: number;
  curveAccel: Vec3;
  lastTouchedByPlayerId: string | null;
}

export interface BallSnapshot extends BallState {
  serverTick: number;
}

export type MatchStatus = 'warmup' | 'playing' | 'complete';

export interface HalfCourtViolationState {
  illegalCrossCount: number;
  warningsIssued: number;
  penaltiesIssued: number;
  wasAcross: boolean;
}

export type BoundaryEvent =
  | { type: 'none' }
  | { type: 'no-boundaries' }
  | { type: 'half-court-warning'; playerId: string; warningsIssued: number }
  | { type: 'half-court-penalty'; playerId: string; opponentTeamId: string; value: number };

export interface MatchBoundaryState {
  elapsedSeconds: number;
  noBoundaries: boolean;
  illegalCrossByPlayerId: Record<string, HalfCourtViolationState>;
  lastEvent: BoundaryEvent;
}

export interface MatchState {
  id: string;
  status: MatchStatus;
  elapsedSeconds: number;
  scoreLimit: number;
  teamIds: string[];
  scoreByTeamId: Record<string, number>;
  winnerTeamId: string | null;
  boundary: MatchBoundaryState;
}

/**
 * Authoritative state of one gym mat. Mats are upright cover panels that balls pass through but
 * players collide with; a player walking into a standing mat knocks it flat (knockedOver = true),
 * after which it lies on the floor and no longer blocks movement. `knockDirection` is the unit XZ
 * direction the player pushed it, so the client can tip it over the correct way (no launch).
 */
export interface MatState {
  id: string;
  position: Vec3;
  yawRadians: number;
  knockedOver: boolean;
  knockDirection: Vec3;
}

export interface ResetVoteState {
  votesByPlayerId: Record<string, true>;
  voteCount: number;
  requiredVotes: number;
  expiresAtMs: number | null;
  resetSerial: number;
}

export interface RoomState {
  id: string;
  tick: number;
  match: MatchState;
  players: Record<string, PlayerState>;
  balls: Record<string, BallState>;
  mats: Record<string, MatState>;
  resetVote: ResetVoteState;
}

export type ValidationResult<Reason extends string = string> =
  | { ok: true }
  | { ok: false; reason: Reason };
