# Strafeball Locked Decisions

## Controls

- WASD = move
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
- E = interact / pick up ball
- Mouse wheel reserved for future use

## Hand system

If hand is empty:
- Tap = attempt catch


If hand has ball:
- Tap = quick throw
- Hold = charge throw
- Release = charged throw
- F = fake/cancel

## Ball possession

- 2 balls max
- E picks up nearby balls
- First pickup goes to left hand
- Pick up while sliding: yes
- Pick up mid-air: no; must catch
- Can pick up slow balls
- Ball becomes dead/loose after first bounce
- Dead/loose balls can be picked up normally
- Can catch your own bounced ball

## Catching

- Catch cone: 25 degrees
- Track incoming ball for 0.2 seconds
- Catch range: 5 feet / 1.524 meters
- Catch allowed while sliding, airborne, wall-running
- Catch not allowed during dash
- Catch stance can be held indefinitely
- Catch stance is visually obvious
- Catch stance slows movement
- Missed catch: basic cooldown unless ball hits you
- Successful catch gives possession, resets catch cooldown, and grants speed boost
- Supercharged backflip throws are catchable with same timing, but much harder due to speed

## Auto-parry

- Requires holding 2 balls
- Requires looking within 30 degrees of incoming ball
- Max 1 auto-parry per second
- Deflects ball but does not make it an offensive projectile
- Supercharged backflip throw can be auto-parried only when looking almost directly at it; scaffold uses 10 degrees
- Auto-parrying a super throw makes defender drop a held ball

## Throwing

- Regular quick throw has slight drop
- Charged throw flies straight
- Movement speed adds to throw speed and slightly affects curve
- Crouch throw curves opposite the hand
- Crouch curve has same speed
- Double throw has 0.2s hand-to-hand delay
- If both balls are thrown quickly, second is slower
- Any body hit counts the same
- No headshots or limb scoring
- Physics can originate from camera center for now
- Throwing while sliding: yes, altered accuracy/curve
- Throwing while wall-running: yes, reduced max charge
- Throwing while dashing: quick throws only

## Backflip

- Q always backflips
- Can backflip with 2 balls
- Used as both style/offense and defensive dodge
- Risky because it goes upward predictably
- Throw during timing window = supercharged throw
- Super throw is 2x regular speed
- Cost: cooldown only
- No penalty if player chooses not to throw

## Movement

- Directional dash based on WASD
- 3 dash charges
- Hit grants one dash charge
- Dash keeps/adds momentum if similar direction
- Medium bhop difficulty
- Simple 4-direction air strafe first
- Wall-run triggers automatically when angled into wall
- Wall-jump requires Space
- C and Ctrl can both slide depending on movement state
- Crouch is hold

## Map

- Symmetrical high-school gym
- 6 balls on center line
- Bleachers playable/climbable
- Mats are movable cover and block balls
- Mats can fall if hit by player
- Backboards/hoops later
- Half-court before 2 minutes: warning then penalty
- After 2 minutes: no-boundaries mode

## UI/theme

- Gym teacher announcer
- Hits are called hits
- HUD is clean esport + school scoreboard hybrid
- Normal school outfits eventually
- Cartoon impact/no blood
- Early 2000s gym class style
