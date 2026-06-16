# Strafeball Complete Master Spec

This document is the complete design context for the current Strafeball prototype. Claude Code should treat this as the highest-authority design document, then use `src/game/config/tuning.ts` for exact numeric values.

## Project Identity

Name: Strafeball

Genre: Browser-based first-person ranked movement dodgeball.

Core pitch: Strafeball is a first-person competitive movement dodgeball game set in an early-2000s high-school gym, where M1 and M2 are the player’s actual hands, balls are limited resources, catching is an aim-tracking mechanic, and advanced movement chains create speed, pressure, and highlight plays.

Target feel: Movement inspired by Deadlock, Apex, and Splitgate, but with more freedom and a higher ceiling. The game should have almost no obvious hard speed limit. Good players should preserve or build speed through chains. Mistakes should bleed speed.

Tone: Competitive first, with funny high-school gym flavor. Not childish, not fake esports cringe, not sci-fi. Gym class treated way too seriously.

Theme baseline: Stylized early-2000s high-school gym, greybox first. Normal students eventually. Clean/cartoon impacts, no blood.

## Tech Stack

Use:
- Vite
- TypeScript
- Babylon.js
- No React for the game canvas
- No external assets for the initial prototype
- Primitive geometry and simple readable materials first

Future multiplayer direction:
- Node.js + Colyseus or similar authoritative server framework
- Authoritative server
- Client-side prediction
- Server reconciliation
- Remote interpolation
- Lag-aware catch/throw validation
- Minimal network payloads
- Server-side scoring, ball states, and hit validation

## Performance Philosophy

Performance and responsiveness are non-negotiable. The project must be structured from the beginning like a future competitive online game.

Rules:
- Separate render logic from gameplay/simulation logic where practical.
- Avoid unnecessary allocations inside hot update loops.
- Keep movement, hands, throwing, catching, parrying, scoring, and rules modular.
- Keep tuning values in `src/game/config/tuning.ts`.
- Avoid hardcoding gameplay constants throughout the codebase.
- Prefer deterministic/portable simulation logic where possible so systems can later move server-side.
- Do not make client-authoritative scoring assumptions that would be impossible to validate later.
- Prototype may be local-only, but it should not be sloppy or throwaway.

## MVP / Prototype Scope

The requested first build is a serious local greybox prototype, not multiplayer yet.

The first build should include:
- First-person pointer-lock controller
- Full movement basics
- Greybox school gym
- Ball spawning
- Ball pickup
- Two-hand possession system
- Quick throws
- Charged throws
- Crouch curve throws
- Backflip
- Backflip super throw
- Target dummies
- Hit scoring against dummies
- Catching system
- Catch stance
- Auto-parry test logic
- Speed boost on successful catch
- HUD
- Debug/tuning values
- Testing tools such as reset balls, spawn/reset player, ball launcher for catch tests, and dummy targets

Do not add yet:
- Multiplayer
- Ranked backend
- Accounts
- Cosmetics
- Complex menus
- Real art/assets
- Progression systems

## Controls

- WASD = movement
- Mouse = look/aim
- M1 = left hand
- M2 = right hand
- Space = jump / bhop timing
- Shift = dash
- Ctrl = hold crouch / instant crouch
- C = slide
- Q = backflip
- F = fake throw / cancel charge
- R = drop held ball
- E = interact / pick up nearby balls
- Mouse wheel = reserved for future hand swap or throw type, do not implement yet unless needed

## Hand System

This is a core identity mechanic.

M1 is always the left hand. M2 is always the right hand.

Each hand can be empty or holding one ball. Player can hold 2 balls max.

If a hand is empty:
- Tap that hand button = attempt catch with that hand.
- Hold that hand button = enter catch/tracking stance with that hand.

If a hand has a ball:
- Tap that hand button = quick throw from that hand.
- Hold that hand button = charge throw from that hand.
- Release that hand button = release charged throw.
- Press F while charging = fake/cancel charge.
- Press R = drop held ball.

Hand states should be explicit in code and easy for HUD/debugging to read.

## Ball Possession and Pickup

- Players can hold 2 balls max.
- Press E to pick up nearby valid balls.
- E should pickup any valid ball around the player within pickup radius.
- Treat the left hand as dominant/default for first pickup.
- If both hands are empty, first pickup always goes to left hand.
- If one hand is full, pickup goes to the empty hand.
- If both hands are full, pickup does nothing.
- Players can pick up balls while sliding.
- Players cannot pick up balls mid-air. Mid-air balls must be caught.
- Players can pick up balls that are moving slowly.
- Players can pick up balls after they bounce and become dead/loose.
- Players can catch their own bounced ball.
- Players can pick up enemy-thrown balls after they are dead/loose.

