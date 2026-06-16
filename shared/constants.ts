export const GAME_CONSTANTS = {
  simulation: {
    maxDeltaSeconds: 0.05
  },

  player: {
    height: 1.75,
    radius: 0.42,
    lookPitchLimitRadians: 1.45,
    eyeHeight: 1.58,
    groundAcceleration: 24,
    airAcceleration: 11,
    airStrafeMaxSpeed: 1.3,
    friction: 10,
    // Strafe/ground top speed reduced 30% (8.5 → 5.95) for tighter, more deliberate movement.
    maxGroundSpeed: 5.95,
    softSpeedLimit: 18,
    softLimitBleedRate: 1.2,
    gravity: 22,
    fallGravityMultiplier: 1.45,
    // Jump impulse reduced 35% (8.2 → 5.33) — lower hops.
    jumpSpeed: 5.33,
    bhopGraceSeconds: 0.12,
    bhopSpeedBonus: 1.035,
    crouchHeightMultiplier: 0.62,
    catchStanceSpeedMultiplier: 0.72,
    stepHeight: 0.45
  },

  slide: {
    minStartSpeed: 6.2,
    // Reduced from 2.2 → shorter slide launch.
    impulse: 1.4,
    // Raised from 0.38 → slide bleeds speed faster → covers less ground.
    frictionMultiplier: 0.55,
    minDuration: 0.28,
    // Shortened from 1.2 → slides end sooner.
    maxDuration: 1.0,
    jumpBonus: 1.12
  },

  wall: {
    runTriggerAngleDegrees: 55,
    runMaxSeconds: 1.1,
    runGravityScale: 0.15,
    runMaxFallSpeed: -2.0,
    runStartUpBoost: 2.2,
    minEntrySpeed: 2.0,
    jumpAwaySpeed: 9.5,
    jumpUpSpeed: 8.5,
    reattachCooldownSeconds: 0.2
  },

  backflip: {
    cooldownSeconds: 2.6,
    durationSeconds: 0.72,
    verticalImpulse: 10.5,
    backwardImpulse: 4.8,
    superWindowStart: 0.25,
    superWindowEnd: 0.52,
    superThrowMultiplier: 2.0
  },

  ball: {
    maxHeldBalls: 2,
    radius: 0.22,
    pickupRadius: 1.55,
    slowPickupSpeed: 2.25,
    gravity: 9.8,
    quickThrowSpeed: 24,
    chargedThrowSpeed: 35,
    maxChargeSeconds: 0.85,
    chargeMinMultiplier: 0.65,
    chargedDropScale: 0,
    quickDropScale: 0.5,
    curveStrength: 13.5,
    movementThrowScale: 0.35,
    secondThrowDelaySeconds: 0.2,
    fastDoubleThrowPenalty: 0.82,
    bounceRestitution: 0.58,
    deadAfterBounces: 1,
    deflectedDeadAfterBounces: 1,
    settleSpeed: 0.2,
    hitRadius: 0.7,
    liveHitMinSpeed: 2.5,
    looseFriction: 3.5,
    pickupVerticalTolerance: 1.2
  },

  catch: {
    coneDegrees: 25,
    superParryConeDegrees: 10,
    // Hold-to-catch was removed (it didn't suit the game's feel). Catch is now a server-authoritative
    // timed "catch attempt": one click opens a short active window (see `combat`), and the catch
    // succeeds if a live ball's swept path crosses the hand's catch zone during that window. This
    // field is retained at 0 for any legacy callers but no longer gates the attempt model.
    trackingSeconds: 0,
    // Extended again +1 ft (0.305 m) from 3.31 → 3.62 m so fast throws can be caught with more reach.
    rangeMeters: 3.62,
    cooldownSeconds: 0.45,
    catchBoostSpeed: 3,
    catchBoostDuration: 0.25
  },

  parry: {
    // Auto-parry stays automatic while aiming within this cone of an incoming live ball. Tightened
    // 30 → 20° so it's still skillful (you must actually look at the ball) but reliable online.
    coneDegrees: 20,
    rangeMeters: 0.925,
    cooldownSeconds: 1,
    deflectSpeedMultiplier: 0.75,
    deflectUpVelocity: 1.5
  },

  /**
   * Server-authoritative "catch attempt" model (replaces hold-to-catch). One click opens a window:
   *   [press, press+startup)            — startup: too-early to land a catch
   *   [press+startup, press+active end) — ACTIVE: a swept in-cone live ball is caught
   *   [press, press+cooldown)           — recovery: a new attempt is rejected (cooldown)
   * The server evaluates the ACTIVE window against per-player/ball HISTORY, rewound to the click
   * time (sequence/clientTime) and clamped to maxRewindMs, with a small inputGraceMs slack so a
   * click that arrives a touch early/late around the in-cone moment still lands. This makes a
   * single well-timed click reliably catch online without becoming a free block or being spammable.
   */
  combat: {
    catchStartupMs: 0,       // 0–30ms: earliest the attempt can catch (0 = lands on the click tick)
    catchActiveMs: 150,      // ~120–180ms active window the swept ball must cross the cone within
    catchCooldownMs: 320,    // ~250–400ms recovery before another attempt is allowed
    defenseMaxRewindMs: 150, // never rewind history further than this from "now"
    defenseInputGraceMs: 60, // slack around the click moment when sampling history
    defenseHistoryMs: 320    // how much recent defensive/ball history the server retains
  },

  dash: {
    maxCharges: 3,
    rechargeSeconds: 3,
    // Reduced from 15 → shorter dash distance. Then a further 35% cut (11 → 7.15).
    impulse: 7.15,
    cooldownBetweenDashes: 0.18,
    // Reduced from 0.22 → friction reclaims the dash sooner → shorter carry.
    activeSeconds: 0.16,
    similarDirectionDot: 0.35,
    // Raised from 0.55 → when dashing AGAINST momentum you keep more of the opposing
    // velocity, so you can't instantly reverse to full speed.
    oppositeDirectionMomentumPenalty: 0.65,
    // New: the dash impulse itself is weakened when fired opposite to current momentum,
    // further limiting instant direction reversals.
    oppositeDirectionImpulseScale: 0.7
  },

  match: {
    scoreLimit: 5,
    noBoundariesSeconds: 120,
    resetVoteSeconds: 20,
    illegalCrossWarningsBeforePenalty: 1,
    penaltyHitValue: 1,
    halfCourtLineZ: 0.25
  },

  map: {
    halfWidth: 13,
    halfLength: 18,
    // Ceiling height (meters). Used by the ball ceiling clamp + the side-wall/ceiling 1-bounce rule.
    // Mirrored by the client TUNING.map.wallHeight so server and client agree on the bounce surface.
    // Raised 1.5× (4.5 → 6.75) so the walls are taller and the ceiling sits higher above play.
    wallHeight: 6.75,
    ballCount: 6
  }
} as const;

export type GameConstants = typeof GAME_CONSTANTS;
