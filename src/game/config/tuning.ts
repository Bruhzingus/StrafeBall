import { GAME_CONSTANTS } from '../../../shared/constants';

export const TUNING = {
  simulation: {
    // The sim runs one variable-length step per rendered frame, clamped to this so a long
    // hitch (alt-tab, GC) can't produce a huge step that tunnels through collision.
    maxDeltaSeconds: GAME_CONSTANTS.simulation.maxDeltaSeconds
  },

  player: {
    height: GAME_CONSTANTS.player.height,
    eyeHeight: GAME_CONSTANTS.player.eyeHeight,
    radius: GAME_CONSTANTS.player.radius,
    lookPitchLimitRadians: GAME_CONSTANTS.player.lookPitchLimitRadians,
    groundAcceleration: GAME_CONSTANTS.player.groundAcceleration,
    airAcceleration: GAME_CONSTANTS.player.airAcceleration,
    // Air "wish speed" cap (Source-style airspeedcap). Small on purpose: the projection in
    // accelerate() means only velocity perpendicular to your current motion can be added,
    // which is exactly what lets mouse-turning while strafing build speed (air-strafing).
    airStrafeMaxSpeed: GAME_CONSTANTS.player.airStrafeMaxSpeed,
    friction: GAME_CONSTANTS.player.friction,
    // Mirrors GAME_CONSTANTS.player.maxGroundSpeed (strafe top speed −30%). Kept in sync so offline
    // practice feels the same as the server-authoritative online movement.
    maxGroundSpeed: GAME_CONSTANTS.player.maxGroundSpeed,
    crouchWalkSpeed: GAME_CONSTANTS.player.crouchWalkSpeed,
    softSpeedLimit: GAME_CONSTANTS.player.softSpeedLimit,
    // Rate (per second) that speed above the soft limit bleeds off. dt-scaled so it's
    // frame-rate independent.
    softLimitBleedRate: GAME_CONSTANTS.player.softLimitBleedRate,
    gravity: GAME_CONSTANTS.player.gravity,
    // Gravity is stronger while falling so jumps feel snappy and weighty, not floaty.
    fallGravityMultiplier: GAME_CONSTANTS.player.fallGravityMultiplier,
    // Mirrors GAME_CONSTANTS.player.jumpSpeed. Kept in sync with the server sim.
    jumpSpeed: GAME_CONSTANTS.player.jumpSpeed,
    bhopGraceSeconds: GAME_CONSTANTS.player.bhopGraceSeconds,
    bhopPerfectWindowSeconds: 0.07,
    bhopSpeedBonus: GAME_CONSTANTS.player.bhopSpeedBonus,
    crouchHeightMultiplier: GAME_CONSTANTS.player.crouchHeightMultiplier,
    catchStanceSpeedMultiplier: GAME_CONSTANTS.player.catchStanceSpeedMultiplier,
    ceilingClearance: GAME_CONSTANTS.player.ceilingClearance,
    // Max height a surface (bleacher tier) can be above the feet to still count as
    // standable ground this tick. Bigger steps must be jumped onto.
    stepHeight: GAME_CONSTANTS.player.stepHeight
  },

  slide: {
    minStartSpeed: GAME_CONSTANTS.slide.minStartSpeed,
    heightScale: GAME_CONSTANTS.slide.heightScale,
    minStartBoostSpeed: GAME_CONSTANTS.slide.minStartBoostSpeed,
    airBufferSeconds: GAME_CONSTANTS.slide.airBufferSeconds,
    impulse: GAME_CONSTANTS.slide.impulse,
    frictionMultiplier: GAME_CONSTANTS.slide.frictionMultiplier,
    minDuration: GAME_CONSTANTS.slide.minDuration,
    maxDuration: GAME_CONSTANTS.slide.maxDuration,
    jumpBonus: GAME_CONSTANTS.slide.jumpBonus,
    overholdBrakeDelay: GAME_CONSTANTS.slide.overholdBrakeDelay,
    overholdFrictionMultiplier: GAME_CONSTANTS.slide.overholdFrictionMultiplier,
    overholdStopSpeed: GAME_CONSTANTS.slide.overholdStopSpeed
  },

  dash: {
    maxCharges: GAME_CONSTANTS.dash.maxCharges,
    rechargeSeconds: GAME_CONSTANTS.dash.rechargeSeconds,
    impulse: GAME_CONSTANTS.dash.impulse,
    cooldownBetweenDashes: GAME_CONSTANTS.dash.cooldownBetweenDashes,
    // Brief window after a dash where ground friction is suppressed so the burst actually
    // carries instead of being bled away the same frame.
    activeSeconds: GAME_CONSTANTS.dash.activeSeconds,
    similarDirectionDot: GAME_CONSTANTS.dash.similarDirectionDot,
    oppositeDirectionMomentumPenalty: GAME_CONSTANTS.dash.oppositeDirectionMomentumPenalty,
    oppositeDirectionImpulseScale: GAME_CONSTANTS.dash.oppositeDirectionImpulseScale,
    upwardImpulse: GAME_CONSTANTS.dash.upwardImpulse
  },

  wall: {
    // How far off "parallel to the wall" your travel can be and still attach (looser = easier).
    runTriggerAngleDegrees: GAME_CONSTANTS.wall.runTriggerAngleDegrees,
    runMaxSeconds: GAME_CONSTANTS.wall.runMaxSeconds,
    runGravityScale: GAME_CONSTANTS.wall.runGravityScale,
    // Small upward kick when a wall-run starts so you climb a little.
    runStartUpBoost: GAME_CONSTANTS.wall.runStartUpBoost,
    minEntrySpeed: GAME_CONSTANTS.wall.minEntrySpeed,
    jumpAwaySpeed: GAME_CONSTANTS.wall.jumpAwaySpeed,
    jumpUpSpeed: GAME_CONSTANTS.wall.jumpUpSpeed,
    reattachCooldownSeconds: GAME_CONSTANTS.wall.reattachCooldownSeconds,
    ceilingDetachDistance: GAME_CONSTANTS.wall.ceilingDetachDistance,
    // A/D-while-W wall-run climb (see shared/constants.ts wall.* for the full description).
    runClimbSpeed: GAME_CONSTANTS.wall.runClimbSpeed,
    runClimbSmoothing: GAME_CONSTANTS.wall.runClimbSmoothing,
    runGravityDelaySeconds: GAME_CONSTANTS.wall.runGravityDelaySeconds,
    runLateGravityScale: GAME_CONSTANTS.wall.runLateGravityScale,
    ceilingDetachPushDown: GAME_CONSTANTS.wall.ceilingDetachPushDown,
    leanAngleRadians: 25 * Math.PI / 180,
    leanSmoothing: 11
  },

  backflip: {
    cooldownSeconds: GAME_CONSTANTS.backflip.cooldownSeconds,
    durationSeconds: GAME_CONSTANTS.backflip.durationSeconds,
    verticalImpulse: GAME_CONSTANTS.backflip.verticalImpulse,
    backwardImpulse: GAME_CONSTANTS.backflip.backwardImpulse,
    superWindowStart: GAME_CONSTANTS.backflip.superWindowStart,
    superWindowEnd: GAME_CONSTANTS.backflip.superWindowEnd,
    superThrowMultiplier: GAME_CONSTANTS.backflip.superThrowMultiplier,
    qte: GAME_CONSTANTS.backflip.qte
  },

  ball: {
    radius: GAME_CONSTANTS.ball.radius,
    pickupRadius: GAME_CONSTANTS.ball.pickupRadius,
    slowPickupSpeed: GAME_CONSTANTS.ball.slowPickupSpeed,
    gravity: GAME_CONSTANTS.ball.gravity,
    quickThrowSpeed: GAME_CONSTANTS.ball.quickThrowSpeed,
    chargedThrowSpeed: GAME_CONSTANTS.ball.chargedThrowSpeed,
    maxChargeSeconds: GAME_CONSTANTS.ball.maxChargeSeconds,
    chargeMinMultiplier: GAME_CONSTANTS.ball.chargeMinMultiplier,
    // Gravity multipliers for a ball's first flight (see Ball.dropScale / ThrowSystem):
    // charged/super fly straight, a quick tap drops slightly. 1 = full gravity.
    chargedDropScale: GAME_CONSTANTS.ball.chargedDropScale,
    quickDropScale: GAME_CONSTANTS.ball.quickDropScale,
    curveStrength: GAME_CONSTANTS.ball.curveStrength,
    movementThrowScale: GAME_CONSTANTS.ball.movementThrowScale,
    secondThrowDelaySeconds: GAME_CONSTANTS.ball.secondThrowDelaySeconds,
    fastDoubleThrowPenalty: GAME_CONSTANTS.ball.fastDoubleThrowPenalty,
    bounceRestitution: GAME_CONSTANTS.ball.bounceRestitution,
    impactSoundMinBounceHeight: GAME_CONSTANTS.ball.impactSoundMinBounceHeight,
    deadAfterBounces: GAME_CONSTANTS.ball.deadAfterBounces,
    deflectedDeadAfterBounces: GAME_CONSTANTS.ball.deflectedDeadAfterBounces,
    settleSpeed: GAME_CONSTANTS.ball.settleSpeed,
    hitRadius: GAME_CONSTANTS.ball.hitRadius,
    liveHitMinSpeed: GAME_CONSTANTS.ball.liveHitMinSpeed,
    looseFriction: GAME_CONSTANTS.ball.looseFriction,
    pickupVerticalTolerance: GAME_CONSTANTS.ball.pickupVerticalTolerance
  },

  mat: {
    restoreHoldSeconds: GAME_CONSTANTS.mat.restoreHoldSeconds,
    restoreReach: GAME_CONSTANTS.mat.restoreReach,
    postResetKnockImmunitySeconds: GAME_CONSTANTS.mat.postResetKnockImmunitySeconds
  },

  // Held-ball viewmodel placement (camera-space, visual only — does not affect aim).
  hands: {
    holdForward: 0.5,
    holdSide: 0.34,
    holdDrop: -0.42
  },

  // First-person arm viewmodel. Poses are camera-local meters; the held ball is snapped to the
  // animated hand each frame so arm and ball always read as one unit. Visual only.
  arms: {
    forearmLength: 0.46,
    forearmRadius: 0.058,
    handRadius: 0.085,
    // Rest pose (empty hand): lowered and tucked toward screen center, out of the way.
    restForward: 0.34,
    restSide: 0.2,
    restDrop: -0.66,
    // Idle hand bob while holding.
    bobAmplitude: 0.012,
    bobSpeed: 6.5,
    // Charge pulls the hand back; a throw punches it forward then eases home.
    windupPull: 0.24,
    windupLift: 0.31,
    windupSide: 0.07,
    throwReach: 0.44,
    throwDrop: 0.2,
    throwCenter: 0.16,
    throwAnimSeconds: 0.3,
    fakeAnimSeconds: 0.22,
    // Pose smoothing rate (higher = snappier follow).
    smoothing: 18
  },

  catch: {
    coneDegrees: GAME_CONSTANTS.catch.coneDegrees,
    superParryConeDegrees: GAME_CONSTANTS.catch.superParryConeDegrees,
    trackingSeconds: GAME_CONSTANTS.catch.trackingSeconds,
    rangeMeters: GAME_CONSTANTS.catch.rangeMeters,
    cooldownSeconds: GAME_CONSTANTS.catch.cooldownSeconds,
    catchBoostSpeed: GAME_CONSTANTS.catch.catchBoostSpeed,
    catchBoostDuration: GAME_CONSTANTS.catch.catchBoostDuration,
    momentumRecoilMinSpeed: GAME_CONSTANTS.catch.momentumRecoilMinSpeed,
    momentumRecoilMaxSpeed: GAME_CONSTANTS.catch.momentumRecoilMaxSpeed,
    momentumRecoilMinDistance: GAME_CONSTANTS.catch.momentumRecoilMinDistance,
    momentumRecoilMaxDistance: GAME_CONSTANTS.catch.momentumRecoilMaxDistance,
    momentumRecoilDuration: GAME_CONSTANTS.catch.momentumRecoilDuration,
    bouncedCatchMaxBounces: GAME_CONSTANTS.catch.bouncedCatchMaxBounces,
    bouncedCatchMinSpeed: GAME_CONSTANTS.catch.bouncedCatchMinSpeed
  },

  parry: {
    coneDegrees: GAME_CONSTANTS.parry.coneDegrees,
    rangeMeters: GAME_CONSTANTS.parry.rangeMeters,
    cooldownSeconds: GAME_CONSTANTS.parry.cooldownSeconds,
    deflectSpeedMultiplier: GAME_CONSTANTS.parry.deflectSpeedMultiplier,
    deflectUpVelocity: GAME_CONSTANTS.parry.deflectUpVelocity
  },

  match: {
    scoreLimit: GAME_CONSTANTS.match.scoreLimit,
    playerLives: GAME_CONSTANTS.match.playerLives,
    lastPlayerBuffMultiplier: GAME_CONSTANTS.match.lastPlayerBuffMultiplier,
    lastPlayerBuffCooldownRateMultiplier: GAME_CONSTANTS.match.lastPlayerBuffCooldownRateMultiplier,
    lastPlayerBuffSeconds: GAME_CONSTANTS.match.lastPlayerBuffSeconds,
    noBoundariesSeconds: GAME_CONSTANTS.match.noBoundariesSeconds,
    halfCourtCountdownSeconds: GAME_CONSTANTS.match.halfCourtCountdownSeconds,
    illegalCrossDeathCountdownSeconds: GAME_CONSTANTS.match.illegalCrossDeathCountdownSeconds,
    resetVoteSeconds: GAME_CONSTANTS.match.resetVoteSeconds,
    illegalCrossWarningsBeforePenalty: GAME_CONSTANTS.match.illegalCrossWarningsBeforePenalty,
    penaltyHitValue: GAME_CONSTANTS.match.penaltyHitValue
  },

  map: {
    halfWidth: GAME_CONSTANTS.map.halfWidth,
    halfLength: GAME_CONSTANTS.map.halfLength,
    // Mirrors GAME_CONSTANTS.map.wallHeight so the client ceiling/walls match the server bounce rule.
    wallHeight: GAME_CONSTANTS.map.wallHeight,
    ballCount: GAME_CONSTANTS.map.ballCount
  },

  // Spectator fly-cam shown to a player while downed (eliminated but the 2v2 match is still
  // live). Detached from the body, no collision — purely a viewing aid.
  freeCam: {
    moveSpeed: 9,
    sprintMultiplier: 2.2,
    verticalCeiling: 22,
    verticalFloor: 0.4
  },

  // Practice bot: an always-on thrower for catch/block practice. It never spawns balls — it
  // grabs the nearest free (loose/dead) ball on the map and lobs it at the player.
  bot: {
    position: { x: 0, y: 0.9, z: 11 },
    throwIntervalSeconds: 2.0,
    throwSpeed: 17,
    // Absolute world height the throw originates from (chest height), so lobs read as catchable.
    throwHeight: 1.4,
    // Upward bias added to the normalized aim direction before the throw is renormalized, so
    // the ball arcs slightly instead of coming dead flat.
    arc: 0.14,
    // Wind-up: the bot grabs and holds a map ball this long before releasing it (brief, so the
    // ball is only out of play for the wind-up). Throwing arm cocks back then swings through.
    windupSeconds: 0.55,
    armLength: 0.62,
    armRadius: 0.075,
    shoulderSide: 0.34,
    shoulderHeight: 0.5, // local Y above the bot's center (capsule center sits at world y=0.9)
    restArmAngle: 0.18, // radians: arm hangs slightly forward at rest
    cockArmAngle: 1.2, // pulled back during wind-up
    throwArmAngle: -1.25, // extended toward the player at release
    armSwingSeconds: 0.18 // follow-through duration after release
  }
} as const;

export type Tuning = typeof TUNING;
