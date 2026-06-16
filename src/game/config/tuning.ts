export const TUNING = {
  simulation: {
    // The sim runs one variable-length step per rendered frame, clamped to this so a long
    // hitch (alt-tab, GC) can't produce a huge step that tunnels through collision.
    maxDeltaSeconds: 0.05
  },

  player: {
    height: 1.75,
    eyeHeight: 1.58,
    radius: 0.42,
    groundAcceleration: 24,
    airAcceleration: 11,
    // Air "wish speed" cap (Source-style airspeedcap). Small on purpose: the projection in
    // accelerate() means only velocity perpendicular to your current motion can be added,
    // which is exactly what lets mouse-turning while strafing build speed (air-strafing).
    airStrafeMaxSpeed: 1.3,
    friction: 10,
    maxGroundSpeed: 8.5,
    softSpeedLimit: 18,
    // Rate (per second) that speed above the soft limit bleeds off. dt-scaled so it's
    // frame-rate independent.
    softLimitBleedRate: 1.2,
    gravity: 22,
    // Gravity is stronger while falling so jumps feel snappy and weighty, not floaty.
    fallGravityMultiplier: 1.45,
    jumpSpeed: 8.2,
    bhopGraceSeconds: 0.12,
    bhopPerfectWindowSeconds: 0.07,
    bhopSpeedBonus: 1.035,
    crouchHeightMultiplier: 0.62,
    catchStanceSpeedMultiplier: 0.72,
    // Max height a surface (bleacher tier) can be above the feet to still count as
    // standable ground this tick. Bigger steps must be jumped onto.
    stepHeight: 0.45
  },

  slide: {
    minStartSpeed: 6.2,
    impulse: 2.2,
    frictionMultiplier: 0.38,
    minDuration: 0.28,
    maxDuration: 1.2,
    jumpBonus: 1.12
  },

  dash: {
    maxCharges: 3,
    rechargeSeconds: 3.0,
    impulse: 15.0,
    cooldownBetweenDashes: 0.18,
    // Brief window after a dash where ground friction is suppressed so the burst actually
    // carries instead of being bled away the same frame.
    activeSeconds: 0.22,
    similarDirectionDot: 0.35,
    oppositeDirectionMomentumPenalty: 0.55
  },

  wall: {
    // How far off "parallel to the wall" your travel can be and still attach (looser = easier).
    runTriggerAngleDegrees: 55,
    runMaxSeconds: 1.1,
    runGravityScale: 0.15,
    // Vertical velocity is clamped to this floor while wall-running (gentle, controlled slide).
    runMaxFallSpeed: -2.0,
    // Small upward kick when a wall-run starts so you climb a little.
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
    radius: 0.22,
    pickupRadius: 1.55,
    slowPickupSpeed: 2.25,
    gravity: 9.8,
    quickThrowSpeed: 24,
    chargedThrowSpeed: 35,
    maxChargeSeconds: 0.85,
    chargeMinMultiplier: 0.65,
    // Gravity multipliers for a ball's first flight (see Ball.dropScale / ThrowSystem):
    // charged/super fly straight, a quick tap drops slightly. 1 = full gravity.
    chargedDropScale: 0,
    quickDropScale: 0.5,
    curveStrength: 13.5,
    movementThrowScale: 0.35,
    secondThrowDelaySeconds: 0.2,
    fastDoubleThrowPenalty: 0.82,
    bounceRestitution: 0.58,
    deadAfterBounces: 1,
    hitRadius: 0.7
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
    windupPull: 0.16,
    throwReach: 0.34,
    throwLift: 0.12,
    throwAnimSeconds: 0.26,
    // Pose smoothing rate (higher = snappier follow).
    smoothing: 18
  },

  catch: {
    coneDegrees: 25,
    superParryConeDegrees: 10,
    trackingSeconds: 0.2,
    rangeMeters: 1.524,
    cooldownSeconds: 0.45,
    catchBoostSpeed: 3.0,
    catchBoostDuration: 0.25
  },

  parry: {
    coneDegrees: 30,
    rangeMeters: 1.85,
    cooldownSeconds: 1.0,
    deflectSpeedMultiplier: 0.75
  },

  match: {
    scoreLimit: 5,
    noBoundariesSeconds: 120,
    illegalCrossWarningsBeforePenalty: 1,
    penaltyHitValue: 1
  },

  map: {
    halfWidth: 13,
    halfLength: 18,
    wallHeight: 4.5,
    ballCount: 6
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
