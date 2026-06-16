# Strafeball Roadmap

## Milestone 1: Local greybox prototype

- Make scaffold compile and run
- Movement feels acceptable
- Pickup/throw/drop works
- Ball states are visible/debuggable
- Target dummies can be hit
- Catch training works
- Auto-parry can be tested
- Backflip super throw can be tested

## Milestone 2: Game-feel pass

- Tune acceleration/friction
- Tune slide and bhop timing
- Tune dash charges/recharge
- Tune wall-run/wall-jump
- Tune ball speed/drop/curve
- Tune catch cone/tracking/range
- Tune parry cone/cooldown
- Improve HUD clarity

## Milestone 3: Bot/duel sandbox

- Add simple bot opponent
- Bot can pick up/throw/dodge lightly
- Scoring first to 5
- Half-court rule warning/penalty
- No-boundaries transition

## Milestone 4: Multiplayer architecture spike

- Extract simulation-safe types
- Start shared package
- Add Node/Colyseus server
- Server-authoritative movement/balls/scoring
- Client-side prediction for local movement
- Interpolation for remote player/balls

## Milestone 5: Ranked/private prototype

- Private room codes
- Fixed ranked rules
- Local match summary
- Basic telemetry/logging for tuning
