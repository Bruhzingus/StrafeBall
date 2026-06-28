export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type HandSide = 'left' | 'right';
export type SpawnSide = 'negativeZ' | 'positiveZ';
export type LegalHalf = SpawnSide;

/**
 * Match format / team configuration. Only '1v1' and '2v2' are enabled right now (see ALLOWED_FORMATS
 * in roomSettings.ts), but this union is the single extensibility seam: a future '3v3' is one entry
 * here plus a FORMAT_TEAM_SHAPE row — never a structural rewrite of room/match state. `MatchMode` is
 * kept as the legacy alias the existing render/sim code reads; the two are intentionally identical.
 */
export type MatchFormat = '1v1' | '2v2';
export type MatchMode = MatchFormat;

/** Identity of the recommended preset a room's settings came from, or 'custom' once the host edits. */
export type MatchPresetId = '1v1-recommended' | '2v2-recommended' | 'custom';

/**
 * Unified private-match lifecycle phase — the room-level state machine the new private-match flow
 * renders from. Stage 1 maps this 1:1 from the legacy MatchStatus (warmup→lobby, countdown→countdown,
 * playing→live, complete→match-end). The 'round-end' / 'returning' transitions and a true multi-round
 * progression are modeled here now but only driven in later stages (round bookkeeping is deferred).
 */
export type RoomLifecyclePhase =
  | 'lobby'        // room setup / waiting; host configures settings
  | 'countdown'    // pre-round countdown, players pinned to spawn
  | 'live'         // live round in progress
  | 'round-end'    // brief transition between rounds (multi-round; later stage)
  | 'match-end'    // match summary / report card
  | 'returning';   // returning to the room lobby after the summary

export type PlayerCombatState = 'waiting' | 'alive' | 'eliminated';

/**
 * Host-controlled, authoritative room configuration — the single source of truth the host edits and
 * the protocol carries. Clients render from it; only the host may mutate it (validated server-side,
 * never UI-only). Shaped so larger formats are a DATA change (format + the derived team shape in
 * resolveMatchSettings), never a structural one: nothing here hardcodes "1 or 2 players per team".
 * Larger-than-2v2 is intentionally NOT permitted yet (canonicalizeRoomSettings/validate clamp it),
 * but the model already supports it. Numeric bounds live in ROOM_SETTINGS_LIMITS (roomSettings.ts).
 */
export interface RoomSettings {
  /** Recommended-preset identity this config came from, or 'custom' once any field diverges. */
  preset: MatchPresetId;
  /** Team format. Drives the derived team shape (teamSize/teamCount/maxPlayers). */
  format: MatchFormat;
  /** Starting lives per player. Range ROOM_SETTINGS_LIMITS.lives (1..6). */
  livesPerPlayer: number;
  /** Dodgeballs spawned at center court. Range ROOM_SETTINGS_LIMITS.dodgeballs. */
  dodgeballCount: number;
  /** Bounces a live ball survives before it dies. Range ROOM_SETTINGS_LIMITS.bounces. */
  maxLiveBallBounces: number;
  /** Mat layout preset: number of standing cover mats. Must be one of ALLOWED_MAT_PRESETS. */
  matPreset: number;
  /** Fixed number of rounds in a match. Range ROOM_SETTINGS_LIMITS.rounds. */
  roundCount: number;
  /** Seconds until half-court restrictions drop and the full court opens. Range ROOM_SETTINGS_LIMITS.halfCourtTimer. */
  halfCourtTimerSeconds: number;
}

/**
 * Fully-resolved, simulation-facing settings derived from RoomSettings via resolveMatchSettings. This
 * is the "engine parameters" half of the split: RoomSettings is host INTENT (what the menu edits),
 * MatchSettings is the canonical RESOLVED shape (team geometry + per-round rules) the game loop
 * consumes. Derived fields that the host never edits directly (teamSize/teamCount/maxPlayers, and the
 * legacy 1v1 scoreLimit) live only here.
 */
