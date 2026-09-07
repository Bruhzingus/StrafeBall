# Direct P2P (WebRTC DataChannel) — Plan & Decision Record

Date: 2026-09-07

Successor to `LOCAL_HOST_MULTIPLAYER_PLAN.md`. That document selected Relay Tunnel Mode and
shipped it (commit `2075b01`). This document records why the relay is **not** the right answer for
this specific player group, and plans the transport that is.

## Problem, restated with measurements

The friend group is geographically clustered and far from the droplet (SFO2, `167.172.203.103`).

- Measured RTT, host machine → droplet: **49ms** (`ping`, 6 packets, 0% loss, min 46 / max 53).
- Today's public match: `player → droplet(sim) → player` ≈ **50ms + ~20ms CPU-throttle tax**.
- Relay Tunnel Mode: `joiner → droplet → host(sim) → droplet → joiner` ≈ **99ms**, tax removed.

Relay Tunnel Mode removes the throttle tax and the multi-second stalls, but **roughly doubles the
round trip** because every packet detours to San Francisco to reach a machine in the same city as
the joiner. It also makes latency **asymmetric**: the host plays against `127.0.0.1` at ~0ms while
the joiner sits at ~100ms — a real competitive advantage for whoever hosts, in a
server-authoritative game with client prediction.

For a same-region friend group, the correct path is host↔joiner **direct**, with no droplet in the
gameplay path at all. Same-metro RTT is typically 10-30ms.

### Why direct wasn't possible before

Two walls, both real:

1. The host is behind a home router on a private IP. Nothing can open an inbound connection without
   port forwarding.
2. A page on `https://strafeball.xyz` can only open `wss://`, and you cannot obtain a
   browser-trusted TLS certificate for a residential IP that changes.

WebRTC goes through both: ICE/STUN hole-punches outbound-only (wall 1), and DataChannels use DTLS
with self-signed certificates that browsers accept by design (wall 2). Joiners still download
nothing — WebRTC is built into the browser.

## Why this was rejected before, and why that reasoning no longer holds

`LOCAL_HOST_MULTIPLAYER_PLAN.md` Option A rejected WebRTC because it "requires replacing
`DuelRoom.ts`'s entire Colyseus message/broadcast layer" and running the sim inside the host's
browser tab.

That conflated two separable things. **Keep the native Node host agent** (so the sim runs in a real
process, not a throttled tab, and `DuelRoom`/`ServerGameLoop` stay untouched) and change **only the
transport** between joiner and agent. Colyseus supports exactly this on both sides.

## Verified before planning (2026-09-07)

| Claim | Evidence |
|---|---|
| Browsers permit a public HTTPS page → local agent | Chrome exposes `local-network-access` as a **permission**, not a block. `navigator.permissions.query({name:'local-network-access'})` → `"prompt"`; unprompted connect stays pending (not an error); granted → connects. Headless auto-denies, which is what produced the earlier `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`. |
| Server can accept a non-WebSocket client | `connectClientToRoom(room, client, authContext, opts)` is **public API**, exported from `@colyseus/core`'s `index.d.ts`. |
| Server needs no `Transport` subclass | `WebSocketTransport.onConnection` only calls `new WebSocketClient(sessionId, rawClient)` then `connectClientToRoom`. `rawClient` surface: `on('message'/'close'/'error'/'pong')`, `send`, `close`, `readyState`, `pingCount`. `req` surface: `.url`, `.headers`, `.socket.remoteAddress`. All duck-typeable over a DataChannel. |
| Client transport is a small interface | `ITransport` = `isOpen`, `send`, `sendUnreliable`, `connect`, `close`. `sendUnreliable` already exists — the SDK anticipates unreliable transports. |
| Client transport is **not** registrable | `Connection`'s constructor hardcodes `switch (protocol)` → `h3` or WebSocket. No plugin hook. Must be worked around (see Risk 1). |
| Tiered snapshots are **not** drop-safe | `decodeTieredSnapshot(snapshot, previous)` carries lanes forward from `previous` when absent (`shared/snapshotCodec.ts:172-182`). A dropped packet loses that lane until the next tick that includes it. See Phase 5. |

## Architecture

```
Joiner browser ──── WebRTC DataChannel (DTLS/SCTP, direct) ────► Host agent (Node)
      │                                                              │ 127.0.0.1
      └── HTTPS matchmaking + SDP/ICE signaling ──► droplet ◄────────┘  Host browser
                                                   (existing broker)
```

- **Droplet**: matchmaking seat reservation + signaling relay + byte-relay fallback. All already
  built — the broker's control channel already relays JSON frames (`{type:'http'|'open'}`); this
  adds `{type:'signal'}`.
- **Host agent**: unchanged `DuelRoom`/`ServerGameLoop`. Gains a WebRTC peer + a shim that hands
  each opened DataChannel to `connectClientToRoom`.
