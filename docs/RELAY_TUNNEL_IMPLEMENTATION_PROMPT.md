# Relay Tunnel Mode (Private Host Sessions) — Implementation Prompt

This is a ready-to-execute prompt, not an interview doc. The design questions were already asked
and answered directly (see "Locked decisions" below and the full rationale in
`docs/LOCAL_HOST_MULTIPLAYER_PLAN.md`); paste the fenced block into a Claude Code session to
implement, phase by phase. Each phase is meant to be independently shippable — stop after any
phase and the game is in a coherent, working state.

```text
You are adding a "private host session" feature to Strafeball, alongside its existing public
multiplayer server, so friends who are on different home networks (not the same LAN/router) can
play a match with much better latency than the shared production server currently offers.

Project identity: Strafeball is a browser-based first-person movement dodgeball prototype
(Vite + TypeScript + Babylon.js client, Colyseus 0.17 server, server-authoritative netcode with
client prediction/reconciliation). Read README.md if you need broader project context.

Background you need: read docs/LOCAL_HOST_MULTIPLAYER_PLAN.md in full first — it documents the
root cause this feature addresses (a shared-vCPU droplet throttling the Node event loop, see
NETCODE_INVESTIGATION_HANDOFF.md), the options that were considered and rejected, and why this
specific design ("Relay Tunnel Mode") was chosen. Do not re-litigate those decisions.

Read these files before changing anything:
1. server/src/index.ts — how the server is composed today (defineServer, room registration for
   duel/course/coop, port resolution, the ensureGlobalWebSocket droplet shim). Your new tunnel
   broker gets wired in here, additively.
2. server/src/rooms/DuelRoom.ts — the existing private-room lifecycle (setPrivate(true), onCreate,
   match settings resolution) that you are NOT changing, but must not break.
3. server/src/simulation/ServerGameLoop.ts — the authoritative sim driven by DuelRoom. You will not
   modify its logic; you need to understand that it (and shared/simulation/*) already runs
   standalone in a plain Node process with no droplet-specific dependency.
4. src/game/network/MultiplayerClient.ts — resolveServerUrl(), createRoom()/joinRoom() — the
   client-side connection logic your changes must stay compatible with.
5. src/game/network/MultiplayerOverlay.ts — the lobby UI (name field, Create button, Join
   text field) that already treats a room code as an opaque string to hand to joinById().
6. shared/roomSettings.ts, shared/tickPresets.ts — existing patterns for resolving room
   configuration, to imitate for any new configuration this feature needs.
7. DEPLOY.md, scripts/update-strafeball.sh — the existing build-locally/commit-artifacts/
   pull-and-restart deploy flow. This feature must ship through this same flow, no new
   infrastructure.
8. scripts/dev-online.mjs — precedent for running the server as a standalone local process
   alongside the Vite client, which is effectively what the host agent needs to do.

## Locked decisions (already settled — do not re-litigate these)

- Scope: this phase is Relay Tunnel Mode ONLY. Do not build WebRTC, UDP, or an Electron/native
  client — those are explicitly a separate, larger, deferred future phase (see "Future direction"
  in docs/LOCAL_HOST_MULTIPLAYER_PLAN.md). Do not design toward them now.
- The existing public matchmaking (duel/course/coop rooms, quick-join flow) must remain completely
  unchanged and unaffected. Zero regression tolerance there — this feature is purely additive.
- Joiners never download anything, ever, for this feature. They use the existing strafeball.xyz
  page and the existing room-code join field. The happy-path UX for a joiner should look identical
  to joining any other private room today.
- The host downloads and runs exactly one thing: the existing server code plus a thin tunnel-client
  addition. Do not reimplement DuelRoom or ServerGameLoop — reuse them completely unmodified. The
  host's own client connects to their own localhost server directly (no relay, no added latency for
  the host player).
- Gameplay transport stays WebSocket/Colyseus end-to-end. This phase does not touch UDP or WebRTC.
- The droplet's new relay component (the "tunnel broker") must be a dumb byte relay keyed by room
  code — it must NOT parse or understand the Colyseus/msgpack protocol. It only forwards frames
  bidirectionally between a joiner's socket and the corresponding host tunnel socket. This keeps it
  resilient to future protocol/schema changes in DuelRoom without needing updates itself.
- Room codes for tunnel-hosted sessions need a distinct format/prefix from normal in-process room
  IDs, so the broker (and, if useful, the client) can tell them apart immediately.
- Concurrency: the broker must support multiple simultaneous host agents/private sessions at once,
  fully isolated from each other.
- Abuse/collision: prevent one host's code registration from silently overwriting or hijacking
  another active session's code. A simple per-registration secret/token is sufficient — this does
  not need a real accounts system.
- This must fit into the existing deploy story (DEPLOY.md / update-strafeball.sh / pm2) with no new
  hosting infrastructure, databases, or external services.
- Do not alter the existing setPrivate(true) behavior or normal private-duel create/join flow.

## Suggested phases

### Phase 1 — Tunnel broker service (droplet-side)
- Build the broker: accepts a host agent's outbound tunnel connection with a room code + secret,
  holds a live registry (code -> tunnel connection), and proxies bytes bidirectionally between a
  joiner's WebSocket connection and the matching host tunnel connection.
- Wire it into server/src/index.ts alongside the existing duel/course/coop room registration,
  without modifying those rooms.
- Define the tunnel-hosted code format/prefix so it's unambiguous versus a normal room ID.
- Acceptance: a test/script client can register a fake tunnel and round-trip bytes through the
  broker correctly; the existing server test suite still passes unchanged, proving duel/course/coop
  are unaffected.

### Phase 2 — Host agent
- Package the existing server startup (server/dist) with an addition: on start, open the outbound
  tunnel connection to the broker, register a code (plus secret), and print/display the code for
  the host to share with friends.
- The local Colyseus server continues running exactly as it does today (DuelRoom/ServerGameLoop
  unmodified), so the host's own client can connect to localhost directly.
- Acceptance: running the host agent locally produces a working code; a second machine on a
  genuinely different network (not the same WiFi) can join purely by visiting strafeball.xyz and
  entering that code, and play a full real match end-to-end.

### Phase 3 — Client-side join handling + UX polish
- Confirm/adjust MultiplayerOverlay.ts and MultiplayerClient.ts so a tunnel-hosted code round-trips
  correctly through joinById() — this should require minimal changes if the broker's relay is
  transparent, but verify and fix any assumption that breaks.
- Add clear, distinct error states for "host disconnected," "host agent not reachable," and
  "invalid/expired code," separate from a generic connection failure.
- Acceptance: entering a bad or expired host code produces a clear, friendly message — never a
  silent hang or a raw Colyseus error surfaced to the player.

### Phase 4 — Reliability & edge cases
- Handle the host agent crashing or closing mid-match: joiners get a clean, immediate disconnect
  notice, not a hang.
- Handle the tunnel connection dropping and reconnecting (retry/backoff) without corrupting broker
  state or silently reassigning a code to the wrong session.
- Verify multiple independent host agents running concurrently do not interfere with each other's
  codes or traffic.
- Acceptance: killing the host agent process mid-match produces a clean joiner-side disconnect;
  two simultaneous private sessions from different hosts stay fully isolated from each other.

### Phase 5 — Validation & measurement
- Playtest a real private session across two genuinely different home networks (not the same LAN)
  with a friend. Use the existing debug HUD network instrumentation (ping, server loop p95, buffer
  levels — see NETCODE_INVESTIGATION_HANDOFF.md and Hud.ts) to compare against a normal
  public-server match under the same conditions.
- Acceptance: record dated before/after numbers (ping stability, absence of the previously observed
  multi-second stalls) back into docs/LOCAL_HOST_MULTIPLAYER_PLAN.md, following the project's
  existing pattern of dated investigation log entries.

## Future direction (do not build now)

If Phase 5's measurements show the relay-hop latency is still a bottleneck for a same-city friend
group, a later phase could add a genuinely direct path: a downloadable native client for every
participant, a custom UDP transport, and direct hole-punched P2P, with this same tunnel broker
serving as the NAT-traversal fallback for pairs that can't punch through (full reasoning in
docs/LOCAL_HOST_MULTIPLAYER_PLAN.md, Option B). Don't design toward this now — but if it's
essentially free to keep the broker's registry from being byte-relay-only versus rendezvous-only,
prefer the choice that doesn't foreclose it later. Do not add complexity now to accommodate it.
```