## Ball States

Use an explicit ball state machine.

Live Ball:
- A thrown ball that has not bounced yet.
- Can hit a player.
- Can be caught.
- Can be auto-parried if conditions are met.

Dead/Loose Ball:
- A ball that bounced once, slowed enough, was deflected, or otherwise lost threat status.
- Does not count as an offensive projectile.
- Can be picked up with E.
- Can optionally still be caught if conditions are met.

Held Ball:
- Ball is owned by one hand and should not simulate as a world projectile.

Important rule:
- Once a ball bounces once, it is dead/loose and can be picked up normally or caught.

## Catching

Catching is an aim-tracking mechanic, not a free block.

Catching requirements:
- Hand must be empty.
- Player must be facing the ball.
- Ball must remain within a 25-degree tracking cone long enough.
- Player must track the incoming ball for at least 0.2 seconds.
- Ball must be within 5 feet / 1.524 meters to complete the catch.
- Player must click/tap the correct empty hand during the catch window.

Catch stance:
- Holding an empty hand button enters catch/tracking stance.
- Catch stance can be held indefinitely.
- Catch stance slows movement.
- Catch stance should visibly extend the hand and be obvious to opponents.

Allowed catching states:
- Catching while sliding: yes.
- Catching while airborne: yes.
- Catching while wall-running: yes.
- Catching during dash: no.

Missed catch:
- If the ball hits the player, that is already the punishment.
- If the ball does not hit the player, apply only a basic catch cooldown.
- Do not add a major movement slowdown or stun.

Successful catch:
- Gives possession of the ball.
- Resets catch cooldown.
- Gives a small speed boost.

Supercharged backflip throws:
- Can be caught.
- Catch timing rules are the same, but the throw is faster, making it naturally harder.

## Auto-Parry

Auto-parry is defensive power from holding two balls. It is not catching.

Requirements:
- Player must hold 2 balls.
- Incoming ball must be live/threatening.
- Player must look within 30 degrees of the incoming ball.
- Auto-parry cooldown must be ready.
- Max 1 auto-parry per second.

Effect:
- Deflects the incoming ball.
- Deflected ball does not count as an offensive projectile.
- Deflected ball becomes dead/loose after deflection.
- Auto-parry does not normally consume a held ball.

Supercharged backflip throw interaction:
- Auto-parry can stop a supercharged backflip throw.
- Player must be looking almost directly at it; use a tighter 10-degree check.
- If a supercharged backflip throw is auto-parried, defender drops one held ball.
- Dropped ball can be picked up.

If player has only one ball:
- No auto-parry.
- Player must catch with empty hand, dodge, or movement-outplay.

## Throwing

Basic throw logic:
- Quick throw: tap a hand button while that hand holds a ball.
- Charged throw: hold a hand button while that hand holds a ball, release to throw.
- Fake/cancel: F while charging.

Regular quick throw:
- Fast-ish throw for now.
- Slight projectile drop.

Charged throw:
- Higher speed.
- Flies perfectly straight.

Movement influence:
- Player movement speed adds to throw speed.
- Player movement speed slightly affects curve behavior.

Crouch curve throw:
- Crouch + throw creates a curve throw.
- Same speed as normal.
- Curves opposite of throwing hand.
- Left-hand crouch throw curves right.
- Right-hand crouch throw curves left.

Double throw:
- Left/right double throws are allowed.
- There is a 0.2 second delay between throwing one hand and the other.
- If both balls are thrown quickly, the second throw is slower.

Hit scoring:
- Any body hit counts the same.
- No headshots.
- No limb scoring.

Throw origin:
- Physics can originate from camera center for now if easier to code.
- Visual offset can be added later.

Movement state throwing:
- Throw while sliding: yes, but altered accuracy/curve.
- Throw while wall-running: yes, but reduced max charge.
- Throw while dashing: quick throws only.

## Backflip

- Q always backflips.
- No directional flip variants for now.
- Can backflip while holding two balls.
- Backflip is both defensive and offensive.
- It is risky because the player moves upward predictably.
- Throwing during the correct timing window creates a supercharged throw.
- Supercharged throw travels 2x regular throw speed.
- Cost is cooldown only.
- No penalty if player chooses not to throw during backflip.
- Super throw should have obvious feedback eventually, even if prototype uses placeholder visuals.

## Movement

