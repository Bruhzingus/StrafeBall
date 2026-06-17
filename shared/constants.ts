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
    crouchWalkSpeed: 2.0,
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
    stepHeight: 0.45,
    ceilingClearance: 0.12
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
    jumpBonus: 1.12,
    // Holding slide/crouch keeps the burst briefly, then bleeds into a slow crouch walk.
    overholdBrakeDelay: 0.75,
    overholdFrictionMultiplier: 2.6,
    overholdStopSpeed: 0.85
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
    cooldownSeconds: 5.6,
    durationSeconds: 0.72,
    verticalImpulse: 10.5,
    backwardImpulse: 4.8,
    // Legacy "super window" timing — superseded by the landing quick-time event (see qte below).
    // Kept so any remaining isSuperThrowWindow callers compile; the value no longer gates throws.
    superWindowStart: 0.25,
    superWindowEnd: 0.52,
    superThrowMultiplier: 2.0,
    // Landing quick-time event: after a backflip, the moment you land while holding a ball a timing
    // bar sweeps for `qteDurationSeconds`. Clicking maps the cursor's offset-from-center to one of
    // `qteTierCount` success tiers; tier 1 (edges of the hit zone) throws at quickThrowSpeed, tier 5
    // (dead center) throws at the fastest backflip speed. A click outside the hit zone (|offset| >
    // qteHitHalfWidth) — or letting the bar lapse — throws nothing and keeps the ball.
    qte: {
      durationSeconds: 0.7,
      // Delay (s) after landing before the bar appears + starts sweeping, so it isn't jarringly
      // instant on touchdown.
      armDelaySeconds: 0.15,
      // Half-width (as a 0..1 fraction of the bar half-length) of the region that counts as a hit.
      // Clicks with |offset| beyond this are a miss (no throw).
      hitHalfWidth: 0.62,
      tierCount: 5,
      // Per-tier band edges as fractions of hitHalfWidth, from center outward. The top tier (fastest)
      // covers [0, edge0]; tier 4 covers [edge0, edge1]; … tier 1 covers [edge3, edge4=1]. Non-uniform
      // on purpose: a SMALL center band (hard to land the top tier) and progressively WIDER outer
      // bands (the slower tiers are easier / span more of the sweep time).
      tierBandEdges: [0.08, 0.20, 0.35, 0.62, 1.0] as number[],
      // Tier speed multipliers applied to quickThrowSpeed, slowest (tier 1) → fastest (tier 5).
      // Tier 5 = 10% faster than the old backflip super (quick×2.0): quick×2.2. Tier 1 = quick×1.0.
      tierSpeedMultipliers: [1.0, 1.3, 1.6, 1.9, 2.42] as number[]
    }
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
    impactSoundMinBounceHeight: 0.305,
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
    // Reduced 1 ft (0.305 m) from 3.62 -> 3.315 m for a tighter catch reach.
    rangeMeters: 3.315,
    cooldownSeconds: 0.47,
    catchBoostSpeed: 3,
    catchBoostDuration: 0.25,
    momentumRecoilMinSpeed: 14,
    momentumRecoilMaxSpeed: 32,
    momentumRecoilMinDistance: 0.035,
    momentumRecoilMaxDistance: 0.14,
    momentumRecoilDuration: 0.2,
    // A bounced/dead ball can still be caught while it is moving in flight. Keep this effectively
    // unlimited so wall/floor/cover rebounds remain playable instead of turning into dead visuals.
    bouncedCatchMaxBounces: Number.MAX_SAFE_INTEGER,
    bouncedCatchMinSpeed: 3.0
  },

  parry: {
    // Auto-parry stays automatic while aiming within this cone of an incoming live ball. 30° gives
    // enough tolerance that a shot to the head/feet or slightly off-center still parries as long as
    // you're looking in its direction — the old 20° felt broken on anything but a dead-center shot.
    coneDegrees: 30,
    // The ball must come within this distance of your eye to parry. The old 0.925 m meant the ball
    // had to be almost touching your face: a fast throw was only inside that shell for ~1 frame, so
    // parries fired inconsistently or not at all. Matched closer to the catch reach so you can knock
    // an approaching ball away instead of only one already on top of you.
    rangeMeters: 2.6,
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
    catchActiveMs: 220,      // active window the swept ball must cross the cone within (covers
                             // anticipation + the rewind scan; not a "free block" — cone/range gated)
    catchCooldownMs: 470,    // ~250–400ms recovery before another attempt is allowed
    // LAG COMPENSATION. A catch click is judged against the world the defender SAW, not the present
    // server state. The defender's view trails the server by ~(interpolation delay + their ping),
    // and the click takes another ~ping to arrive — so by the time a fast straight throw's catch
    // click reaches the server the ball has usually already hit/passed. We rewind the catch
    // evaluation by `catchRewindMs` and check the ball's swept path from HISTORY at that rewound
    // time, each tick the window is open (the window scans a span of recent history). Fixed value
    // (no per-client RTT plumbing): sized to cover ~75ms interp + ~2×(typical 0–75ms ping).
    catchRewindMs: 150,
    // A hit's score is REVERTED if a lag-compensated catch legitimately claims the same ball within
    // this window (a high-ping defender whose well-timed catch arrived after the server applied the
    // hit). Must exceed catchRewindMs so a catch rewound that far can still cancel the hit.
    catchHitGraceMs: 220,
    defenseMaxRewindMs: 200, // hard cap on how far catch evaluation may rewind from "now"
    defenseInputGraceMs: 60, // slack around the rewound moment when sampling history
    defenseHistoryMs: 520    // recent defensive/ball history retained (must exceed maxRewind+active)
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
    oppositeDirectionImpulseScale: 0.7,
    // Double-jump uses a dash charge and behaves like an upward dash.
    upwardImpulse: 7.15
  },

  match: {
    teamIds: ['blue', 'red'] as string[],
    playersPerTeam: 2,
    disconnectForfeitSeconds: 15,
    scoreLimit: 5,
    noBoundariesSeconds: 120,
    halfCourtCountdownSeconds: 10,
    resetVoteSeconds: 20,
    illegalCrossWarningsBeforePenalty: 1,
    penaltyHitValue: 1,
    halfCourtLineZ: 0.25,
    // Pre-round countdown: players are pinned to spawn (look only) for this long when a match starts
    // and after every reset, then play begins. Also the deterministic post-reset state that fixes
    // the old "everyone stuck after a 1v1 reset" bug.
    countdownSeconds: 5
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
