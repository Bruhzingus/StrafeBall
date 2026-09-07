# Local/Private Host Multiplayer — Plan & Decision Record

Date: 2026-09-06

## Problem

The production server is a single throttled 1-vCPU DigitalOcean droplet (SFO2). Root-caused in
`NETCODE_INVESTIGATION_HANDOFF.md`: the shared-vCPU hypervisor holds the Node event loop to a
~20ms scheduling floor (healthy is 1-5ms), with occasional multi-second hitches. This produces the
in-game ping spikes some players see. The proper fix — a dedicated vCPU — costs ~$25/mo, and was
ruled out on budget grounds (see `[[ping-spike-diagnosis]]` memory, update 2026-07-13b). Software
mitigations (tiered snapshots, adaptive interpolation, backpressure recovery) have already shipped
and are treated as the ceiling for smoothing on the current box.

Separately, friends who live in the same city as each other are bounded by the droplet's location
and its CPU throttle even though a direct connection between their homes would be far better.

## Goal

Let a player host a private match from their own computer, with friends joining across different
home networks (not the same LAN/router), while leaving today's public "log on and play" experience
completely unchanged.

## Constraints (established during design discussion)

- The existing public server stays exactly as-is — the default way anyone logs on and plays.
- Private hosted sessions are a new, additive, opt-in feature.
- Friends are NOT assumed to share a router/LAN — must work across arbitrary home networks/ISPs.
- Joiners: no download, ever. They use strafeball.xyz and enter a code, exactly like today's
  private-room join flow.
- Host: one download is acceptable (not required to be zero).

## Architecture facts this plan relies on

- Server: `server/src/index.ts` calls Colyseus's `defineServer()`/`.listen()` directly — single
  in-memory process, no Redis, no DB, no native modules. Three room types registered: `duel`
  (`server/src/rooms/DuelRoom.ts`), `course`, `coop`.
- The exact same server code already runs as a standalone local Node process today via
  `scripts/dev-online.mjs` (used for local dev), including on Windows.
- Client server URL: `resolveServerUrl()` in `src/game/network/MultiplayerClient.ts` — build-time
  `VITE_SERVER_URL` override, else derives `wss://<host>/colyseus` from `window.location`.
- Rooms are already private-by-default with a shareable code, not a public lobby list:
  `DuelRoom.setPrivate(true)` in `onCreate()`. Join flow: `client.joinById(code, ...)` from
  `MultiplayerOverlay.ts`. This UX already matches "host a session, share a code" — it doesn't need
  to change for joiners.
- Simulation (`shared/simulation/*`, driven by `server/src/simulation/ServerGameLoop.ts`) is fully
  deterministic (no `Math.random()` in shared code) and explicitly server-authoritative — the
  server never trusts client-reported position/velocity, only raw input. This authority model
  transplants cleanly onto any machine running the same server code.
- `ServerGameLoop.ts` has exactly one Node-only import (`node:perf_hooks`); `DuelRoom.ts` is
  tightly coupled to Colyseus's `Room`/`Client` classes and is not portable to a non-Colyseus
  transport without a rewrite.
- No existing P2P/WebRTC code anywhere in the repo.
- Production is served over HTTPS, so the client's WebSocket connections are `wss://` — a browser
  page cannot open an insecure `ws://` connection to an arbitrary third-party address (mixed
  content blocking), and there's no practical way to get a browser-trusted TLS cert for a friend's
  ever-changing residential IP on demand.

## Options considered

### A. Pure WebRTC, host also stays browser-only (no download at all)
The only browser primitive that lets one tab accept a connection from another tab is WebRTC —
raw WebSocket-to-an-arbitrary-IP hits the mixed-content/TLS-cert wall above. This gives a genuine
zero-download experience for everyone, but requires replacing `DuelRoom.ts`'s entire Colyseus
message/broadcast layer with a hand-built protocol over WebRTC DataChannels, running the
authoritative sim inside the host's own tab (competing with their own rendering, and subject to
background-tab throttling), plus a signaling service and a TURN relay for the NAT-hard minority.
**Deferred** — largest rewrite of the three options for the least amount of "no download" benefit
once a single host download is acceptable anyway.

### B. Native download for everyone + custom UDP + direct P2P ("Native Performance Mode")
Wrap the existing Babylon.js client in Electron for every participant, replace WebSocket/TCP with
raw UDP (via Node's `dgram`), and do direct UDP hole-punching between host and joiners (droplet
only brokers the initial rendezvous). This is the true performance ceiling: no relay hop, no
CPU-throttle tax, and UDP removes TCP head-of-line blocking — a mechanism already suspected in a
real friend's spike log (`[[ping-spike-diagnosis]]`, update 2026-07-13e: "loop clean + out-buf
ballooned = ... TCP retransmit stalls"). But it requires a download from every joiner (breaks the
"no download for joiners" constraint), a hand-rolled UDP + reliability protocol that doesn't exist
today, a new packaging/update pipeline, and — since symmetric-NAT/CGNAT pairs still can't punch
through — a relay fallback anyway, meaning it doesn't even replace Option C below, it layers on
top of it. **Deferred to a possible future phase**, not built now.

