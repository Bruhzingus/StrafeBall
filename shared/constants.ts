export const GAME_CONSTANTS = {
  simulation: {
    maxDeltaSeconds: 0.05
  },

  player: {
    height: 1.75,
    radius: 0.42,
    eyeHeight: 1.58,
    groundAcceleration: 24,
    airAcceleration: 11,
    airStrafeMaxSpeed: 1.3,
    friction: 10,
    maxGroundSpeed: 8.5,
    softSpeedLimit: 18,
    softLimitBleedRate: 1.2,
    gravity: 22,
    fallGravityMultiplier: 1.45,
    jumpSpeed: 8.2,
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
    hitRadius: 0.7
  },

  catch: {
    coneDegrees: 30,
    superParryConeDegrees: 10,
    trackingSeconds: 0.14,
    rangeMeters: 1.92,
    cooldownSeconds: 0.45,
    catchBoostSpeed: 3,
    catchBoostDuration: 0.25
  },

  parry: {
    coneDegrees: 30,
    rangeMeters: 0.925,
    cooldownSeconds: 1,
    deflectSpeedMultiplier: 0.75,
    deflectUpVelocity: 1.5
  },

  dash: {
    maxCharges: 3,
    rechargeSeconds: 3,
    // Reduced from 15 → shorter dash distance.
    impulse: 11,
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
    illegalCrossWarningsBeforePenalty: 1,
    penaltyHitValue: 1,
    halfCourtLineZ: 0.25
  },

  map: {
    halfWidth: 13,
    halfLength: 18,
    ballCount: 6
  }
} as const;

export type GameConstants = typeof GAME_CONSTANTS;
