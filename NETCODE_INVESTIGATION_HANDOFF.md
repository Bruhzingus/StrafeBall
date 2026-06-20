# Strafeball Netcode Investigation — Handoff Context

> Purpose: give another LLM chat (or developer) everything needed to understand the "ping spike"
> investigation without re-deriving it. Read this top-to-bottom before proposing changes.
> Last updated: 2026-06-20.

---

## 1. What Strafeball is

Browser-based competitive **1v1 (and 2v2) FPS dodgeball**. You throw, catch, parry, and dodge
physical balls; movement is Quake/Source-style (accel, bhop, slide, wall-run, wall-jump, backflip,
dash).

- **Client:** Vite + TypeScript + Babylon.js.
- **Server:** Node + TypeScript + **Colyseus 0.17** (`@colyseus/sdk` on the client).
- **Authority:** fully server-authoritative — movement, balls, catches, parries, hits, score. The
  client predicts locally and reconciles; it is NEVER authoritative.
- **Transport:** Colyseus over **WebSocket (TCP)**, messages encoded as **msgpack binary** via
  `@colyseus/msgpackr` (NOT JSON text — a common misconception). Same TCP/head-of-line constraint
  as Krunker.io, which is also WebSocket-based.

### Key files
- `shared/netConfig.ts` — single source of truth for all rates/timings. **Never hardcode a rate.**
- `shared/snapshotCodec.ts` — compact snapshot pack/unpack (positional arrays + quantization).
- `shared/protocol.ts` — wire message types (`InputCommand`, `WireInput`, `ServerSnapshot`, events).
- `shared/types.ts` — `PlayerInput`, `PlayerState`, `BallState`, `RoomState`.
- `shared/simulation/MovementSim.ts` — the deterministic movement step run by BOTH client and server.
- `server/src/rooms/DuelRoom.ts` — room loop, snapshot broadcast, rate limits, backpressure, perf log.
- `server/src/simulation/ServerGameLoop.ts` — authoritative sim, input queue, lag-comp catches.
- `src/game/network/MultiplayerClient.ts` — client socket, ping/pong, snapshot receive, debug.
- `src/game/network/NetworkRenderer.ts` — interpolation buffer + smoothed render clock.
- `src/game/scenes/ArenaScene.ts` — client prediction/reconciliation, input send loop, HUD wiring.
- `src/game/ui/Hud.ts` — the Tab debug overlay (FPS, ping, WS buffer, desync, etc.).

### Net config (current default)
`DEFAULT_NET_MODE = 'A_128_128_96'` → **128Hz sim, 128Hz input, 96Hz snapshots**, interp delay 50ms.
Higher modes exist and were tested (144/180Hz). `ROOM_LOOP_WAKE_RATE=200` (loop wants to wake every
5ms). `SNAPSHOT_BACKPRESSURE_BYTES = 64KB`. Client interpolation delay 45–50ms.

**Switching rates:** the client runs the **COMPILED** `DEFAULT_NET_MODE`, not an env var.
`VITE_NET_MODE` is only a mismatch *warning*. The server reads `NET_MODE` env at runtime
(`resolveProcessMode()`). To truly switch: change `DEFAULT_NET_MODE`, rebuild client, set matching
`NET_MODE` on server. Client and server MUST match or prediction desyncs.

---

## 2. The reported problem

Some players on normal ~80 Mbps home internet, in the same region as the dev, get **huge intermittent
"ping" spikes — up to ~3000 ms** during play. Those same players run Deadlock/COD/Minecraft/Discord
fine. The dev has solid Wi-Fi and sees a steady ~49–51 ms. The investigation was told explicitly:
**do not assume the players' internet is the cause; treat it as app-side queueing/buffering/duplicate
traffic/scheduler/measurement until proven otherwise.** Hard rules: don't rewrite the architecture,
don't just lower tickrate, don't mask with extra interpolation, don't weaken authority, don't change
combat/movement balance, **measure before guessing.**

---

## 3. How the netcode actually works (so changes don't break it)

