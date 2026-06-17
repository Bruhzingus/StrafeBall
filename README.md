# StrafeBall

StrafeBall is a first-person movement dodgeball prototype set in a school gym. It mixes arena movement, two-hand throwing, catching, parrying, wall-runs, wall-jumps, double-jumps, and private online 1v1 duels.

The project is still a prototype, but it is playable locally and has a shared client/server simulation path for the mechanics that affect prediction.

## Features

- Babylon.js first-person gym arena with court lines, bleachers, mats, dummies, solid ceiling, and gym-style scoreboards
- Local practice lobby with practice controls, bots, guide panels, and target dummies
- Private Colyseus 1v1 rooms with server-authoritative movement, hands, ball state, scoring, countdowns, resets, and buzzer feedback
- Shared movement and ball simulation for online prediction/reconciliation
- Movement:
  - WASD movement
  - bunnyhop timing
  - dash stamina charges
  - dash-powered double-jump
  - slide
  - crouch
  - wall-run and wall-jump
  - backflip with landing QTE
- Combat:
  - left/right hand controls
  - pickup/drop
  - quick, charged, fake, crouch-curve, and backflip-QTE throws
  - timed catch attempts based on facing/cone
  - auto-parry with two held balls
  - stamina regain on successful catch and perfect backflip throw
- HUD:
  - crosshair
  - debug stats and tick/snapshot rates
  - stamina bar
  - hand states
  - match scoreboard
  - backflip QTE bar

## Requirements

- Node.js 20+ recommended
- npm

## Run Locally

Install client dependencies:

```bash
npm install
```

Start the Vite client:

```bash
npm run dev
```

Open the local URL printed by Vite, usually `http://localhost:5173`.

## Run Multiplayer Locally

In one terminal, start the Colyseus server:

```bash
cd server
npm install
npm run dev
```

The server listens on `ws://localhost:2567` by default.

In another terminal, start the client pointed at the local server:

```bash
VITE_SERVER_URL=ws://localhost:2567 npm run dev
```

PowerShell:

```powershell
$env:VITE_SERVER_URL='ws://localhost:2567'; npm run dev
```

In the browser, use the Private Duel panel:

1. Enter a name and click Create.
2. Share the room code.
3. Join from a second tab/window with that code.

## Scripts

Client:

```bash
npm run dev
npm run typecheck
npm test
npm run build
npm run preview
```

Server:

```bash
cd server
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

## Controls

- Click canvas: pointer lock
- WASD: move
- Mouse: look / aim
- Space: jump / wall-jump / double-jump
- Shift: dash
- Ctrl: crouch
- C: slide
- Q: backflip
- E: pick up ball
- R: drop ball
- F: fake / cancel throw
- M1: left hand
- M2: right hand
- K: reset / vote reset
- J: reset balls
- U: reset match
- L: launch test ball
- Tab: toggle debug HUD

## Architecture Notes

Prediction-sensitive gameplay should stay in shared code whenever possible:

- `shared/constants.ts`
- `shared/simulation/MovementSim.ts`
- `shared/simulation/BallSim.ts`
- `shared/simulation/HandSim.ts`
- `shared/simulation/ThrowMath.ts`
- `shared/simulation/CollisionMath.ts`
- `shared/types.ts`

The client uses shared movement simulation for prediction and replay. The server uses the same movement code as the authoritative source of truth. Keep gameplay constants shared so practice mode, prediction, and 1v1 behavior do not drift.

## Project Layout

```text
src/                 Vite/Babylon client
src/game/            Client gameplay, rendering, HUD, input, effects
shared/              Shared constants, types, and simulation logic
server/              Colyseus server and authoritative game loop
tests/               Client/shared Vitest coverage
server/tests/        Server Vitest coverage
docs/                Design and planning notes
```

## Status

This is an active gameplay prototype. The code favors fast iteration while keeping online-critical movement, ball, throw, catch, and scoring behavior deterministic enough for client prediction and server reconciliation.