- **Joiner**: unchanged UI and unchanged join-by-code UX. Gains a `WebRTCTransport`.
- **Host's own client**: still `localhost`, still ~0ms, unchanged.
- **STUN**: free public servers for candidate gathering. **No TURN needed** — the existing byte
  relay is the fallback for pairs that fail to punch through.

## Phases

### Phase 0 — Spike (do this before committing to the rest)
Prove the risky part in isolation: a browser DataChannel to a Node peer, carrying real Colyseus
frames, joining a real unmodified `DuelRoom` via `connectClientToRoom`, playing a real match.
Hardcode signaling (copy/paste SDP) — no broker integration, no UX.

Also decide the Node WebRTC library here: `node-datachannel` (libdatachannel bindings, prebuilt
binaries, faster) vs `werift` (pure TypeScript, no native dependency in the host package). Prefer
`werift` if its performance is adequate, to keep the host archive free of native modules.

**Acceptance:** a full 1v1 match played over a DataChannel between two machines on different
networks, with measured RTT recorded against the same pair's relay-mode RTT. **This is the gate —
if the direct RTT is not dramatically better than ~99ms, stop and reconsider.**

### Phase 1 — Signaling over the existing broker
Add a `{type:'signal'}` message class to the broker control channel and the host agent, relaying
SDP offers/answers and ICE candidates between a joiner and the host, keyed by the existing
`HOST-…` code. The broker stays a dumb forwarder — it must not parse SDP.

**Acceptance:** two peers exchange SDP/ICE through the deployed broker and establish a DataChannel
with no manual copy/paste. Existing relay tests still pass.

### Phase 2 — Server-side transport shim
A `DataChannelClient` (duck-typed `rawClient`) plus a synthetic `req` carrying the sessionId and
`/processId/roomId` path, handed to `connectClientToRoom`. `DuelRoom` must not change.

**Acceptance:** unit tests for the shim's `readyState` mapping and close-code propagation; a joiner
completes a full seat-reservation → join → play → leave cycle over the DataChannel.

### Phase 3 — Client-side transport
`WebRTCTransport implements ITransport`, plus the `Room.connect()` override needed to install it
(see Risk 1). Reuse the existing `HostSessionClient` seat-reservation path unchanged — only the
gameplay socket changes.

**Acceptance:** joining by `HOST-…` code establishes a direct DataChannel; HUD ping reflects direct
RTT, not relay RTT.

### Phase 4 — Fallback and failure handling
If ICE fails or times out (target: 5s budget), fall back to the existing relay path transparently.
The player should never see a failure — only a quieter HUD indicator of which path is in use.

**Acceptance:** with STUN blocked, the joiner still connects via relay; the HUD reports the path;
killing the host mid-match still produces a clean disconnect on both paths.

### Phase 5 — Unreliable lane (conditional — read this before starting)
DataChannels can be unordered/unreliable, which removes TCP head-of-line blocking — the residual
risk flagged in `NETCODE_INVESTIGATION_HANDOFF.md` and suspected in a real ping-spike log.

**But tiered snapshots are not drop-safe today.** `decodeTieredSnapshot` carries absent lanes
forward from the previous snapshot, so a lost packet corrupts state until that lane is next sent.
Three options, in order of preference:

1. Periodic keyframes — have the tiered encoder emit a full snapshot every N ticks, so any loss
   self-heals within a bounded window. Cheapest, and independently useful.
2. Unreliable only in `baseline` mode (full snapshots are already self-contained).
3. Sequence numbers + gap detection + reliable resend. Most work, least attractive.

Keep state patches and all room messages on the **reliable ordered** channel regardless. Only
snapshots and player input are candidates.

**Acceptance:** measured packet-loss resilience — simulate 2-5% loss and confirm no visible state
corruption, with a measurable reduction in stall duration versus the reliable channel.

### Phase 6 — Host UX
Now that hosting is worth using, fix the flow (see `PRIVATE_HOST_SESSIONS.md` for today's):
- Host uses **strafeball.xyz**, not `localhost:2567`, via the local-network-access permission.
  Requires allowing the `https://strafeball.xyz` origin in `hostAgent.ts`'s `authorize` (it
  currently rejects all non-loopback origins) plus CORS on `/private-host/*`.
- Keep the `localhost:2567` page as the fallback for browsers without the permission (Firefox and
  Safari are **untested** — verify before relying on it).
- Auto-open the browser on agent start.
- Don't surface a `HOST-…` code until a room is actually published (today's code 404s until the
  host clicks Create — a guaranteed support question).
- Drop `dist/` from the host archive once the UI comes from the site: ~520MB → ~270MB. Pruning
  `uWebSockets.js`'s foreign-platform binaries (114MB) gets it near ~150MB.
- Publish the archive (GitHub Releases) and link it from the lobby. `releases/` is gitignored and
  nothing links to it today, so the feature is currently undiscoverable.

