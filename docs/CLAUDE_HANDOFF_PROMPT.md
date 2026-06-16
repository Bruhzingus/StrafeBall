# Claude Code Handoff Prompt

Paste this into Claude Code inside VS Code after opening the project folder.

```text
You are taking over an existing Vite + TypeScript + Babylon.js scaffold for a browser-based first-person competitive movement dodgeball game called Strafeball.

Before changing code, read these files in this order:
1. README.md
2. docs/MASTER_SPEC_COMPLETE.md
3. docs/SPEC_LOCKED_DECISIONS.md
4. docs/PROJECT_BRIEF.md
5. docs/ROADMAP.md
6. src/game/config/tuning.ts
7. src/game/scenes/ArenaScene.ts
8. src/game/player/PlayerController.ts
9. src/game/player/MovementController.ts
10. src/game/player/HandController.ts
11. src/game/player/CatchController.ts
12. src/game/ball/Ball.ts
13. src/game/ball/BallManager.ts
14. src/game/ball/ThrowSystem.ts

Treat docs/MASTER_SPEC_COMPLETE.md as the highest-authority design document. If there is any conflict, ask before changing the design. Use src/game/config/tuning.ts for numeric tuning values.

Do not rewrite the whole project from scratch. Preserve the architecture and improve it incrementally.

Primary goal:
Make the local greybox prototype feel responsive, playable, and easy to tune. This is a serious single-player/local testbed for a future competitive online game, not a throwaway toy.

Top priorities:
1. Run the project and fix any TypeScript/Babylon compile errors.
2. Verify pointer lock and FPS camera behavior.
3. Verify movement inputs work.
4. Polish movement feel:
   - WASD
   - jump
   - medium bhop timing
   - dash with 3 charges
   - slide / slide jump
   - simple 4-direction air strafe
   - short wall-run
   - wall-jump
   - Q backflip
5. Verify hand logic:
   - M1 left hand
   - M2 right hand
   - E pickup
   - first pickup goes to left hand
   - max 2 balls held
   - R drop
   - quick throw
   - charged throw
   - F fake/cancel
6. Verify ball states:
   - live
   - held
   - dead
   - loose
   - once a ball bounces once, it becomes dead/loose
7. Make catching and parry testable:
   - catch stance visible in HUD
   - catch stance slows movement
   - catch stance can be held indefinitely
   - 25-degree tracking cone
   - 0.2s tracking requirement
   - 5-foot catch range
   - catch allowed while sliding, airborne, and wall-running
   - catch not allowed during dash
   - successful catch gives possession and speed boost
   - missed catch is basic cooldown unless ball hits player
   - auto-parry only with two balls
   - 30-degree auto-parry cone
   - 1s auto-parry cooldown
   - supercharged backflip throw auto-parry requires a 10-degree cone and drops a held ball
8. Verify throwing:
   - regular quick throw has slight drop
   - charged throw flies straight
   - movement speed adds to throw speed
   - crouch curve throw curves opposite throwing hand
   - 0.2s delay between double throws, second is slower
   - no headshots or limb scoring
   - sliding/wall-running/dashing throw restrictions match the spec
9. Verify map/rules:
   - symmetrical gym
   - 6 balls on center line
   - playable bleachers
   - movable mats if practical
   - first illegal half-court cross = warning
   - second illegal cross = opponent gains 1 hit
   - after 2 minutes, no-boundaries starts
   - first to 5 hits wins
10. Keep all tuning values in src/game/config/tuning.ts.
11. Keep code modular and future multiplayer-friendly.

Hard rules:
- Do not add React.
- Do not add accounts, cosmetics, ranked backend, or multiplayer yet.
- Do not hardcode gameplay constants outside tuning.ts.
- Do not make hit scoring client-authoritative in a way that cannot later move server-side.
- Do not build fancy art before movement/throw/catch feel good.
- Keep hot game-loop code allocation-light.
- Prefer small, testable changes over giant rewrites.

Performance direction:
This should eventually feel like a serious competitive online game. Architect for low input delay, clear simulation state, future authoritative server logic, client-side prediction, reconciliation, and interpolation. For now, keep the local prototype deterministic and clean enough that simulation code can later be shared with or ported to a server.

After reading the project, provide:
1. A quick diagnosis of what is already implemented.
2. A list of any compile/runtime issues you find.
3. A small implementation plan.
4. Then start fixing and polishing in small steps.
```
