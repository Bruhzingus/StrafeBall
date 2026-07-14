# Ultra Low preset session — friend lag report (2026-07-13)

Raw log: [`2026-07-13-friend-ultra-low-preset-raw.log`](./2026-07-13-friend-ultra-low-preset-raw.log)

Context: friend (weaker but "competitively viable" connection, 80/30 Mbps) in the same lobby as
Randall (host — reported **no lag at all** during this session). Friend on the **Ultra Low**
net/graphics preset (`A_60_60_48`: 60Hz input/sim, 48Hz snapshots). This report is **analysis only**
— no code was changed as part of it (one candidate fix was drafted, verified to compile, then
explicitly reverted per instruction; see Finding 2).

**No code changes were made in the analysis session.** FOLLOW-UP (same day, on explicit request to
"fix if you can find a clean fix"): (1) the Finding-2 reflection-probe fix was applied
(`GymReflectionProbe.ts`, receiver wiring deferred to `onAfterUnbindObservable`, visually verified
identical); (2) the pong message now mirrors the server's per-client outbound buffer + event-loop
p95 into the Tab HUD ("Server: loop p95 · out-buf" line) — the exact instrumentation this report
names as the disambiguator, so the NEXT spike names its own culprit live; (3) the Tab HUD's
"Tick rate / Snap" line now shows the room's actual preset rates instead of compiled defaults.

## Timeline (from the `[perf]` lines, one per 5s window)

| roomAge | ping | jitter | missedPongs | pendingInputs | wsBuffered | snapshotsRecv | renderSnapshots | oldestSnapAge | maxFrameMs | lastSnapReason |
|---|---|---|---|---|---|---|---|---|---|---|
| 5.0s | 56ms | 568ms | 0 | 5 | 142B | 0.0/s* | 46.0/s | 989ms | 52.0ms | ball-continuity-change |
| 10.0s | 49ms | 206ms | 0 | 7 | 0B | 48.5/s | 49.0/s | 994ms | 9.5ms | ball-continuity-change |
| 15.0s | 84ms | 77ms | 0 | 3 | 0B | 47.6/s | 47.9/s | 980ms | 25.3ms | ball-continuity-change |
| 20.0s | **300ms** | 96ms | 0 | 5 | 150B | 47.6/s | 33.9/s ↓ | 981ms | 12.0ms | ball-continuity-change |
| 25.0s | 63ms | 73ms | 0 | 6 | 150B | 47.4/s | 44.8/s | 981ms | 11.4ms | ball-continuity-change |
| 30.2s | 95ms | 52ms | 0 | **53** | 0B | 47.6/s | 33.9/s ↓ | **1883ms** | **192.4ms** | ball-continuity-change |
| 35.2s | **3310ms** | 622ms | **3** | **90 (capped)** | 0B | 39.1/s | **2.0/s** ↓↓ | 855ms | 10.6ms | ball-continuity-change |
| 40.2s | 58ms | 289ms | 3 | 6 (drained) | 150B | 24.4/s | 48.0/s (recovered) | 1001ms | 13.4ms | **remote-large-error** |
| 45.2s | **1698ms** | 477ms | **4** | 83 | 150B | 80.3/s (burst) | **3.0/s** ↓↓ | 987ms | 9.2ms | remote-large-error |
| 50.2s | 438ms | 356ms | **6** | **90 (capped)** | 0B | 38.5/s | **6.0/s** ↓↓ | 1307ms | 9.9ms | remote-large-error |

*\*0.0/s at 5.0s is just-connected startup, not a stall.*

## Finding 1: the friend's session has two distinct phases, and only the second one is abnormal

**Phase A (0–25s): mostly healthy.** Pings 49–84ms with one blip to 300ms at 20s that self-recovers
by 25s. `missedPongs` stays at 0 the entire time. This is what a "competitively viable but weaker"
connection is supposed to look like on Ultra Low — some jitter, no real damage.

**Phase B (30s onward): sustained, worsening instability.** Starting at 30.2s, every single 5-second
window shows a problem, and it never fully recovers for the rest of the log:
- `pendingInputs` — the count of local inputs sent but not yet acknowledged by the server — jumps from
  a normal 3–7 to **53, then repeatedly slams into the hard cap of 90** (this is `PENDING_INPUT_LIMIT`,
  1.5s of input queue at 60Hz; hitting it means inputs are being dropped from the front of the queue).
