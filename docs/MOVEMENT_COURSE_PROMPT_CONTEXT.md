# Movement Course Prompt Context

Paste the text below into ChatGPT when you want it to interview you about the movement-course map, then turn your answers into a stronger implementation prompt for Codex.

```text
I am designing a new Strafeball movement-course map. Do not design or implement the final course yet. First, ask me focused questions about the course's visual style, layout, teaching order, difficulty, timer/leaderboard rules, checkpoints, reset behavior, and how it should feel to run.

Project identity:
- Strafeball is a browser-based first-person movement dodgeball prototype built with Vite, TypeScript, and Babylon.js.
- The game is set in an early-2000s school gym and combines arena movement, dodgeball combat, two-hand ball control, catching, parrying, and private online duels.
- The main movement fantasy is skillful speed: good movement preserves or builds speed, while mistakes bleed speed.
- The core online mode is performance-sensitive private/ranked-style 1v1, with 2v2 support also present.
- Online play is server-authoritative and uses client-side prediction/reconciliation.

High-level goal for the movement course:
- Build a local/practice movement tutorial that later becomes a timed speedrun course with a leaderboard.
- A clean full run should take about 30 seconds.
- The first version should be readable and replayable: teach the player movement in a deliberate order, then reward optimization.
- The course should eventually support start trigger, checkpoint triggers, finish trigger, timer UI, retry/reset, and leaderboard submission.
- For now, the code only has a blue Movement Course portal in the practice lobby. Entering it teleports the player to a blank local area. The actual course geometry, checkpoints, timer, finish trigger, and leaderboard are not built yet.

Current codebase architecture:
- Client code lives under `src/game`.
- Shared deterministic gameplay code lives under `shared`.
- Server/Colyseus authoritative online code lives under `server`.
- The main scene class is `src/game/scenes/ArenaScene.ts`.
- The local/offline player controller is `src/game/player/PlayerController.ts`.
- Offline practice movement is implemented by `src/game/player/MovementController.ts`.
- Online authoritative/predicted movement uses `shared/simulation/MovementSim.ts`.
- Gameplay constants are defined in `shared/constants.ts` and exposed client-side through `src/game/config/tuning.ts`.
- Gym visuals and local collision are built in `src/game/map/GymArena.ts`.
- Shared collision layout for server/client prediction is in `shared/simulation/MapGeometry.ts`.
- Practice lobby props are under `src/game/practice`, including `LobbyModePortals.ts`, `PracticeControlWall.ts`, and `GuideWall.ts`.
- Multiplayer UI/networking is under `src/game/network`, especially `MultiplayerOverlay.ts` and `MultiplayerClient.ts`.

Current movement-course implementation state:
- `src/game/practice/LobbyModePortals.ts` now has two portal actions:
  - Private Match: opens the existing multiplayer overlay.
  - Movement Course: local-only portal action.
- The movement-course portal is blue, labeled `MOVEMENT COURSE`, and sits near the private-match portal in the practice lobby.
- `src/game/scenes/ArenaScene.ts` handles movement-course activation with `enterMovementCourse()`.
- The current movement-course destination is `MOVEMENT_COURSE_START = new Vector3(0, 0, 14.2)`, facing back into the gym with yaw `Math.PI`.
- `PlayerController.teleportTo()` moves the player cleanly and clears transient movement state through `MovementController.resetKinematics()`.
- Practice props/portals are disabled when online mode starts through `setPracticePropsEnabled(false)`, so the course entry is hidden during connected online play.

Very important performance/isolation constraints:
- Do not add course logic to the server or online match loop unless explicitly requested later.
- Do not add leaderboard polling, network messages, extra online snapshot data, or server simulation for this first course planning/build.
- Do not change `shared/constants.ts`, `shared/simulation/MovementSim.ts`, or server movement behavior just to make the course work.
- Do not add per-frame course work while the player is connected to an online match.
- Prefer a local-only module, for example something like `src/game/practice/MovementCourse.ts`, owned by `ArenaScene` and enabled only in offline/practice mode.
- Course meshes/collision should be cheap and modular. Avoid art-heavy or high-draw-call geometry for the first version.
- If the course needs collision, use the existing local collision patterns rather than inventing a second physics system.

How the game currently runs:
- `Game.ts` creates `ArenaScene` and calls `arena.update()` every render frame.
- Offline/practice mode runs `ArenaScene.step(dt)`.
- Online mode runs `ArenaScene.stepOnline(dt, frameMs)`.
- Offline player movement uses `PlayerController.update()`, which reads input, updates `MovementController`, then updates hands/catch/viewmodel.
- Online mode uses `PlayerController.updateOnline()` for look/viewmodel only; movement itself comes from shared prediction and server snapshots.
- This split matters: the movement course should live in the offline/practice path and should not touch the online prediction/snapshot path.

Existing controls:
- WASD: move
- Mouse: look/aim
- Space: jump, wall-jump, or dash-powered double-jump/upward dash
- Shift: dash
- Ctrl: crouch
- C: slide
- Q: backflip
- E: interact/pickup/portal hold
- R: drop ball
- F: fake/cancel throw
- M1/M2: left/right hand actions
- K/J/U/L/Tab are debug/reset/practice controls

Movement mechanics the course should teach or test:
- Basic WASD and mouse-look: player should understand movement direction relative to camera/yaw.
- Ground acceleration: movement accelerates toward a wish direction instead of instantly snapping to max speed.
- Bunny-hop timing: jumping soon after landing can preserve/build speed; bad timing bleeds speed.
- Air strafing: in the air, side input and mouse turning can add speed while forward/back input mostly preserves momentum.
- Slide: pressing C or crouch while moving fast can start a slide. Slides preserve speed briefly, have minimum duration, and can be chained into slide-jumps.
- Slide buffering: holding slide/crouch in the air can arm a slide on landing.
- Dash: Shift spends one of three dash charges and applies a directional impulse based on WASD or facing.
- Dash direction matters: dashing with current momentum carries better; dashing against momentum is intentionally weaker.
- Dash friction window: after a dash, ground friction is briefly suppressed so the burst feels meaningful.
- Dash-powered double-jump/upward dash: pressing Space while airborne can spend a dash charge for an upward dash if available.
- Wall-run: while airborne near a wall and moving at a shallow enough angle, the player automatically attaches to a short wall-run.
- Wall-run vertical control: holding W engages the run; A/D while holding W adjust height relative to the wall side. Runs cannot be sustained forever.
- Wall-jump: pressing Space during a wall-run kicks the player away from the wall and upward.
- Wall-bounce: if the player hits a wall too head-on to wall-run, pressing jump near the wall can bounce away without spending dash.
- Backflip: Q starts a backward/upward flip movement. In combat it connects to a landing QTE for throws, but the course can use it as movement tech.
- Momentum routing: the best course should make players aim, turn, slide, jump, dash, and wall-move in a way that rewards maintaining flow.

Combat mechanics that may matter for theme, but are probably optional for the first course:
- The player has two hands, M1 and M2.
- Balls can be picked up, held, thrown quickly, charged, faked, dropped, curved from crouch, or thrown through a backflip landing QTE.
- Catching is a timed empty-hand attempt based on cone/range.
- Auto-parry can happen with two held balls.
- Player movement speed contributes to throw speed.
- A movement course can ignore combat at first unless we intentionally add optional target/throw gates.

Existing map/theme context:
- The main map is a symmetrical school gym with court lines, center line, bleachers, padded walls, mats, dummies, ceiling, lights, and scoreboards.
- Practice mode already has local bots, target dummies, guide panels, and a control wall.
- The course can either stay inside the gym as a training extension or later become a separate course area/room, but first implementation should stay simple and cheap.
- The first course should use readable course-language: start pad, checkpoint markers, finish pad, arrows/paint/colored trim, wall-run lanes, landing pads, and failure/reset zones.

Questions you should ask me before designing:
- Visual style: gym extension, obstacle course, neon training room, school hallway, rooftop/parkour vibe, or something else?
- Route shape: linear sprint, loop, branching shortcuts, vertical climb, half-pipe style, or mixed segments?
- Teaching order: which mechanics should be introduced first, and which should be combined near the end?
- Difficulty: beginner tutorial, medium challenge, advanced speedrun, or a course with optional expert skips?
- Failure rules: falling resets to last checkpoint, full restart, or no failure states?
- Checkpoints: how many, where, and should each checkpoint teach one mechanic?
- Timer rules: when does the timer start, pause, reset, and finish?
- Leaderboard rules: local-only first, online later, friends/global, username handling, anti-cheat expectations, and whether resets/shortcuts invalidate runs.
- Movement aids: should there be arrows, ghost route, ghost replay, speed display, checkpoint split times, or brief text labels?
- Course content: which obstacles should exist, such as slide tunnel, bhop pads, dash gaps, wall-run panels, wall-bounce corners, vertical wall-jump section, backflip gate, or momentum turn section?
- Combat integration: should the course include throwing/catching gates later, or stay pure movement?
- Reset/retry UX: keybind, pause/menu button, portal return, death plane, and restart-from-last-checkpoint behavior.
- Performance limits: target visual complexity, expected device/browser performance, and whether this must run in competitive graphics mode only.

After I answer your questions:
- Produce a polished implementation prompt for Codex/ChatGPT.
- The implementation prompt should specify which files to add/edit, what to avoid touching, what acceptance criteria to verify, and how to keep the feature isolated from online 1v1 performance.
- Keep the first implementation scoped: local course geometry, start/finish/checkpoint logic, timer UI, reset behavior, and no real online leaderboard unless explicitly requested.
```
