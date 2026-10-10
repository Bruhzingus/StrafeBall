# Multiplayer latency audit — 2026-10-09

The investigation covers local/private hosting, public WebSocket rooms, and the shared 1v1/2v2
simulation. Several reproducible client and server defects were found and fixed. The friend's
internet route and before/after latency have not been measured; the code alone cannot establish
why that particular match had high ping.

## Why a nearby friend can still have high ping

`npm run play:local` currently starts **private hosting**. It runs the authoritative server on
your PC, serves the local client at `http://localhost:2567`, and registers a `HOST-...` code.
The guest first attempts direct WebRTC. If negotiation fails or exceeds five seconds, their
gameplay travels through the public WebSocket relay:

```text
Direct: guest browser <-----------> your PC
Relay:  guest browser <-> public relay <-> your PC
Host:   your browser  <-----------> your PC (loopback)
```

Same-city distance does not guarantee a short relay or ISP route. The host's near-zero ping
does not measure the guest's connection. STUN discovers addresses for a direct route; it does
not carry the established gameplay stream. This follows the [WebRTC connection model](https://webrtc.org/getting-started/peer-connections).

The selected **High / 128 Hz** preset means 128 simulation/input steps and 90 snapshots per
second. It starts with a 50 ms remote interpolation buffer, which adapts to delivery conditions.
90 Hz simulation waits at most about 11.11 ms for the next tick; 128 Hz about 7.81 ms. The
3.30 ms difference in this component cannot remove a long network round trip or queued packets.
Higher rates also increase work and traffic, especially when a host uploads to three 2v2 guests.

## Implemented changes

| Finding | Change | Expected effect |
| --- | --- | --- |
| Renderer read only the latest snapshot each display frame. At 60 FPS, multiple arrivals were discarded, including ball/world lanes. | Bounded receive queue retains each accepted snapshot, lane flags, and monotonic arrival timestamp; renderer consumes them before drawing. | High snapshot rates now contribute samples even on a lower-refresh client. Jitter measurements reflect arrival timing. |
| Live-ball presentation used the newest packet timestamp between packet arrivals. | Bounded presentation clock advances between packets, while snapshot reconciliation still uses the snapshot's original timestamp. | Smooth ball travel between updates; prediction remains capped during outages. |
| An isolated long outage left an unbounded jitter peak even though the interpolation buffer has a fixed ceiling. | Cap the learned gap to useful buffer capacity. | Healthy connections recover normal visual latency sooner after a stall. |
| A 3-second ping spike contaminated the snapshot clock with 1.5 seconds of raw half-RTT; the supposed floor estimate was also an EMA. | Every clock sample uses the minimum RTT from the last 10 seconds; elapsed server time uses a monotonic clock. | Isolated ping outliers no longer inflate snapshot compensation. Local clock adjustments do not jump elapsed time between samples. Raw ping remains visible. |
| Jitter-batched inputs preserved a dash press but could replace its direction with a later non-dash input's zero direction. | Preserve the direction associated with the dash edge when coalescing inputs. | Dash direction agrees with the input that requested it in both match formats. |
| Every snapshot was encoded separately for each client and again for recording. | Encode one immutable Colyseus frame and share it with eligible peers through the existing join/backpressure queues. | In a four-player room with recording, five identical encodes become one. Packet content and delivery rules remain unchanged. |
| 2v2 last-player bonuses compared server deadlines with the guest PC's wall clock. | Compare against estimated server time. | Clock differences no longer activate/expire prediction bonuses at the wrong time. |
| Direct fallback hid its cause, and application ping mixed network travel with game processing. | Show relay fallback reason, selected WebRTC candidate types/protocol, and ICE RTT in the detailed Tab diagnostics. | A playtest can distinguish routing trouble from application stalls. Failed negotiation also releases its resources promptly. |
| The event-loop histogram's 20 ms sampling interval was mistaken for excess delay; diagnostics could retain stale history. | Subtract the sample interval and refresh the diagnostic window even when verbose logging is disabled. | Server diagnostics describe excess timer delay without falsely blaming the host. |

The queue is bounded to 128 snapshots and clears on disconnect. The RTT minimum is a conservative
baseline estimate, not a measurement of asymmetric one-way delay; it can take up to 10 seconds
to adopt a sustained route increase. It is separate from the displayed application ping.
Ping round trips still use the existing wall-clock echo protocol; the monotonic-clock protection
applies to advancing the server-time estimate between samples.

## Windows hosting measurement

The host requests a 5 ms wake, but isolated measurements on this Windows/Node installation
delivered about 64–90 callbacks per second. Network traffic can wake a live room more often,
so this is evidence to investigate scheduling, not proof of a live-match cap. Added
`npm.cmd --prefix server run diagnose:timing` to measure the runtime without changing system
settings. See [measurements, primary sources, and next steps](WINDOWS_TIMER_CADENCE.md).

## Research and remaining tradeoffs

Interpolation trades some visual delay for tolerance of irregular packet arrivals. Removing its
buffer blindly makes jitter visible; extrapolating indefinitely invents collisions and movement.
The changes retain adaptive buffering and cap prediction, consistent with
[Glenn Fiedler's snapshot interpolation analysis](https://gafferongames.com/post/snapshot_interpolation/).

Direct gameplay currently uses one **reliable ordered** data channel. Under loss, retransmission
and ordering can delay newer messages. A future independent unreliable snapshot channel could
reduce this waiting, but requires per-lane sequence rejection, loss-safe baselines/keyframes,
reliable event ordering, and reset/roster handling. The current partial snapshots and trimmed
input stream cannot simply be switched to unreliable delivery. Browser channel options are
defined in the [W3C WebRTC specification](https://w3c.github.io/webrtc-pc/#rtcdatachannel).

The ICE RTT is an estimate from connectivity checks, not the entire application's message latency.
It is sampled once a second when available and reflects the selected candidate pair; the HUD
does not expose addresses. See the [W3C WebRTC statistics specification](https://w3c.github.io/webrtc-stats/#dom-rtcicecandidatepairstats-currentroundtriptime).

The previous handoff claimed a 20 ms event-loop mean proved CPU throttling. That conclusion is
unsupported: the configured monitor itself sampled at 20 ms. Excess timing can still come from
OS timer granularity, CPU contention, garbage collection, or synchronous work. Establish CPU
steal independently before buying different hosting. See [Node's API documentation](https://nodejs.org/docs/latest-v24.x/api/perf_hooks.html#perf_hooksmonitoreventloopdelayoptions)
and the [Node project discussion of the resolution baseline](https://github.com/nodejs/node/issues/34661).

## Run and compare

Rebuild **both** sides after source changes:

```sh
npm run build
npm --prefix server run build
npm run play:local
```

Use `npm.cmd` in PowerShell if its execution policy blocks `npm.ps1`. Stop the old host before
starting the rebuilt one. Friends opening the public website still receive its deployed client;
they need the updated client too for rendering/clock improvements. Local builds do not deploy
the website or replace the downloadable host release. The source changes are protocol-compatible
with the existing reliable connection.

For a useful comparison, run the same pair/map for a few minutes at High / 128 Hz:

1. Check the guest's **Direct / Relay** label. Open the detailed Tab diagnostics.
2. Record typical/max application ping, ICE RTT (Direct), relay reason (Relay), jitter,
   socket-buffer peak, server-loop excess p95, snapshot receive/render rates, interpolation
   delay, frame time, and desync after replay.
3. Leave, select **Use relay for this join**, and repeat. This isolates the route choice.
4. Repeat at Standard / 90 Hz, then repeat with all four players for 2v2. Compare visible
   stalls and corrections as well as ping; a preset change is an experiment, not a guaranteed fix.
5. If Direct is unavailable, the fallback reason tells whether to investigate browser support,
   negotiation timeout, signaling, or ICE/network reachability. A TURN service would add a
   different relay route; it would not make the current route direct.

Low ICE RTT with high application ping points toward queues, retransmission, or application
scheduling; high ICE RTT implicates the path/last mile too. These are diagnostic clues, not
proof by themselves. Measure with uploads and downloads idle, then under normal household load.
Compare a wired connection if available. Keep both game tabs foregrounded during the test.

## Validation scope

Final local validation on 2026-10-09:

- `npm.cmd test -- --reporter=dot --maxWorkers=2`: **81 files, 762 tests passed**.
- `npm.cmd run verify:live`: client/server typechecks and client/server/direct-test-page builds passed.
- Chromium direct/relay integration: all seven recorded connections passed, including three 2v2 guests.
- Timer diagnostic: executed successfully; see the Windows measurement document for results and limits.

Regression tests cover snapshot retention/reset isolation, timing spikes/clock changes, dash coalescing,
interpolation recovery, prediction limits, and direct-transport diagnostics. The local browser
integration harness exercises real WebRTC and relay connections. These checks establish local
behavior. Chromium loopback checks passed for direct 1v1, three simultaneous direct 2v2 guests,
ICE timeout followed by relay, explicit relay selection, diagnostic fields, and host death.
The report is written to `tmp/direct-integration.json` by `npm --prefix server run test:direct`.
These checks do not measure the friend's ISP path, internet packet loss, or subjective feel.
Keep any across-city latency claim pending until the comparison above has been played.