### C. Host Agent + Relay Tunnel through the existing droplet ("Relay Tunnel Mode") — SELECTED
The host downloads and runs the existing server code (`server/dist`) plus a thin tunnel-client
addition. It makes an **outbound** connection to the droplet — outbound connections cross any
NAT/router/CGNAT with zero configuration, since routers only block unsolicited *inbound* traffic.
The droplet relays a joiner's `wss://` traffic to the host's tunnel by room code; the host's own
client connects to its own `localhost` server directly. Joiners keep using strafeball.xyz + a code,
completely unchanged. Reuses ~100% of existing code and requires no NAT-traversal engineering.

## Why C, not A or B

- It directly fixes the *confirmed* root cause (CPU-throttle tax on the shared droplet) by moving
  the 128Hz authoritative simulation onto the host's real, unthrottled machine.
- It satisfies every stated constraint: public server untouched, zero download for joiners, exactly
  one download for the host, works across arbitrary home networks.
- It's the smallest engineering lift of the three by a wide margin — no new transport, no new
  client, no protocol rewrite.
- **It's a prerequisite for B, not a detour from it.** Even in a future full native/UDP/direct-P2P
  design, NAT-hard pairs (symmetric NAT, CGNAT) still need a relay fallback — which is exactly this
  tunnel. Building C now is never wasted work: worst case it's the foundation a later phase needs
  anyway; best case it turns out to be enough on its own.

## Honest performance expectation for Relay Tunnel Mode

This is a real improvement, not a free lunch to LAN-grade ping:

| Latency source | Today (cloud) | Relay Tunnel Mode |
|---|---|---|
| CPU-throttle tax (~20ms avg + occasional multi-second stalls) | Present | Gone — sim runs on host's real PC |
| Extra network hop (joiner → droplet → host vs. direct) | N/A (1 hop today) | Added — now 2 hops |
| TCP head-of-line blocking under packet loss | Present | Still present — still WebSocket/TCP end to end |

Net effect: this should eliminate the chronic tax and the worst spikes/stalls, but it does **not**
lower the network floor — average ping could even tick up slightly for some players due to the
extra hop, and TCP retransmit stalls remain a theoretical risk. If, after shipping and measuring
this against a real same-city friend group, the residual relay-hop latency is still the bottleneck,
that's the trigger to invest in Option B.

## Architecture for Relay Tunnel Mode

```
Joiner's browser  --wss:// (unchanged)-->  Droplet
                                              |
                                    [tunnel broker: dumb byte
                                     relay, keyed by room code]
                                              |
                                     outbound tunnel connection
                                              |
                                     Host Agent (host's PC)
                                       - local Colyseus server
                                         (DuelRoom/ServerGameLoop,
                                         unmodified)
                                       - tunnel client
                                              ^
                                              | ws://localhost (direct, no relay)
                                              |
                                     Host's own browser client
```

Key properties:
- The droplet's new **tunnel broker** is a dumb byte relay keyed by room code — it does not parse
  or understand the Colyseus/msgpack protocol, so it stays resilient to future protocol/schema
  changes in `DuelRoom.ts`.
- The host's own client talks to its own machine directly — zero relay, zero added latency for the
  host player.
- Existing public `duel`/`course`/`coop` rooms and their matchmaking are untouched — this is purely
  additive infrastructure alongside them in `server/src/index.ts`.
- Room-code namespace needs a distinct prefix/format for tunnel-hosted codes so the broker can tell
  them apart from normal in-process room IDs at a glance.

## Explicit non-goals for this phase

- No WebRTC, no UDP, no Electron/native client.
- No STUN/TURN infrastructure.
- No public discovery/lobby listing for private sessions — code-only, as today.
- No accounts/auth system beyond a minimal shared secret to stop code squatting/collisions.

## Rollout

Fits the existing deploy story with no new hosting infrastructure: the tunnel broker ships as part
of the same server process (or a small sibling process) through the existing
`npm run deploy:prebuild` → commit `dist/`+`server/dist/` → `update-strafeball.sh` (`git pull` +
`pm2 restart`) flow described in `DEPLOY.md`.

## Validation

Before considering this done, run a real private session between two machines on genuinely
different networks (not the same WiFi) and confirm:
1. The session connects and plays a full match successfully.
2. The existing debug HUD network metrics (ping, server loop p95, buffer levels — see
   `NETCODE_INVESTIGATION_HANDOFF.md` / `Hud.ts`) show no CPU-throttle-style spikes during the
   session.
