export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type HandSide = 'left' | 'right';
export type SpawnSide = 'negativeZ' | 'positiveZ';
export type LegalHalf = SpawnSide;
export type MatchMode = '1v1' | '2v2';
export type PlayerCombatState = 'waiting' | 'alive' | 'eliminated';

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
  /**
   * Catch-attempt ids (server-authoritative timed catch). When the local player clicks an EMPTY
   * hand, the client assigns that hand a new monotonically-increasing attempt id and stamps it on
   * every input packet until the server acknowledges it (latched re-send so the trigger is never
   * lost to packet loss). 0 = no pending attempt for that hand. The server treats a strictly-larger
   * id than the last it processed for that player+hand as a fresh attempt and opens a catch window
   * anchored at this packet's sequence/clientTimeMs. Duplicates/older ids are ignored (stale-attempt).
   */
  leftCatchAttemptId: number;
  rightCatchAttemptId: number;
  /**
   * Backflip landing quick-time-event result, latched onto the throw-release packet. 0 = a normal
   * throw; 1..5 = the QTE success tier the client resolved on landing from a backflip. The server
   * validates legitimacy (player must have backflipped recently and be grounded) before honoring it:
   * a valid tier sets the throw's speed (tier 1 = quick, top tier = fastest) and marks it golden.
   */
  backflipThrowTier: number;
  /**
   * The server `resetSerial` this input was produced under (the latest the client has seen). The
   * server rejects any input whose resetSerial is OLDER than its current one, so pre-reset packets
   * still in flight when a room reset happens are discarded instead of corrupting the post-reset
   * input stream (which otherwise bumps the server's last-seen sequence back to a stale-high value
   * and makes every fresh input look like a duplicate — the "stuck after reset" freeze). 0 is the
   * initial room timeline; only an omitted field is treated as a pre-resetSerial legacy client.
   */
  resetSerial: number;
  /** True while the player holds the interact key (E). Used server-side to stand up a knocked-over mat. */
  interactHeld: boolean;
}

export type PlayerHandMode = 'empty' | 'holding' | 'charging' | 'catching';

export interface HandState {
  side: HandSide;
  heldBallId: string | null;
  mode: PlayerHandMode;
  chargeSeconds: number;
  cooldownSeconds: number;
  catchTrackingSecondsByBallId: Record<string, number>;
  /**
   * Highest catch-attempt id the server has consumed for this hand (see PlayerInput.*CatchAttemptId).
   * Travels in snapshots so the client knows its attempt was acknowledged and can stop re-latching
   * it. Independent of whether the catch succeeded — it only means "the server saw this attempt".
   */
  lastCatchAttemptId: number;
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

export interface PlayerMatchStats {
  hits: number;
  hitsTaken: number;
  catches: number;
  parries: number;
  saves: number;
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
  doubleJumpAvailable: boolean;
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
  teamSlotIndex: number;
  legalHalf: LegalHalf;
  movement: PlayerMovementState;
  movementInternal: MovementInternalState;
  hands: PlayerHandsState;
  dash: DashState;
  score: number;
  matchStats: PlayerMatchStats;
  lives: number;
  combatState: PlayerCombatState;
  eliminatedAtMs: number | null;
  lastPlayerBuffUntilMs: number | null;
  connected: boolean;
  reconnectDeadlineAtMs: number | null;
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
  /**
   * Monotonic id incremented every time this ball enters `live` from a throw (and on deflect). The
   * client uses it to (a) detect a fresh throw to start visual prediction, (b) ignore stale throw
   * events, and (c) force a snap when the throw identity changes mid-flight (re-throw/deflect/reset).
   * 0 means "never thrown live since creation/reset".
   */
  throwId: number;
}

export interface BallSnapshot extends BallState {
  serverTick: number;
}

export type MatchStatus = 'warmup' | 'countdown' | 'playing' | 'complete';

export interface HalfCourtViolationState {
  illegalCrossCount: number;
  warningsIssued: number;
  penaltiesIssued: number;
  wasAcross: boolean;
  deathCountdownActive: boolean;
  countdownSeconds: number;
  eliminationIssued: boolean;
}

export type BoundaryEvent =
  | { type: 'none' }
  | { type: 'no-boundaries' }
  | { type: 'half-court-warning'; playerId: string; warningsIssued: number }
  | { type: 'half-court-penalty'; playerId: string; opponentTeamId: string; value: number }
  | { type: 'half-court-elimination'; playerId: string };

export interface MatchBoundaryState {
  elapsedSeconds: number;
  noBoundaries: boolean;
  illegalCrossByPlayerId: Record<string, HalfCourtViolationState>;
  lastEvent: BoundaryEvent;
}

export interface MatchState {
  id: string;
  mode: MatchMode;
  status: MatchStatus;
  elapsedSeconds: number;
  scoreLimit: number;
  teamIds: string[];
  playersPerTeam: number;
  maxPlayers: number;
  scoreByTeamId: Record<string, number>;
  winnerTeamId: string | null;
  boundary: MatchBoundaryState;
  /**
   * Seconds remaining in the pre-round countdown while `status === 'countdown'`. The server pins
   * every player to spawn and ignores movement/combat input during this window, then flips to
   * 'playing' when it hits 0. The client reads it to show the on-screen countdown and to freeze
   * local prediction. 0 in any non-countdown status.
   */
  countdownSeconds: number;
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
  mode: 'same-teams' | 'reset-teams';
  votesByPlayerId: Record<string, true>;
  voteCount: number;
  requiredVotes: number;
  expiresAtMs: number | null;
  resetSerial: number;
}

export interface StartVoteState {
  votesByPlayerId: Record<string, true>;
  voteCount: number;
  requiredVotes: number;
  expiresAtMs: number | null;
  teamChoicesByPlayerId: Record<string, true>;
  teamChoiceCount: number;
  requiredTeamChoices: number;
}

export interface RoomState {
  id: string;
  tick: number;
  match: MatchState;
  players: Record<string, PlayerState>;
  balls: Record<string, BallState>;
  mats: Record<string, MatState>;
  resetVote: ResetVoteState;
  startVote: StartVoteState;
}

export type ValidationResult<Reason extends string = string> =
  | { ok: true }
  | { ok: false; reason: Reason };