- `missedPongs` climbs **monotonically and never resets**: 0→0→0→0→0→0→3→3→4→6. This counter only goes
  up when a ping round-trip never completes at all (not just "slow" — actually lost or timed out). A
  session that starts clean and then accumulates outright-missed pongs over its second half is a
  meaningfully different signature than one steady bad-but-consistent ping.
- Ping itself becomes bimodal and violent: 95 → **3310** → 58 → **1698** → 438. It is not "consistently
  elevated" — it whipsaws between near-perfect (58ms) and catastrophic (3.3 SECONDS) within single
  5-second windows.
- `renderSnapshots` (how much actually got drawn) repeatedly collapses to near-zero (2.0/s, 3.0/s,
  6.0/s against a steady target of ~48/s) even in windows where `snapshotsRecv` shows real throughput
  (39–80/s) — meaning data is nominally "arriving" per the counter but not converting into rendered
  remote-player/ball frames. `snapMs max` spikes to 570–1011ms in the recovery windows immediately
  after, consistent with a backlog of queued snapshots being unpacked/merged in one enormous batch
  instead of steadily.
- `oldestSnapshotAge` (age of the stalest snapshot still in the interpolation buffer) spikes to
  **1883ms and 1307ms** — over a second beyond the 170ms render delay this preset targets. That is a
  genuine multi-second gap where no *usable* fresh state arrived, not just one late packet.
- `corrections`/`snaps` (reconciliation activity) drop to **0** during the worst windows (35.2s,
  45.2s) — the client isn't just rendering less, it has nothing fresh to reconcile against at all.
- `lastSnapReason` permanently flips from the routine `ball-continuity-change` to
  **`remote-large-error`** starting at 40.2s and never reverts for the rest of the log — the
  interpolation system is now hard-snapping instead of smoothing, because by the time backlogged data
  arrives it's too stale for a small correction to fix.

**One important negative finding:** `wsBuffered` (the browser's own outbound send-queue depth) stays
at **0–150 bytes throughout — including during the worst spikes.** This is the exact signal the
[[ping-spike-diagnosis]] memory used in a *previous* investigation to diagnose local uplink congestion
(that case showed `wsBuffered` ballooning into the tens of KB). **This friend's log shows the
opposite — a clean local send queue.** That rules out "his upload can't keep up with outbound game
traffic" as the mechanism here. Whatever is happening, the data is leaving his browser fine; the
problem is somewhere between that handoff and getting a timely reply.

### What this pattern is consistent with (and what would disambiguate it)

Two live hypotheses remain, and **this single client-side log cannot fully separate them**:

1. **The known shared-vCPU host stall** (documented at length in [[ping-spike-diagnosis]], June 20
   finding: `eventLoopMs avg≈20ms` on the throttled droplet, hypervisor-induced multi-tick stalls).
   A server-side stall would explain BOTH symptoms simultaneously from one root cause: pongs don't get
   answered (ping/missedPongs) AND snapshots don't get broadcast on time (renderSnapshots collapse,
   oldestSnapshotAge spike) — because the same blocked event loop can't do either. This matches the
   established "server hitches for everyone, only low-margin connections visibly spike" theory, and
   would explain why Randall's session felt smooth while his friend's didn't, without anything being
   uniquely wrong with the friend's network.
2. **Genuine path degradation specific to the friend** — home router/WiFi queueing under new load
   (someone else starting a stream/download partway into the session), ISP-level jitter, or a
   wireless retransmission storm. This would NOT show up in `wsBuffered` (that only reflects the
   browser's own unsent queue, not congestion further down the path — router buffers, WiFi
   retransmits, and ISP jitter all happen downstream of the browser handing bytes to the OS) but would
   still produce exactly this signature: clean local buffer, but round-trips that go missing or take
   seconds.

**What would tell them apart:** the server's own `[perf]` log (`PERF_DEBUG=1`) for the *same wall-clock
window* — if `eventLoopMs avg/p95` spikes at the same times this friend's ping did, it's the host.
If the server's own loop stayed clean throughout, the friend's path is genuinely degraded and no
server change (tick rate, hosting, snapshot tiering) will fix it. Randall's own concurrent client log
(if `PERF_DEBUG`/`strafeball.debug.perf` was on for his session too) would also help — even a small,
Randall-absorbed anomaly at the same room-age marks would point at the server.