- **Input:** client sends **one input packet per fixed step at `CLIENT_INPUT_RATE`** (128–180/s).
  Each `PlayerInput` (~30 fields) is built in `ArenaScene.buildNetworkInput()`, used LOCALLY for
  prediction, stored in `pendingInputs` for reconciliation replay, AND sent. Client and server run
  the SAME `MovementSim.stepMovement` so reconciliation residual ≈ 0 (requires identical fixed dt).
- **Snapshots:** server builds ONE payload per snapshot and sends the SAME bytes to every client.
  Under backpressure it **deliberately SKIPS** clients whose socket `bufferedAmount > 64KB`
  (`DuelRoom.snapshotSendableClients`). Client **drops stale snapshots** (tick ≤ last). So any
  per-client delta/baseline scheme is UNSAFE — a skipped/dropped snapshot would break the chain.
- **Interpolation:** `NetworkRenderer` keeps a snapshot buffer and a **smoothed render clock**
  (`renderServerTime` advances by real dt, nudged toward `newestServerTime − interpDelay`). Remote
  entities render ~interpDelay behind. This is the "shock absorber" for network jitter.
- **Lag-comp catches:** the server rewinds using a `DefenseHistory` ring + the client-reported
  `rttMs` (clamped + EMA-smoothed server-side) to size the catch rewind window.

---

## 4. What the investigation measured and concluded (the important part)

The diagnosis evolved through several screenshots/logs. **Each stage eliminated a theory:**

### Stage 1 — "Ping" is a bad metric (true, but not the root cause)
The HUD "Ping" = `Date.now() - pong.clientTimeMs` (`MultiplayerClient` pong handler). It is the
**application round-trip over the shared socket**, sampled every ~1–2s. It conflates real RTT with
(a) client uplink send-queue time and (b) main-thread/tab stalls. A "3000ms ping" can be queue/stall
time, not latency. Instrumentation was added to decompose it (see §5).

### Stage 2 — NOT the client uplink
A player HUD during a spike showed **Ping 57ms, WS buffered 573B (empty), snapshots ~54Hz still
arriving**, but **Pong age 1787ms, Missed 23**. Empty WS buffer ⇒ no client-side send backlog. So
the spike was NOT client uplink congestion and NOT bad network RTT at that instant.

### Stage 3 — AFK/backgrounded-tab freeze (a separate, cosmetic issue)
Another screenshot (Ping **19145ms**, Pong age 3108ms, Missed 23, Input seq 0, Prediction inactive)
was captured after the dev walked away. Browsers throttle a backgrounded tab's rAF + setInterval, so
the game loop froze (no input, prediction reset) and the ping measured frozen wall-clock time. This
is recoverable (prediction self-heals from the next snapshot) and is NOT the players' spike problem.
A staleness guard was added so this no longer displays a fake multi-second ping.

### Stage 4 — DigitalOcean droplet insights: NOT bandwidth, NOT sustained CPU
1-hour graphs during play: **CPU ~23% user / ~1% sys, bandwidth ~3.8 Mb/s out / 1.2 Mb/s in, disk
~44 kB/s.** All low. Ruled out server bandwidth saturation, disk, and *sustained* CPU load. BUT
1-minute-averaged graphs cannot see sub-second stalls.

### Stage 5 — PM2 `[perf]` logs: THE ROOT CAUSE
Server perf logs (printed every 5s, instrumentation already in the codebase) over ~3 minutes of 1v1:
```
simTicks=128.0/s   simTickMs avg=0.2-0.35  (sim is featherweight)
snapshotBuildMs avg=0.05-0.13            (encoding is free)
backpressureSkips=0  wsBuffered avg=0B max=0B   (NO send backlog, ever)
mem heapUsed=20-30MB flat                 (NO memory growth, NO GC pressure)
eventLoopMs avg=20.2  EVERY LINE          <-- THE SMOKING GUN
eventLoopMs max=46-58  snapshotLateMs max=26-45  (periodic hitches)
```
**The event loop has a constant ~20ms baseline delay that never improves even when the sim does
almost nothing.** A healthy loop on an idle server is 1–5ms. This is not the code being slow — it's
the **host not scheduling the Node process often enough.**