3. Record before/after numbers against a normal public-server match, dated, in this file or a
   follow-up log entry — matching the project's existing pattern of dated investigation updates.

## 2026-09-06 — Relay Tunnel implementation and local validation

Implemented the broker in the existing server process, a portable host agent using the existing
compiled server, and client routing for `HOST-` followed by 16 hexadecimal characters. The host
opens the locally served built game, creates a duel with the existing controls, and shares the
HOST code shown in the lobby. Joiners enter it in the existing production join field.

Colyseus 0.17 first makes an HTTP seat reservation. A tunnel-specific client endpoint
(`/colyseus/relay/HOST-…`) sends that request to the broker; the host agent substitutes its
published local room ID and forwards to its normal local matchmaker. The response body passes
through the broker unchanged. Subsequent WebSocket messages travel over a dedicated outbound
data socket for each guest. Only tunnel control messages are JSON-decoded by the broker;
gameplay frames retain their bytes, message boundaries, and text/binary flag.

The host's browser uses localhost directly for both reservation and gameplay. DuelRoom,
ServerGameLoop, shared simulation, and the original room registration/private lifecycle are
unchanged. The host publishes the room only after its own seat is connected. The broker code is
an alias; the simulation and SDK retain their normal internal room ID.

Registration uses an unpredictable code and a separate 256-bit secret. An active registration
cannot be replaced, even by a second connection with the same secret. A disconnected code retains
its secret for two minutes so the original agent can reconnect. Control reconnect uses exponential
backoff with jitter (0.5–30 seconds). Old gameplay sockets close; guests explicitly rejoin after
connectivity returns. A process restart generates a new code/secret. Broker restarts clear the
in-memory registry and agents register again. There is no persisted session or account state.

Limits: 256 registered sessions, 16 tracked data sockets per session (two sockets per guest),
16 pending reservations per session, 8 KiB request bodies, 1 MiB WebSocket payload/backlog limits,
10-second reservation/tunnel setup deadlines, and control/data ping-pong heartbeats. A visibly
closed control socket immediately disconnects guests; a silent broken link is detected within
roughly two 5-second heartbeat intervals. These are bounded-resource safeguards, not an accounts
or quota system.

Automated local validation covers arbitrary byte round trips; ordinary HTTP/WebSocket passthrough;
code collision and unauthorized data-socket rejection; timeouts and expiry; multiple simultaneous
host agents with isolated traffic; reconnecting the original agent; and a separate-process test
using real DuelRoom plus the browser SDK (reservation, snapshots, pong, full-session rejection,
invalid code, and host-process death). That test also creates public duel/course/coop rooms with
the broker installed. Browser join handshake timeout/error handling has focused tests.

Validation results: `npm test -- --reporter=dot --maxWorkers=4` passed all **490 tests** across
38 files. `npm run verify:live` passed client/server typechecks and production builds; the server
was rebuilt after the final broker fixes. The Windows x64 portable archive was built with its own
Node executable and production-only dependencies. A Chromium smoke check exercised the built
host UI's Create action and the guest UI's code entry through a local same-origin `/colyseus`
HTTP/WebSocket proxy: both displayed the same HOST code, with empty UI error messages and no
page errors. The two UI paths ran sequentially, using an SDK host to keep the guest's test room
alive, to avoid running two heavy software-rendered game views at once. This is not a full match
playtest. The test also caught and fixed credentialed CORS headers for development clients;
Chromium's cross-origin loopback permission restriction was avoided by matching production's
same-origin proxy layout, without changing browser security settings.

**Phase 5 remains pending.** These loopback tests are correctness evidence, not cross-network
latency evidence. No real two-home-network match or production before/after measurement has been
performed, and no ping improvement is claimed. The relay still executes on the shared droplet;
its own event loop can stall even though the authoritative simulation has moved to the host.

After deployment, run the same players, room format, tick preset, and duration in a public match
and then a private hosted match. Keep the HUD visible and record both players' network/provider,
ping floor/typical/max, jitter, server loop p95, client send-buffer peak, server output buffer,
and number/duration of multi-second stalls. Confirm a complete match, host exit, and a second
independent host session. Fill this table with observed values, retaining the test date:

| Date / networks / duration | Mode | Ping typical / max | Jitter | Server loop p95 | Client / server buffers | Stalls |
|---|---|---|---|---|---|---|
| Pending external playtest | Public | Not measured | Not measured | Not measured | Not measured | Not measured |
| Pending external playtest | Private host | Not measured | Not measured | Not measured | Not measured | Not measured |

See [PRIVATE_HOST_SESSIONS.md](PRIVATE_HOST_SESSIONS.md) for packaging, launching, and troubleshooting.