I checked for a self-inflicted client-side cause of the ~30s onset (a periodic timer misfiring) and
found none — the only client interval near this is the 1s ping timer
([MultiplayerClient.ts:746](../../src/game/network/MultiplayerClient.ts#L746)); nothing fires on a
~30s cadence. The timing is most likely either a real-world change in the friend's local network
conditions partway through the session, or an unlucky window of server-side scheduling — not
something the client did to itself.

## Finding 2: a real, independently-confirmed WebGL bug — but almost certainly unrelated to the above

The two console lines at the very top of the log are worth separating out, because they are a
**genuine code defect**, unrelated to networking:

```
256[.WebGL-0x668400e14e00] GL_INVALID_OPERATION: glDrawElements: Feedback loop formed between Framebuffer and active Texture.
WebGL: too many errors, no more errors will be reported to the console for this context.
```

**Root cause, confirmed by reading the source** (not fixed — see below):
[`GymReflectionProbe.ts`](../../src/game/map/GymReflectionProbe.ts) builds its render list from
`STATIC_INCLUDE_PREFIXES`, which includes the walls (`north_wall`, etc.) and bleachers (`bleacher_`).
In the same function, `probeReceivers()` wires `north_wall_brick_mat` / `bleacher_material` (among
others) to sample `material.reflectionTexture = probe.cubeTexture` — **the exact texture the probe
is about to render into** — and this wiring currently happens *synchronously, immediately*, before
the probe's one-time render has actually executed. So when the probe performs its render-once capture,
the walls and bleachers it is capturing are *also* bound as samplers reading that same texture: a
literal read/write feedback loop on the framebuffer, which is exactly what the GL error describes.

A draft fix was written and verified to typecheck (delay wiring the receiver materials until after
`probe.cubeTexture.onAfterUnbindObservable` fires, confirmed safe against early-dispose via
`RenderTargetTexture.dispose()` clearing that observable) — **it was reverted per instruction and is
not in the working tree.** It remains available to apply on request.

**Why this is very likely a separate issue from Finding 1, not the same bug:** the reflection probe
is `refreshRate = REFRESHRATE_RENDER_ONCE` — it renders exactly once, at scene construction, and the
"too many errors" browser message confirms this fired in one tight burst at load and then stopped
being reported. That places it at/before `roomAgeSec≈0`, well before the 30–50s window where the
network instability occurs. It's also not a rendering-thread stall in that later window — `avgFrameMs`
stays ~7ms (140+ FPS) even during the worst ping spikes (e.g. 35.2s: `ping=3310ms` but
`avgFrameMs=7.02`), meaning the GPU/render thread itself was not blocked at the times things went
wrong. The one plausible (unconfirmed) connective thread: this GL error could contribute to the single
early frame-time blip visible in the log (`maxFrameMs=52.0` at the 5.0s window, i.e. very close to
scene load) — but it does not explain the sustained, recurring 30–50s degradation.

**Recommendation:** fix it regardless of the networking question — it is a genuine correctness bug,
some GPU/driver combinations may pay real (if hard-to-see) validation-path cost for it repeatedly, and
it's a one-line, render-once-safe change with no visual risk. But treat it as independent from the
friend's lag complaint; don't expect fixing it to resolve Finding 1.

## Summary

- The friend's session is cleanly split into a healthy first ~25s and a badly degraded remainder,
  not a uniformly "meh" connection — this is a *distinct event*, not baseline weak-connection jitter.
- The degradation is real network/reconciliation starvation (missed pongs, capped input queue, stale
  snapshot buffer, hard interpolation snaps) — not a client rendering/FPS problem; frame times stay
  clean throughout.
- The friend's own outbound send buffer stays clean throughout, which rules out the *specific*
  uplink-congestion mechanism documented in the existing [[ping-spike-diagnosis]] memory for a
  different prior case — this is a new/different signature worth tracking as its own data point.
- It remains consistent with, but not proof of, the already-diagnosed shared-vCPU host stall
  (env: host move confirmed unavailable, $25/mo not viable per prior conversation). Confirming that
  requires the server's own `PERF_DEBUG=1` log for this same window.
- A separate, confirmed WebGL feedback-loop bug exists in the reflection probe wiring. It's real,
  fixable, low-risk — but timing evidence puts it at scene load, not correlated with the later network
  stalls. Not fixed in this session per instruction; a working fix was drafted and reverted.