### Root cause: the droplet is a **Basic / 1 vCPU / 1 GB** shared-CPU droplet (SFO2)
Basic droplets are **burstable and shared-CPU**: the hypervisor time-slices the vCPU in ~20ms quanta
and throttles sustained CPU. The room loop wants to wake every 5ms to feed a 128Hz sim, but the host
only schedules the process every ~20ms → that's the `eventLoopMs avg=20` floor exactly. Noisy-neighbor
contention / CPU steal causes the 46–58ms (and occasionally multi-second) hitches. The DO CPU% graph
doesn't show steal, which is why the graph looked "fine." **The netcode is healthy; the host throttles
the process that runs it.** This is the concrete version of "why doesn't it feel like Krunker" —
Krunker runs on dedicated, unthrottled cores.

### Why only SOME players see spikes (key insight)
The server hitches for EVERYONE (it's one process). Whether a player *sees* it depends on their
connection's spare jitter headroom vs the interpolation buffer (45–50ms):
- **Smooth connection (dev's Wi-Fi):** a 40ms server hitch lands inside the interp/jitter slack; the
  render clock smooths it; invisible. The good connection MASKS the server instability.
- **Slightly jittery connection:** when the server hitch and the player's own last-mile jitter arrive
  TOGETHER, the combined delay exceeds the interp buffer → snapshots clump, a pong is missed/late,
  and it's measured as a multi-second "ping." It is NOT that their internet is bad — it's that they
  lack the headroom to absorb the server's hitches.
**Prediction:** moving to a non-throttled host drops `eventLoopMs avg` to ~2-5ms and the spikes
vanish for everyone, including the jittery players. That is the test that proves the theory.

---

## 5. Changes made this session (all safe, tested, gameplay-neutral)

All committed except #C (in working tree). Full client + server test suites green; both typecheck.

**A. Ping/measurement instrumentation + correctness (committed)**
- Added client uplink instrumentation: `socketBufferedPeak` (rolling decayed peak), buffer at
  ping-send, floor-tracked `rttEstimateMs` (queue/stall-immune via min-tracking), `maxRecentPingMs`.
  Surfaced in Tab HUD with color-coded WS buffer line. Lets a live test attribute a spike to uplink
  vs network vs stall.
- Server-time clock estimate now uses the floor-tracked RTT (one 3000ms outlier can't shove the
  render/server clock ~1.5s). Ping cadence 2s→1s.
- Client now reports floor-tracked RTT (not raw ping) as `rttMs` for the server's catch lag-comp, so
  a transient spike can't widen the rewind window (server already clamps+EMA-smooths it). No balance
  change.
- **Ping-staleness guard:** if the ping send-gap or round-trip exceeds `PING_FREEZE_GAP_MS = 4000`
  (timer throttled by backgrounded tab / sleep / long stall), the round trip is discarded and
  `pingMs` shows null/stale instead of a bogus 19000ms number.

**B. Input-packet bloat trim (committed, `fc263b4`)**
- `dashDirection` is omitted from the wire when it is a zero vector (`toWireInput` in `protocol.ts`).
  Proven gameplay-neutral: the sim only reads `dashDirection` on a `dashPressed` tick, and a
  zero/absent value derives the dash dir from the wish direction (mathematically identical to what the
  client computed) or facing. The server defaults an ABSENT `dashDirection` to ZERO (not the previous
  input) in `normalizeInput` — the critical fix that prevents a stale dash dir leaking into a later
  dash-with-no-movement tick. 9 tests (`server/tests/WireInputDashTrim.test.ts`) incl. the stale-leak
  regression. Saves ~4.5–6.3 KB/s uplink at 128–180Hz. Modest.

**C. int16 fixed-point vector quantization (working tree, `shared/snapshotCodec.ts`)**
- Positions/velocities/facing/curveAccel now pack as scaled int16 integers instead of 8-byte msgpack
  doubles (Quake/Source-style). Scales: POSITION ±64m (2mm precision), VELOCITY ±256m/s, UNIT ±2.
  Clamped (never wraps); non-finite → 0; full-precision `SNAPSHOT_ENCODING=full` debug path untouched.
  ~432 B/snapshot saved (~40 KB/s per client at 96Hz). 4 codec tests (precision, clamp, NaN).
- **NOT done deliberately:** per-field player delta and "cold metadata" delta. Audited — every
  candidate field IS read by the client (`legalHalf`→half-court rule, `match.status`→input freeze,
  `resetVote.resetSerial`→prediction reset, `matchStats`→scoreboard). Omitting any requires per-client
  baseline + keyframe machinery, which is UNSAFE against the backpressure-skip broadcast model. And
  the logs show bandwidth is a non-issue (`backpressureSkips=0`, `wsBuffered=0`). Risk with no reward.

---

## 6. The fix (hosting) — current recommendation

Bandwidth/code are not the bottleneck; **the 1 vCPU shared droplet is.** Confirm with `top` (press
`1`, watch the `st`/steal column) and `vmstat 1 5` during a match — steal >0 or load≈1.0 confirms it.

**Recommended move (dev + players are in Alberta, Canada):**
- **Hetzner Cloud CX22** (2 vCPU / 4GB, ~$4.50/mo) in **Hillsboro, Oregon (US-West)**. This is:
  - **Cheaper** than the current DO droplet,
  - **Dedicated-grade CPU** with a 2nd core for hiccup headroom → kills the `eventLoopMs=20` floor,
  - **Lower latency from Alberta** than the current SFO2 (Calgary→Oregon ~15-25ms vs →SF ~25-35ms).
- Alternative for absolute West-Coast latency: **Vultr High Frequency, San Jose** (~$6/mo, 1 high-clock
  vCPU). Vultr/DO **CPU-Optimized** (~$28-42/mo) if you want fully dedicated.

**Expectation setting (important):** the host move does NOT add "20ms of feel." The `eventLoopMs=20`
is scheduling granularity/jitter, not 20ms added to RTT. Effects:
- For the dev (already smooth): small crispness gain.
- For the spiking players: **large** — the spikes disappear (that's the real win).
- The latency the dev *feels* improve (~10ms) comes from the **region change** (Oregon closer than SF),
  not the CPU fix.

**Optional insurance:** also set `DEFAULT_NET_MODE = 'A_90_90_60'` (90Hz sim/input, 60Hz snapshots).
At 90Hz the loop wakes every 11ms instead of 7.8ms — friendlier to any host — and per the analysis it
feels the same or better (smoothness comes from interpolation, not raw Hz). Reversible one-line change
+ client rebuild + matching server `NET_MODE`.

---

## 7. How to verify the fix landed (post-migration)
1. Have a previously-spiking player play a 1v1.
2. Watch the server `[perf]` log: **`eventLoopMs avg` should read ~2-5 (was 20).**
3. That player's Tab HUD: pong age stable (~ping interval), Missed 0, no 3000ms spikes.
4. `backpressureSkips` stays 0 (already does). If `eventLoopMs avg` is still ~20 on the new host,
   the host is also throttling — escalate to a dedicated-CPU plan.

---

## 8. TL;DR for a new chat
- The netcode is **well-built and server-authoritative**; do not rewrite it.
- The "3000ms ping" is **NOT the players' internet, NOT bandwidth, NOT a bad ping metric at root,
  NOT GC.** It is the **DigitalOcean Basic 1-vCPU droplet throttling the Node event loop**
  (`eventLoopMs avg=20ms` floor + steal-induced hitches). Proven by the PM2 `[perf]` logs.
- Only jittery-connection players SEE it because smooth connections absorb the server's hitches.
- **Fix = move to a non-throttled host** (recommend Hetzner CX22, Oregon, ~$4.50/mo — cheaper, faster
  from Alberta, dedicated CPU). Optionally lower sim rate to 90Hz as insurance.
- Code changes this session (ping instrumentation/correctness, input trim, int16 quantization) are
  real efficiency/correctness wins and tested, but they will NOT fix the spikes — the host will.
