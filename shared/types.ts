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
  moveX: number;
  moveZ: number;
  lookYawRadians: number;
  lookPitchRadians: number;
  jump: boolean;
  crouch: boolean;
  slide: boolean;
  dash: boolean;
  backflip: boolean;
  interact: boolean;
  drop: boolean;
  fakeThrow: boolean;
  leftHand: boolean;
  rightHand: boolean;
  leftHandPressed: boolean;
  rightHandPressed: boolean;
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

export interface PlayerState {
  id: string;
  name: string;
  teamId: string;
  spawnSide: SpawnSide;
  legalHalf: LegalHalf;
  movement: PlayerMovementState;
  hands: PlayerHandsState;
  dash: DashState;
  score: number;
  connected: boolean;
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

export interface RoomState {
  id: string;
  tick: number;
  match: MatchState;
  players: Record<string, PlayerState>;
  balls: Record<string, BallState>;
}

export type ValidationResult<Reason extends string = string> =
  | { ok: true }
  | { ok: false; reason: Reason };
