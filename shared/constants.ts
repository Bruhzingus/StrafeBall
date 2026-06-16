export const GAME_CONSTANTS = {
  simulation: {
    maxDeltaSeconds: 0.05
  },

  player: {
    height: 1.75,
    radius: 0.42
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
    impulse: 15,
    cooldownBetweenDashes: 0.18,
    activeSeconds: 0.22,
    similarDirectionDot: 0.35,
    oppositeDirectionMomentumPenalty: 0.55
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