Target feel:
- Deadlock/Apex/Splitgate-inspired movement with more freedom.
- Almost no obvious hard speed limit.
- Good movement preserves/builds speed.
- Mistakes bleed speed.
- Movement should feel responsive, snappy, and skillful.

Required movement mechanics:
- WASD movement
- Jump
- Medium-difficulty bhop timing
- Dash
- 3 dash charges
- Dash recharges over cooldown
- Getting a hit gives one dash charge
- Directional dash based on WASD input
- Dash keeps/adds momentum if moving in a similar direction
- Dash should not preserve full momentum if used against current movement direction
- Hold crouch with Ctrl
- Crouch is instant
- Crouch is hold, not toggle
- C or Ctrl while moving fast can initiate slide
- Slide
- Slide jump
- Simple 4-direction air strafe first
- Short wall-run
- Wall-run triggers automatically when angled into a wall
- Wall-jump requires pressing Space again
- Backflip on Q

Soft control recommendations:
- Avoid a visible hard speed cap.
- Use soft speed falloff at extreme speeds if needed.
- Bad bhop timing, bad landings, and bad direction changes can bleed speed.
- Wall-run should not enable infinite wall abuse.

## Map and Rules

First map:
- Perfectly symmetrical high-school gym.
- Gym floor.
- Center line.
- Boundary lines.
- Padded walls.
- Bleachers playable/climbable.
- Dodgeball mats as cover.
- Mats are movable physics objects if practical.
- Mats can fall over if players run into them.
- Mats should be sturdy enough to block balls.
- Basketball hoops/backboards are later feature.

Balls on map:
- 6 balls by default.
- Balls spawn on the center line.
- Players can carry 2 max.

Half-court rule:
- Before 2 minutes, half-court rule is active.
- Crossing half-court triggers warning then penalty.
- Agreed penalty direction: first illegal cross = warning; second illegal cross = opponent gains 1 hit.
- After 2 minutes, no-boundaries mode begins and half-court rule is disabled.
- No-boundaries transition: school bell + gym teacher announcer + lights.

Match format:
- First to 5 hits wins.
- No hard time cap.
- Hits are called “hits.”

Ranked/custom:
- Ranked rules fixed.
- Ranked at launch: 1v1 only + private lobbies.
- Private lobbies exist for testing/friends.
- Custom pre-game settings apply to private matches only.
- Ranked backend is not part of the prototype.

## Theme and UI

Announcer:
- Gym teacher.

Hit terminology:
- Hits.

HUD style:
- Hybrid clean esport + school scoreboard.
- Readability first; school flavor second.

Visual style:
- Early 2000s gym class.
- Stylized school gym.
- Normal school outfits eventually.
- Clean/cartoon impact; no blood.
- Greybox first.

HUD should include:
- Crosshair
- Speed meter
- Left hand state: empty / holding ball / charging / catch stance
- Right hand state: empty / holding ball / charging / catch stance
- Dash charges and cooldown
- Catch cooldown
- Auto-parry cooldown
- Score
- Match timer
- No-boundaries timer/state
- Throw charge meter
- Backflip cooldown / super timing indicator
- Debug state readouts for tuning

## Recommended Code Architecture

Suggested source structure:

src/
  main.ts
  game/
    Game.ts
    scenes/
      BootScene.ts
      ArenaScene.ts
    input/
      InputManager.ts
    player/
      PlayerController.ts
      MovementController.ts
      HandController.ts
      CatchController.ts
      DashController.ts
      BackflipController.ts
    ball/
      Ball.ts
      BallManager.ts
      ThrowSystem.ts
      BallState.ts
    map/
      GymArena.ts
      MatObstacle.ts
    rules/
      MatchRules.ts
      ScoringSystem.ts
      BoundaryRules.ts
    ui/
      Hud.ts
      Crosshair.ts
    config/
      tuning.ts
      controls.ts
    utils/
      math.ts
      vector.ts

## High-Risk Mechanics

Claude Code should treat these as the highest-risk areas:
- Movement feel and momentum chaining.
- Catch tracking logic feeling fair and readable.
- Auto-parry not becoming overpowered.
- Hand state conflicts between catching, throwing, charging, faking, dropping, and pickup.
- Ball state transitions: live -> dead -> loose -> held.
- Future server-authoritative compatibility.
- Performance in update loops.

## Tuning Assumptions

Some exact numeric values are implementation assumptions, not final balance:
- Catch stance speed multiplier.
- Catch boost strength/duration.
- Throw speeds.
- Dash impulse and recharge.
- Wall-run length.
- Backflip height and timing window.
- Curve strength.
- Pickup radius.

All of these should remain configurable in `src/game/config/tuning.ts`.
