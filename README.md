# Strafeball Architecture Scaffold

This is a Vite + TypeScript + Babylon.js greybox scaffold for **Strafeball**, a first-person movement dodgeball game.

It is intentionally built as a modular prototype frame, not a polished finished game. The goal is to save Claude Code tokens by giving it a strong structure, locked design rules, and working gameplay architecture to continue from.

## What is included

- Vite + TypeScript project setup
- Babylon.js bootstrapping
- Fixed-timestep style update loop
- Pointer lock input manager
- First-person player controller frame
- Movement controller with placeholders/initial logic for:
  - WASD
  - jump
  - bhop timing frame
  - slide
  - dash charges
  - wall-run/wall-jump frame
  - backflip frame
- Two-hand control system:
  - M1 = left hand
  - M2 = right hand
  - empty hand catch stance
  - held ball quick/charged throw
- Ball state machine:
  - live
  - held
  - dead
  - loose
- Ball manager and throwing calculations
- Catching/parry system frame
- Greybox school gym with:
  - symmetrical court
  - center line
  - bleachers
  - mats
  - dummies
  - 6 center-line balls
- HUD:
  - crosshair
  - speed
  - hand states
  - dash charges
  - score
  - boundary timer
  - debug controls
- Design docs and Claude handoff prompt

## Run locally

```bash
npm install
npm run dev
```

Then open the Vite local URL.

## Important note

This scaffold prioritizes architecture and decision preservation. Claude Code should still tune, debug, and improve the actual gameplay feel. Movement-heavy games need hands-on iteration in-browser.

## Debug controls

- Click canvas: pointer lock
- WASD: move
- Space: jump
- Shift: dash
- Ctrl: crouch
- C: slide
- Q: backflip
- E: pick up ball
- R: drop ball
- F: fake/cancel charge
- M1: left hand
- M2: right hand
- K: reset player position
- J: reset balls to center line
- U: reset match (score, timer, dummies)
- L: launch test ball toward player
