# Netcode & Playtest Guide

This is the operating manual for Strafeball's multiplayer smoothness pass. It covers the active
network configuration, how to switch modes, how to turn on diagnostics, and the exact commands +
QA matrix for a serious 1v1 playtest.

## Single source of truth: `shared/netConfig.ts`

Every timing path — server simulation, manual snapshot broadcast, client input send, client
prediction, and reconciliation replay — derives its rate and fixed timestep from
`shared/netConfig.ts`. There are **no** stray `1/30` / `0.016` literals left in the hot paths.

Fixed timesteps are computed as `1 / rate`, never rounded. Because the active mode uses the same
rate for server sim and client input, prediction and the server run identical `dt`, which is what
keeps reconciliation residual ≈ 0 on flat ground.

### Active config (default, shipped)

| Setting | Value |
| --- | --- |
| Mode | `A_60_60_60` |
| Server sim | **60 Hz** (`SERVER_FIXED_DT = 1/60`) |
| Client input + prediction | **60 Hz** (`CLIENT_FIXED_DT = 1/60`) |
| Manual snapshots | **60 Hz** |
| Interpolation delay | **75 ms** |
| Room loop wake | 120 Hz (feeds the 60 Hz fixed-step accumulator) |
| Colyseus patchRate | disabled (manual snapshots are the visual pipeline) |
| Debug logging | **off by default** (server and client) |

### Available modes

| Mode | Sim | Input | Snapshots | Interp delay | When to use |
| --- | --- | --- | --- | --- | --- |
| `A_60_60_60` | 60 | 60 | 60 | 75 ms | Target. Lowest latency. Current default. |
| `B_60_60_30` | 60 | 60 | 30 | 110 ms | Fallback if 60 Hz snapshots are too heavy on a 1 vCPU box. Half the snapshot CPU/bandwidth; the smoothed render clock hides the lower snapshot rate. |
| `C_30_30_30` | 30 | 30 | 30 | 110 ms | Safe baseline. Lowest CPU. |

### Switching modes

The client compiles its mode in; the **client and server must run the same mode** or prediction
desyncs (60 Hz client prediction against a 30 Hz server is wrong). To switch:

```bash
# Server (env var, read at runtime):
NET_MODE=B_60_60_30 npm run dev          # in /server

# Client (build-time; Vite inlines it). Rebuild required:
VITE_NET_MODE=B_60_60_30 npm run build   # in repo root
```

`main.ts` logs a loud `console.warn` at startup if `VITE_NET_MODE` is set to a value that does not
match the compiled client mode, so a mismatch is never silent.

## Diagnostics (all OFF during playtests)

### Server

Per-tick/per-action logging is gated behind env flags. With none set, the server emits **zero**
output per tick and per action (only infrequent lifecycle lines: join/leave/dispose).

```bash
PERF_DEBUG=1    # the every-5s [rates] summary (simTicks/s, snapshots/s, avg/max tick ms, ...)
NET_DEBUG=1     # hit/score/reset/catch/parry/input/veloc lines
BALL_DEBUG=1    # bleacher collisions
PICKUP_DEBUG=1  # pickup attempts/results
THROW_DEBUG=1   # throw aim dumps
DEBUG_GAMEPLAY=1  # turns on all of the gameplay channels at once
```

`[rates]` (when `PERF_DEBUG=1`) reports: `simTicks/s`, `snapshots/s`, `inputPackets/s` per player,
`simTickMs avg/max`. This is the one log worth running occasionally during a playtest to confirm
the server is healthy.

### Client (browser console / localStorage)

```js
localStorage.setItem('strafeball.debug.net', '1')              // [net/input/send], [net/pos], [net/rates], [net/local-writers]
localStorage.setItem('strafeball.debug.networkRenderer', '1')  // remote/ball interpolation snaps
localStorage.setItem('strafeball.debug.hitboxes', '1')         // visualize remote hitboxes
// remove the key (or set to '0') to silence again
```

