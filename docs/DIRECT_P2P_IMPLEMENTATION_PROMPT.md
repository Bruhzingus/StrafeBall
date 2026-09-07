# Direct P2P (WebRTC DataChannel) — Implementation Prompt

This is a ready-to-execute prompt, not an interview doc. The design questions were already asked,
answered, and verified against the actual Colyseus source (see "Verified before planning" in
`docs/DIRECT_P2P_PLAN.md`); paste the fenced block into a Claude Code session to implement, phase by
phase. Each phase is meant to be independently shippable — stop after any phase and the game is in a
coherent, working state.

**Phase 0 is a go/no-go gate. Do not skip it, and do not start Phase 6 before it passes.**

```text
You are replacing the gameplay transport for Strafeball's private host sessions with a direct
WebRTC DataChannel between the joiner's browser and the host's Node agent, so that a
geographically clustered friend group stops routing every packet through a droplet 1,000 miles
away.

Project identity: Strafeball is a browser-based first-person movement dodgeball prototype
(Vite + TypeScript + Babylon.js client, Colyseus 0.17 server, server-authoritative netcode with
client prediction/reconciliation). Read README.md if you need broader project context.

Background you need, in this order:
1. docs/DIRECT_P2P_PLAN.md — read in full FIRST. It contains the measured latency numbers that
   justify this work, the verified Colyseus interface findings that make it tractable, the phase
   breakdown, and the risks. Do not re-derive or re-litigate any of it.
2. docs/LOCAL_HOST_MULTIPLAYER_PLAN.md — the predecessor decision record. Explains the relay
   tunnel that already shipped and why it is being demoted to a fallback, not deleted.
3. NETCODE_INVESTIGATION_HANDOFF.md — the original netcode investigation; the source of the
   TCP head-of-line-blocking suspicion that Phase 5 addresses.

Read these files before changing anything:
1. server/src/relay/TunnelBroker.ts — the deployed broker. Your signaling relay is added here,
   additively. Note that it is deliberately protocol-agnostic and must stay that way.
2. server/src/relay/HostTunnelClient.ts — the host agent's outbound control socket and per-guest
   byte tunnels. Signaling and, later, the WebRTC peer hang off this.
3. server/src/relay/hostAgent.ts — host-mode startup, room publication, and the loopback origin
   policy you will need to relax in Phase 6.
4. shared/relayTunnel.ts — the shared code format, close codes, and friendly error strings.
5. src/game/network/hostSession.ts — HostSessionClient, which already overrides
   consumeSeatReservation. Your client transport work builds on this, NOT on a fresh Client.
6. src/game/network/MultiplayerClient.ts — resolveServerUrl(), createRoom()/joinRoom(), and the
   HOST- code branch.
7. shared/snapshotCodec.ts — READ decodeTieredSnapshot CAREFULLY before Phase 5. Tiered snapshots
   carry absent lanes forward from the previous snapshot; they are NOT drop-safe.
8. server/tests/RelayTunnel.test.ts and server/tests/RelaySession.integration.test.ts — the
   existing test patterns (real processes, real DuelRoom) you should extend rather than replace.

## Locked decisions (already settled — do not re-litigate these)

- The sim stays in the native Node host agent. DuelRoom.ts and ServerGameLoop.ts are NOT modified,
  and the simulation never runs in a browser tab. Only the transport between joiner and agent
  changes.
- Joiners still download nothing, ever. WebRTC is built into their browser. The join UX stays
  "visit strafeball.xyz, enter a HOST- code."
- The existing public matchmaking (duel/course/coop, quick-join) stays completely unchanged and
  unaffected. Zero regression tolerance. This remains purely additive.
- The relay tunnel is NOT deleted. It is demoted to (a) the signaling channel, (b) the fallback
  path for pairs that cannot hole-punch, and (c) the unchanged matchmaking/seat-reservation route.
- The broker must remain a dumb forwarder. It must NOT parse SDP, ICE candidates, or the
  Colyseus/msgpack protocol. Signaling payloads are opaque, size-capped strings.
- No TURN infrastructure and no new hosting infrastructure. The existing byte relay IS the
  fallback. STUN uses free public servers.
- No Electron/native client for joiners, and no hand-rolled UDP protocol. SCTP over DTLS
  (the DataChannel) is the transport.
- Server-side integration goes through connectClientToRoom(), which is public API exported from
  @colyseus/core. Do NOT write a Colyseus Transport subclass — WebSocketTransport.onConnection
  shows the full required surface, and it is duck-typeable.
- Ship through the existing DEPLOY.md / update-strafeball.sh / pm2 flow. Build artifacts in dist/
  and server/dist/ are committed; ALWAYS run `npm run verify:live` and commit the rebuilt
  artifacts, or the droplet will run stale code.

## Suggested phases

### Phase 0 — Spike (GO/NO-GO GATE)
Prove the risky part in isolation before building anything real: a browser DataChannel to a Node
peer, carrying real Colyseus frames, joining a real unmodified DuelRoom via connectClientToRoom,
playing a real match. Hardcode signaling (copy/paste SDP by hand). No broker integration, no UX,
no fallback. Throwaway code is fine and expected.

Also decide the Node WebRTC library here: node-datachannel (libdatachannel bindings, prebuilt
binaries, faster) versus werift (pure TypeScript, no native dependency). Prefer werift if its
performance is adequate, to keep the portable host archive free of native modules.

- Acceptance: a full 1v1 match played over a DataChannel between two machines on genuinely
  different networks, with the direct RTT recorded alongside that same pair's relay-mode RTT.
- STOP HERE if the direct RTT is not dramatically better than the ~99ms relay figure. Every
  later phase is justified only by that number. Report it and wait for a decision.

### Phase 1 — Signaling over the existing broker
Add an opaque signaling relay to TunnelBroker and HostTunnelClient: a per-joiner signaling
channel keyed by the existing HOST- code, forwarding size-capped opaque payloads bidirectionally
between a joiner and the host agent. The broker must not inspect payload contents.

- Acceptance: arbitrary opaque payloads round-trip both directions; multiple concurrent joiners
  are fully isolated; host disconnect cleanly closes signaling channels; the entire existing
  server and client test suites still pass unchanged.

### Phase 2 — Server-side transport shim
A DataChannelClient (duck-typed rawClient: on('message'/'close'/'error'/'pong'), send, close,
readyState, pingCount) plus a synthetic req carrying sessionId and the /processId/roomId path,
handed to connectClientToRoom. DuelRoom must not change.

- Acceptance: unit tests for readyState mapping and close-code propagation; a joiner completes a
  full seat-reservation -> join -> play -> leave cycle over a DataChannel.

### Phase 3 — Client-side transport
WebRTCTransport implementing the SDK's ITransport (isOpen, send, sendUnreliable, connect, close),
plus the Room.connect() override required to install it. The SDK's Connection class hardcodes
transport selection with no plugin hook — see Risk 1 in the plan. Reuse the existing
HostSessionClient seat-reservation path unchanged; only the gameplay socket changes.

- Acceptance: joining by HOST- code establishes a direct DataChannel; the debug HUD ping reflects
  direct RTT, not relay RTT. Pin the @colyseus/sdk version exactly and add a test that fails
  loudly if Connection or Room.connect changes shape on upgrade.

### Phase 4 — Fallback and failure handling
If ICE fails or exceeds a 5s budget, fall back to the existing relay path transparently. A player
must never see a failure — only a quiet HUD indicator of which path is in use.

- Acceptance: with STUN blocked, the joiner still connects via relay; the HUD reports the active
  path; killing the host mid-match produces a clean disconnect on BOTH paths.

### Phase 5 — Unreliable lane (CONDITIONAL — read the constraint first)
DataChannels can be unordered/unreliable, removing TCP head-of-line blocking. BUT tiered snapshots
are not drop-safe: decodeTieredSnapshot carries absent lanes forward from the previous snapshot,
so a dropped packet corrupts state until that lane is next sent. Resolve that FIRST. Preferred fix:
have the tiered encoder emit a full keyframe snapshot every N ticks so any loss self-heals within
a bounded window. Keep state patches and all room messages on the reliable ordered channel; only
snapshots and player input are candidates for the unreliable lane.

- Acceptance: under simulated 2-5% packet loss, no visible state corruption, plus a measurable
  reduction in stall duration versus the reliable channel.

### Phase 6 — Host UX (do not start before Phase 0 passes)
- Host uses strafeball.xyz instead of localhost:2567, via Chrome's local-network-access permission
  (verified: navigator.permissions reports "prompt", not a hard block). This requires allowing the
  https://strafeball.xyz origin in hostAgent.ts's authorize callback, which currently rejects all
  non-loopback origins, plus CORS on /private-host/*.
- Keep the localhost:2567 page as fallback. Firefox and Safari are UNTESTED — verify before
  relying on the permission.
- Auto-open the browser on agent start.
- Do not surface a HOST- code until a room is actually published (today it 404s until the host
  clicks Create).
- Drop dist/ from the host archive once the UI comes from the site (~520MB -> ~270MB), and prune
  uWebSockets.js's foreign-platform binaries (114MB more).
- Publish the archive (GitHub Releases) and link it from the lobby. releases/ is gitignored and
  nothing links to it, so the feature is currently undiscoverable.

### Phase 7 — Validation & measurement
Record dated before/after numbers in docs/DIRECT_P2P_PLAN.md, following the project's existing
pattern of dated investigation log entries: public match vs relay match vs direct match, same
players and duration, recording ping typical/max, jitter, server loop p95, buffer peaks, and
stall count.

## Decision gates

- After Phase 0: if direct RTT is not dramatically better than relay RTT for a real pair, stop and
  report. The remaining phases exist only because of that number.
- After Phase 4: if the ICE success rate among the actual friend group is poor, this is a relay
  with extra steps. Reassess before Phase 5.
```

## Future direction (do not build now)

If ICE success rates prove poor across the group's specific routers, the remaining option is the
one deferred in `LOCAL_HOST_MULTIPLAYER_PLAN.md` Option B: a native downloadable client for every
participant with a custom UDP transport. That breaks the "no download for joiners" constraint and
should only be considered if measurements force it. Do not design toward it now.