export interface MatchSettings {
  format: MatchFormat;
  teamSize: number;
  teamCount: number;
  maxPlayers: number;
  livesPerPlayer: number;
  dodgeballCount: number;
  maxLiveBallBounces: number;
  matPreset: number;
  roundCount: number;
  halfCourtTimerSeconds: number;
  /**
   * Legacy first-to-N score limit, retained ONLY for 1v1 (current 1v1 is a score race, not
   * elimination). 2v2 ignores it (elimination-based). Stage 2+ folds scoring into the unified
   * lives/round model and this field is expected to disappear.
   */
  scoreLimit: number;
}

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
   * validates legitimacy (player must have backflipped recently and be grounded or in the server's
   * small near-landing grace) before honoring it:
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
  slideBufferTimer: number;
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
  /** Meters traveled since this throw's first-live-flight began; drives the curve start/ramp gate. */
  curveDistance: number;
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

export type MatchStatus = 'warmup' | 'countdown' | 'playing' | 'intermission' | 'complete';

export interface HalfCourtViolationState {
  illegalCrossCount: number;
  warningsIssued: number;
  penaltiesIssued: number;
  penaltyTickSeconds: number;
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
   * Unified round system (Stage 3). A private match is a best-of-`roundCount` series of elimination
   * rounds for BOTH formats: a round ends when one team is fully eliminated, the surviving team takes
   * the round, and the match ends once a team clinches the majority (or all rounds are played). The
   * legacy `scoreByTeamId`/`scoreLimit` no longer determine private-match victory.
   */
  roundCount: number;
  /** 1-based index of the round currently being played. */
  currentRound: number;
  /** Rounds won so far, per team. The match winner is derived from this, not from score. */
  roundsWonByTeamId: Record<string, number>;
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

/**
 * Host-triggered "end the live game early" vote (Stage 4). The host opens it during an active round;
 * connected players then add their yes votes; it passes once it reaches the shared 70%
 * supermajority threshold, at which point the room returns to the lobby/setup phase with membership
 * + settings preserved. Snapshot-visible so all clients can render the vote prompt and tally.
 */
export interface EndVoteState {
  active: boolean;
  initiatedByPlayerId: string | null;
  votesByPlayerId: Record<string, true>;
  voteCount: number;
  requiredVotes: number;
  expiresAtMs: number | null;
}

/**
 * Between-rounds (status 'intermission') and post-match (status 'complete') vote shown over the
 * report card. Each option needs a 70% supermajority of connected players to pass: `nextRound`
 * starts the next round (intermission only); `toLobby` ends the match and returns everyone to the
 * pregame lobby. A player's vote is exclusive (voting one option clears their other). Tallies are
 * snapshot-visible so every client renders how many votes each button has. `nextRoundDeadlineAtMs`
 * is when the intermission auto-advances to the next round if no vote resolves it first.
 */
export interface IntermissionVoteState {
  active: boolean;
  /** True while a next-round option is offered (intermission only, not the final report card). */
  allowsNextRound: boolean;
  nextRoundByPlayerId: Record<string, true>;
  nextRoundCount: number;
  toLobbyByPlayerId: Record<string, true>;
  toLobbyCount: number;
  requiredVotes: number;
  nextRoundDeadlineAtMs: number | null;
}

export interface RoomState {
  id: string;
  tick: number;
  /**
   * Session id of the host (the room creator). Only the host may mutate `settings`; non-host players
   * receive live updates but cannot change them. Reassigned to another connected player if the host
   * leaves, and null only when the room is empty.
   */
  hostPlayerId: string | null;
  /** Unified private-match lifecycle phase. Mirrors `match.status` in Stage 1 (see RoomLifecyclePhase). */
  phase: RoomLifecyclePhase;
  /** Authoritative, host-controlled room configuration (source of truth; host-only mutation). */
  settings: RoomSettings;
  match: MatchState;
  players: Record<string, PlayerState>;
  balls: Record<string, BallState>;
  mats: Record<string, MatState>;
  resetVote: ResetVoteState;
  startVote: StartVoteState;
  endVote: EndVoteState;
  intermissionVote: IntermissionVoteState;
}

export type ValidationResult<Reason extends string = string> =
  | { ok: true }
  | { ok: false; reason: Reason };