### Phase 7 — Validation
Dated before/after in this file, same pattern as prior investigation logs: public match vs relay
match vs direct match, same players and duration, recording ping typical/max, jitter, server loop
p95, buffer peaks, and stall count.

## Risks

1. **SDK internal coupling (highest).** `Connection` hardcodes transport selection, so installing
   `WebRTCTransport` requires overriding `Room.connect()` — ~30 lines reimplemented from
   `Room.mjs:68-102`. Mitigation: pin `@colyseus/sdk` exactly, keep the override minimal, and add a
   test that fails loudly if the SDK's `Connection`/`Room.connect` shape changes on upgrade.
2. **ICE failure rate.** Symmetric NAT / CGNAT pairs can't punch through — expect 10-20% of pairs.
   Mitigation: Phase 4 relay fallback, which already exists and is deployed.
3. **Native dependency in the host package.** `node-datachannel` is platform-specific and
   complicates the portable archive. Mitigation: evaluate `werift` (pure TS) in Phase 0.
4. **Snapshot drop-safety.** Covered in Phase 5. Do not enable an unreliable lane before resolving
   it — silent state corruption is far worse than head-of-line blocking.
5. **Reconnection.** `Room.reconnection` assumes URL-based reconnect; WebRTC needs re-signaling.
   Keep it disabled for P2P sessions initially, as `HostSessionClient` already does.
6. **Host IP exposure.** Direct P2P reveals the host's IP to joiners (inherent to all P2P). The
   relay currently hides it. Worth a line in the host docs; acceptable among friends.

## What the relay work buys us

The Relay Tunnel work is not discarded. It becomes:
- the **signaling channel** (Phase 1),
- the **fallback path** for NAT-hard pairs (Phase 4),
- the matchmaking/seat-reservation route, unchanged,
- the host agent, packaging, and `HOST-…` code namespace, unchanged.

`LOCAL_HOST_MULTIPLAYER_PLAN.md` predicted precisely this: "Building C now is never wasted work:
worst case it's the foundation a later phase needs anyway."

## Decision gates

- **After Phase 0:** if direct RTT isn't dramatically better than relay RTT for a real pair, stop.
  The remaining phases are only worth it because of that number.
- **After Phase 4:** if the ICE success rate among the actual friend group is poor, the feature is
  a relay with extra steps — reassess before Phase 5.
- **Do not build Phase 6 before Phase 0 passes.** Polishing the host flow is only worthwhile if the
  thing it makes accessible is actually faster.

## Explicit non-goals

- No Electron/native client for joiners. Browser-only, zero download, unchanged.
- No custom UDP protocol — SCTP over DTLS is the transport.
- No TURN infrastructure — the existing byte relay is the fallback.
- No change to public matchmaking. Still purely additive, still zero regression tolerance.

## 2026-09-07: Phase 0 local integration result (gate pending)

An isolated manual-SDP spike now connects Chromium to `werift@0.24.4` in the native Node process,
using one reliable ordered DataChannel and real Colyseus frames. It reuses HostSessionClient and
connectClientToRoom; DuelRoom and ServerGameLoop remain unmodified. Werift is provisional and
development-only until a real network comparison establishes adequate performance.

At 09:26:18-09:26:39 UTC, the single-machine Windows loopback smoke used the High preset
(128Hz simulation/input, 90Hz target snapshots), disabled STUN, and ran gameplay input for
20 seconds. It observed live-match snapshots and acknowledged input sequence 2,561, received
1,719 snapshots and 20 application pongs, and completed a clean guest/host leave. Sustained
input was approximately 128/s with no token-rate rejections.

| Local diagnostic | Observed value |
| --- | --- |
| Application RTT median / p95 / maximum | 0 / 11 / 11 ms |
| Largest sampled server loop p95 | 31.8 ms |
| Largest sampled server outbound buffer (includes startup) | 66,692 bytes |
| Application pong samples at least 1,000ms | 0 |
| Same-pair relay RTT | Not measured |
| Full match on genuinely different networks | Not performed |

These are millisecond-clock loopback measurements, not an internet latency claim, a full-match
acceptance result, or a go decision. Snapshot and buffer values include startup; the automated
guest sends input but does not render the game. The ping-tail count is not a comprehensive
gameplay stall count. Raw local JSON is kept in ignored `tmp/p2p-spike-loopback.json`.

**Phase 0 remains pending.** Follow [DIRECT_P2P_SPIKE.md](DIRECT_P2P_SPIKE.md) to run a full
1v1 across different networks and compare the same pair and preset through the existing relay.
Record direct/relay typical and maximum RTT, jitter, loop p95, buffer peaks, visible stalls,
match duration, and selected ICE candidate pair. Do not infer improvement over the historical
approximately 99ms relay value from this loopback result. Later production integration awaits
the required real-pair measurement.