`[net/rates]` (1/s) reports: snapshots/s, avg/max snapshot interval, input packets/s, render FPS,
remote/ball buffer sizes, buffer **underruns/s** and **overruns/s**, interp avg/max interval,
render delay, latest snapshot age. The on-screen Debug panel (Tab) shows raw lead / expected lead /
**residual after replay** / pending inputs / acked seq — the prediction-health numbers.

## Commands

```bash
# --- repo root (client) ---
npm install
npm run dev            # Vite dev server (HMR; NOT representative of deployed smoothness)
npm run build          # production client → dist/  (use this to judge real feel)
npm run preview        # serve the production build locally
npm run typecheck      # client + shared typecheck
npm run test           # shared + client unit tests

# --- /server ---
cd server
npm install
npm run dev            # tsx, hot server on ws://localhost:2567
npm run build          # tsc → dist/
npm run start          # run the compiled server
npm run typecheck      # server + shared typecheck (CommonJS)
npm run test           # ServerGameLoop tests (includes 1v1 reset suite)
```

> **Do not judge final smoothness from `npm run dev` (Vite).** HMR, source maps, and the dev
> overlay add overhead. Always confirm feel with `npm run build` + `npm run preview` (or the
> deployed build), and hard-refresh (Ctrl/Cmd+Shift+R) so neither tester is on a stale bundle.

## QA test matrix

For each scenario record: FPS · input/s · snapshots received/s · avg/max snapshot interval ·
pendingInputs · residualAfterReplay · remote buffer underruns · ball buffer underruns ·
server avg/max tick ms · CPU observation · subjective smoothness.

### A. One-player local production test
1. `cd server && npm run dev`, then repo root `npm run build && npm run preview`.
2. Open the preview URL, create a room.
3. Move / strafe / jump / dash / slide / backflip — watch the Debug panel.
4. Throw, pick up, drop. Press **K** to reset (single player resets immediately).
5. Expect: residualAfterReplay near 0 standing still, very low walking, brief spikes on dash/jump
   that recover. Snapshots ≈ 60/s.

### B. Two-tab local test
1. Server running. Open two preview tabs; create in one, join-by-code in the other.
2. Watch the **remote** avatar in each tab: motion should be smooth, no 20–30 Hz stepping.
3. Throw balls between tabs; confirm live balls don't stutter and held balls stay on the hand.
4. **Reset vote:** press **K** in one tab → "RESET VOTE 1/2"; press **K** in the other → room
   resets, both tabs snap to spawn, scores zero, balls return to the center line.

### C. Deployed 1v1 test (the real signal)
1. Deploy server; point client `VITE_SERVER_URL` at it; both players hard-refresh.
2. 2–3 minutes of normal play: strafing, jumps/dashes, throwing, pickups, held-ball body contact
   (must **not** score), catch/parry, and a reset/rejoin.
3. Enable `PERF_DEBUG=1` on the server briefly to capture a `[rates]` line; enable
   `strafeball.debug.net` on one client for a `[net/rates]` line.

### D. Rate comparison
Run B and/or C under each mode (rebuild client + restart server with the matching mode) and compare
the recorded metrics:
- `C_30_30_30` baseline
- `B_60_60_30` fallback
- `A_60_60_60` target

## Acceptance targets (60 Hz)

- Server `avgTickMs` < 3–5 ms, `maxTickMs` usually < 10–12 ms, no frequent spikes > 16.7 ms.
- `simTicks/s` ≈ 60; `snapshots/s` ≈ 60 (or 30 in mode B).
- No frequent accumulator step caps; no unexplained 20–30 Hz output.
- Client `pendingInputs` stable (not growing); `residualAfterReplay` low on open floor.
- Remote/ball buffer underruns near 0; no rubber-banding from stale snapshots.
- CPU not pinned near 100% on the droplet. If it is at `A_60_60_60`, drop to `B_60_60_30`.
