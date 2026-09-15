# Neutral Zone + Powerups — Implementation Prompt

This is a ready-to-execute prompt, not an interview doc. The design questions were asked and
answered directly (see "Locked decisions" below); paste the fenced block into a Claude Code session
to implement, phase by phase. Each phase is meant to be independently shippable — stop after any
phase and the game is in a coherent, working state.

Context for why: players hide in the far corners behind the bleachers ("the Netanyahu strat") and
the match stalls. A full-width neutral strip at mid-court that both teams may stand in, with a
Mario-Kart-style random powerup spawning there, gives everyone a reason to leave the corners and
contest the middle. The map grows ~11% to pay for the new section so each team's own half does not
shrink.

Already shipped before this spec (do not redo): all player throw speeds +20%
(`quickThrowSpeed` 24 → 28.8, `chargedThrowSpeed` 35 → 42, catch-recoil window scaled to 36–42).

```text
You are adding two connected features to Strafeball: (1) a full-width NEUTRAL ZONE strip across
mid-court that either team may occupy, with the map expanded ~11% to compensate, and (2) a
Mario-Kart-style POWERUP system — a single random powerup spawns at center court, is picked up by
walking over it, is hidden from everyone but the holder until used, and respawns 20 seconds after
it is taken.

Project identity: Strafeball is a browser-based first-person movement dodgeball prototype
(Vite + TypeScript + Babylon.js client, Colyseus server, server-authoritative netcode with a
SHARED deterministic simulation in shared/simulation/* that both the server and the client's
prediction run). Read README.md and CLAUDE.md if you need broader project context.

Non-negotiable project rule: dist/ is committed AND served. A source-only commit ships nothing.
Run `npm run deploy:prebuild` before every commit; never revert dist/ to tidy a diff.

Read these files before changing anything:
1. shared/constants.ts — GAME_CONSTANTS. `map` (halfWidth 13, halfLength 18, wallHeight,
   ballCount), `match.halfCourtLineZ` (0.25 — the current 0.5 m dead band at center), `dash`
   (maxCharges 3, rechargeSeconds 3 — this IS the "stamina" system), `player` (maxGroundSpeed
   5.95, jumpSpeed 5.08), `ball` (radius 0.22, hitRadius 0.7, maxHeldBalls 2, pickupRadius 1.9,
   deadAfterBounces 1), `catch`, `match.playerLives`.
2. shared/simulation/RuleSim.ts — isIllegalHalfCourtPosition() + applyHalfCourtRule(): the only
   place the half-court boundary is decided. The neutral zone is a change to this check.
3. shared/simulation/MapGeometry.ts — MAT_SPECS (mats at hardcoded absolute x=±4.5, z=±5.5),
   BLEACHER_LAYOUT + createBleacherTierSpecs() (already derive from map.halfWidth/halfLength —
   this is the pattern to follow for everything else), collision box builders.
4. shared/simulation/MovementSim.ts — the halfWidth/halfLength clamp (~line 431) and wall-run
   perimeter detection (~line 521). Dash charge consumption/recharge lives here or in
   PlayerSim.ts — find it; the stamina powerup multiplies these.
5. shared/simulation/BallSim.ts, ThrowMath.ts, WallBounce.ts, CatchFeedback.ts — ball flight,
   bounce, dead-ball rules, throw velocity. Special balls (cannonball, bomb ball) extend these.
6. shared/types.ts — PlayerState (lives, charges, rechargeTimerSeconds, lastPlayerBuffUntilMs is
   an existing precedent for a timed per-player buff), BallState (phase, ownerKind, isSuper,
   bounceCount, throwId), MatchState, MatchStatus.
7. shared/protocol.ts — ThrowEvent / CatchEvent / ParryEvent / HitEvent: the pattern for
   server→client one-shot events you will imitate for powerup pickup, activation, explosions.
8. shared/snapshotCodec.ts — compact + tiered snapshot encoding. New synced entities (the
   powerup pickup, the placeholder timer, special ball flags, heal stations, armor balls) must be
   added here in BOTH encode and decode, and in the tiered lanes.
9. server/src/simulation/ServerGameLoop.ts — the authoritative sim. SPAWN_BASE_BY_SIDE (hardcoded
   z=±12 — must scale), applyPlayerHit() (~line 1986, the ONLY path that deducts a life on a hit;
   bomb/cannonball damage must go through it or a sibling so hit-revert/rollback logic still
   works), applyHalfCourtRule call site (~line 2435), room reset / countdown → playing transition
   (~line 2160 rebuilds lives — the powerup timer resets here too).
10. server/src/rooms/DuelRoom.ts, shared/roomSettings.ts — host match settings pattern (for the
    optional `powerupsEnabled` toggle).
11. src/game/config/tuning.ts — client TUNING mirrors GAME_CONSTANTS.map; keep it derived.
12. src/game/map/GymArena.ts, GymVisualRevamp.ts, GymCoveLighting.ts, CompetitiveLighting.ts,
    Scoreboard3D.ts, BleacherEndCap.ts — client gym visuals. Most already read halfWidth/
    halfLength; audit each for absolute-coordinate literals that assume 13/18. GymArena also owns
    the court-line glow (setLineGlow / courtLineState) — the neutral zone floor is drawn here.
13. src/game/ball/Ball.ts, src/game/ball/BallManager.ts — client ball visuals/prediction. Special
    ball appearance (size, color, fuse) goes here keyed off new BallState fields.
14. src/game/audio/SoundManager.ts, src/game/effects/Effects.ts — how SFX and VFX are triggered
    from events today. New sounds (cannonball, bomb beeps + explosion, pickup, heal tick) follow
    the same pattern.
15. src/game/player/MovementController.ts — client-side predicted movement; any speed/jump/
    stamina multiplier must be applied in the SHARED sim so prediction and server agree, not here.
16. src/game/practice/creator/CreatorGeometry.ts + docs/CREATOR_PUBLIC_RELEASE_PROMPT.md — the
    Creator Sandbox clamps course objects to gym bounds. A bigger gym is a superset, so saved
    courses stay valid; just make sure the clamp reads the new constants rather than literals.

## Locked decisions (already settled — do not re-litigate)

### Map expansion (~11%, "everything scales")
- map.halfWidth 13 → 14.5, map.halfLength 18 → 20. wallHeight unchanged.
- Everything that is currently an absolute coordinate assuming the old size becomes a FRACTION of
  halfWidth/halfLength (or a fixed offset from a wall, where that is the real intent):
  MAT_SPECS (x=±4.5 → ±4.5/13 of halfWidth; z=±5.5 → ±5.5/18 of halfLength), SPAWN_BASE_BY_SIDE
  (z=±12 → ±12/18 of halfLength), any client gym literals found in the audit, practice/creator
  guide walls, scoreboard placement, lighting rigs. Bleachers already scale.
- Ball count stays as is (map.ballCount / host setting). Do not change throw speeds again.
- Do this as its own phase and playtest it alone: the arena should look and feel like the same gym,
  just a little bigger, with no clipping, no floating fixtures, no gap at the wall base.

### Neutral zone
- Shape: a FULL-WIDTH strip, |z| ≤ neutralZoneHalfDepth, across the whole court. Not a circle,
  not a rectangle — the whole point is to give a lane that counters corner camping.
- match.neutralZoneHalfDepth: 3 (6 m deep). This replaces the 0.25 dead band: the legal check in
  isIllegalHalfCourtPosition becomes `position.z > +halfDepth` / `< -halfDepth`. The existing
  warning → countdown → life-loss penalty flow is UNCHANGED for stepping past the far edge of the
  zone into the enemy half.
- Inside the zone EVERYTHING is allowed: you can be hit, throw, catch, parry, dash, pick up balls.
  It is not a safe zone. No throw penalty inside it.
- Visuals: two court lines at z=±3 (the current center-line glow treatment, both lines), a tinted
  floor band between them, and a small HUD indicator ("NEUTRAL") while the local player is inside.
  The old single center line goes away.
- noBoundaries mode keeps working (whole court legal) — the zone is just where the powerup lives.

### Powerup spawn loop
- One powerup slot, at world center (x=0, z=0), floating ~1 m off the floor, visible to everyone as
  a generic mystery-box-style pickup (same look regardless of kind — nobody can tell what it is).
- Pickup by walk-over: first server tick a living player's position is within
  powerup.pickupRadius (1.2 m) horizontally takes it. Server authoritative; no tie-break needed.
- Timer: 20 s AFTER it is taken (not a fixed cadence). While waiting, a grey "loading circle"
  placeholder sits in the same spot and fills clockwise over the 20 s, Mario-Kart style, so both
  teams can see when it is about to respawn. The powerup does NOT despawn if nobody takes it.
- First spawn: 20 s after the round enters 'playing' (the same placeholder ring shows during that
  first wait). Timer pauses during countdown/intermission and resets on room reset. Any held-but-
  unused powerup, active buff, placed heal station, or special ball is cleared on room reset.
- Random kind, uniform over the 6 kinds below, from the server's RNG. No duplicate-avoidance.
- Hidden identity: the powerup's kind is sent ONLY to the holder (a targeted room message or a
  per-recipient field — NOT in the broadcast snapshot). Other clients see only "player X holds a
  powerup" (a small generic icon over their head is fine). Once ACTIVATED the result is visible to
  all where it is physically visible (a cannonball in hand, a bomb ball in hand, a placed heal
  station, armor balls, a speed trail); the stamina/speed buffs need no public tell beyond that.
- Holder UX: on pickup, a brief (~1 s) roulette in the HUD slot that lands on the kind, then the
  icon sits in the slot. One slot only — walking over a second powerup while holding one does
  nothing (it stays on the floor). Activate with a dedicated key (default Q; verify Q is unbound
  in the input map, otherwise pick the nearest free key and note it). Activation is a client input
  flag → server validates → server applies. Hand-item kinds (cannonball, bomb ball, heal station)
  require a free hand; if both hands are full the activation is refused with a HUD nudge and the
  powerup is kept.
- Optional host setting `powerupsEnabled` (default true) via the roomSettings pattern, so the
  system can be switched off for testing/tournaments. Do not gate the neutral zone on it.

### The six powerup kinds
1. ADRENALINE (stamina): for 15 s, dash.maxCharges ×2 (3 → 6, charges refilled to the new max on
   activation) and recharge 50% faster (rechargeSeconds 3 → 2). Reverts to 3 max at expiry
   (clamp current charges down). "Stamina" in this game = dash charges; that also covers
   double-jump and anything else that spends a charge.
2. SPEED: for 15 s, +30% ground top speed (maxGroundSpeed and groundAcceleration ×1.3) and +25%
   JUMP HEIGHT — height scales with jumpSpeed², so jumpSpeed × √1.25 ≈ ×1.118, not ×1.25.
   Must be applied inside the shared sim (MovementSim reads a per-player multiplier) so client
   prediction matches the server. Subtle speed-line VFX on the buffed player for others to read.
3. CANNONBALL: activation materialises a special black ball into a free hand. Held: visibly
   larger than a normal ball (≈2× radius) and black, visible to all. Thrown: 5× regular ball
   radius (1.1 m), UNBLOCKABLE and UNCATCHABLE — catches and parries never succeed against it. It
   hits at charged throw speed regardless of charge (no charge-up), obeys gravity, dies after one
   bounce like a normal ball, and can hit MULTIPLE players along its path (one hit per player per
   throw — it does not stop at the first body). Hit = 1 life via the applyPlayerHit path. While
   holding it the player CANNOT spend stamina: dash, double-jump and backflip are refused. Fired
   with a big cannon-blast SFX; a deep thud on impact. After it dies it is removed (not a
   pickup-able loose ball).
4. HEAL STATION: activation puts a deployable into a free hand (visible green device). Left-click
   /throw places it on the floor ~1.5 m in front of you (must land on the floor inside the court,
   else refused). Placed: a green station with a clearly drawn green disc, radius 1.5 m — enough
   to shuffle around a little, not to fight from. Any LIVING player on the PLACER'S TEAM standing
   inside the disc for 10 continuous seconds gains +1 life (capped at the host's livesPerPlayer).
   Leaving the disc resets that player's progress to 0; being hit does NOT reset it. A ring/HUD
   progress meter shows the 10 s fill. The station disappears after granting one life, or after
   45 s unused. Enemies cannot use or destroy it. Only one station per placer at a time.
5. BALL MAGNET: for 20 s. Every LOOSE (dead/settled, not held, not live in flight) ball within
   10 m is pulled toward the player (accelerates toward them, capped speed so it reads as a pull,
   not a teleport). Any loose ball that has been stationary > 3 s is ALSO pulled, from any
   distance, at a much gentler rate. Balls that reach the player are picked up normally until both
   hands are full; further arriving balls ATTACH to the player as ARMOR — they orbit/cling to the
   body (visible to all) and each armor ball absorbs one incoming hit instead of a life (the hit
   ball bounces off dead). Cap armor at 3 balls. When the effect ends, all armor balls drop off as
   dead loose balls at the player's feet. Magnet must never pull a ball out of a hand or off a
   live flight, and must never pull the opponents' held balls.
6. BOMB BALL: activation materialises a distinct ball (dark with a visible fuse, visible to all)
   into a free hand. Thrown like a normal ball (charge, curve, everything). It is catchable and
   parryable while in flight and unarmed. The FIRST BOUNCE (floor, wall, mat, ceiling, or a body
   hit that bounces it) ARMS it: a 2 s fuse with 3 distinct, escalating beeps (at ~0.0 s, 0.67 s,
   1.33 s) then an explosion at 2.0 s. Explosion: every player (BOTH teams, including the thrower)
   within bomb.blastRadius (3 m, measured to the player's center) loses 1 life via the
   applyPlayerHit path (attributed to the thrower for stats). An armed bomb can still be picked
   up and thrown again (hot potato) — the fuse keeps running. A caught-before-bounce bomb ball is
   simply now held by the catcher, unarmed. After the explosion the ball is removed (not a loose
   ball). A bomb that is still held when the fuse ends explodes in the holder's hand.

### Netcode / correctness constraints
- Every gameplay effect is decided on the server in ServerGameLoop / shared sim and reaches the
  client via the snapshot codec or a protocol event. No client-side gameplay authority.
- Movement modifiers (SPEED, ADRENALINE, cannonball stamina lock) must live in the SHARED sim keyed
  off fields in PlayerState that are in the snapshot, so client prediction + server
  reconciliation agree. Precedent: lastPlayerBuffUntilMs. Prefer one generic
  `buffs: { kind, untilMs }[]` (or fixed per-kind `untilMs` fields — pick the one that codec
  compresses better) over one-off booleans.
- Special balls extend BallState with a `kind: 'normal' | 'cannon' | 'bomb'` (+ `armedAtMs` for
  bombs) so BallSim/catch/parry/hit code can branch on it. Client Ball.ts renders size/colour/
  fuse from `kind`. Cannonball hit-radius math uses the 5× radius; everything else keeps
  ball.radius.
- Bomb/cannonball damage MUST reuse applyPlayerHit (or a sibling that updates the same defense
  history / hit-revert bookkeeping) so the existing lag-compensated catch/parry rollback in
  ServerGameLoop stays consistent. Read how HitRevertEvent is produced before writing damage code.
- The powerup identity must not leak: do not put `kind` into any broadcast snapshot lane while the
  powerup is unused. Test this explicitly (a second client's decoded state must not contain it).
- The tiered snapshot codec has per-lane inclusion rules; new fields must be routed through the
  right lane and included in the full-snapshot resync path.
- Offline / practice / Creator Sandbox modes: draw the neutral zone floor there too (it is just
  gym geometry), but the powerup system is ONLINE ROOMS ONLY for this spec. Do not wire it into
  the practice bot or courses.

## Phases (each independently shippable)

Phase 0 — Map expansion.
  Constants to 14.5/20; convert every absolute literal to a fraction/offset (mats, spawns, gym
  visuals, practice walls, creator clamp). Playtest the gym alone. Update tests that hardcode
  positions. Tests: mats/spawns/bleachers derive from constants; ball wall bounce + player clamp
  use the new bounds.

Phase 1 — Neutral zone.
  neutralZoneHalfDepth constant; RuleSim change; two court lines + floor band + HUD indicator;
  remove the old center-line-only glow. Tests: legal at z=±2.9 for both teams, illegal at ±3.1 for
  the wrong team, warnings/penalties unchanged, noBoundaries still whole-court.

Phase 2 — Powerup pickup + inventory + spawn loop.
  Server: powerup slot state (spawned | waiting {sinceMs}), pickup, 20 s-after-taken timer, RNG
  kind, holder-only identity message, activation input + validation, room-reset clearing, optional
  powerupsEnabled setting. Client: pickup mesh, placeholder loading ring, HUD slot with roulette,
  generic "holds a powerup" marker over other players, activate key. Ship with kinds 1 + 2 only
  (ADRENALINE, SPEED) so the loop is end-to-end testable with the simplest effects. Tests: spawn
  timing, first-tick-wins pickup, identity not in broadcast snapshot, activation refused when
  dead / when not holding.

Phase 3 — ADRENALINE + SPEED buffs.
  Generic timed-buff fields on PlayerState in the codec; shared-sim multipliers for dash max/
  recharge, ground speed/accel, jump; expiry clamps; VFX; prediction parity test (client sim and
  server sim produce identical positions with the buff active).

Phase 4 — CANNONBALL + BOMB BALL.
  BallState.kind; materialise-into-hand; cannonball size/unblockable/multi-hit/stamina lock; bomb
  arm-on-first-bounce, beeps, explosion radius damage through applyPlayerHit, hot-potato pickup,
  removal after death/explosion. SFX: cannon blast, cannon thud, 3 beeps, explosion. Tests: catch
  and parry always fail vs cannonball; cannonball hits two players in a line; bomb arms only on
  first bounce; explosion damages both teams incl. thrower; held bomb explodes at fuse end;
  dash/backflip refused while holding cannonball.

Phase 5 — BALL MAGNET + armor.
  Pull forces in BallSim gated by owner buff; stationary-ball tracking (settledSinceMs); armor
  attachment (cap 3) as a per-player armor count + which ball ids; hit absorption in the hit path;
  drop-off on expiry; visuals. Tests: never pulls held/live balls; armor absorbs exactly one hit
  per ball; expiry drops balls as dead loose balls.

Phase 6 — HEAL STATION.
  Hand item + placement validation; station entity in the codec; per-player 10 s dwell timer with
  leave-reset; +1 life capped; team-only; 45 s expiry; single station per placer; visuals + HUD
  fill ring + heal tick SFX. Tests: leaving resets; being hit does not reset; cap; enemy ignored.

Phase 7 — Polish + tuning pass.
  Sound mix, particle/VFX, HUD copy, tune radii/durations from playtests (all tunables are in
  GAME_CONSTANTS with comments). Record any playtest-driven changes in docs/SPEC_LOCKED_DECISIONS.md.

## Acceptance (the whole feature)
- A player who camps the far corner behind the bleachers is worse off than one who contests the
  middle: the neutral strip is safe to stand in for both teams and the powerup keeps landing there.
- Two clients: only the holder's HUD ever shows the powerup kind before activation.
- The placeholder ring fills over exactly 20 s from pickup; the next powerup appears when it fills.
- Each of the six kinds behaves per its locked description in a 2v2 online room, and a room reset
  clears every powerup artefact.
- `npm run deploy:prebuild` succeeds, dist/ is committed, existing tests plus the new ones pass.
```

## Judgment calls made while writing this (override any before you start)

- Map numbers: 14.5 × 20 (≈+11.5% / +11%) rather than a literal 10–15% on both axes — round
  numbers keep fractions clean. Change to 15 × 20.5 if you want the top of the range.
- Zone depth 3 m (6 m strip). Mats scale to about z=±6.1, leaving ~3 m between the zone edge and
  the mats.
- Activation is a key press (Q), not auto-on-pickup, because three of the six kinds are hand items
  that need a free hand and timing.
- Cannonball pierces (multi-hit) and is removed after it dies; it does not become a loose ball.
- Bomb ball hurts the thrower too and can be hot-potatoed after arming; a held bomb explodes in
  hand.
- Heal station is team-only, capped at starting lives, can't be destroyed, 45 s lifetime.
- Magnet armor caps at 3 balls; hit ball bounces off dead when absorbed.
- `powerupsEnabled` host toggle is optional scope — cut it if it drags.
- Powerups are online-only; offline/practice gets the zone geometry only.
