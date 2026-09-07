# Phase 0: manual DataChannel experiment

Status: local integration proven; **the cross-network go/no-go gate is pending**.
This page is an isolated experiment, not the new private-host flow. Production matchmaking and
the existing relay remain available. Neither DuelRoom nor ServerGameLoop is modified by the spike.

The provisional Node library is `werift@0.24.4`, pinned as a server development dependency.
It carries real Colyseus binary frames on one reliable, ordered DataChannel. The server adapts
the channel to the existing WebSocketClient and calls public `connectClientToRoom()`. The guest
reuses HostSessionClient to consume its reservation and the SDK Room to encode/decode messages.
Reservations are created after manual ICE negotiation, so copying SDP cannot expire the seat.
There is no broker signaling, relay fallback, unreliable lane, or automatic reconnection here.
Cross-network performance must justify keeping werift before any production integration.

## Host setup

Use the development checkout with Node and dependencies installed:

```sh
npm ci
npm --prefix server ci
npm run spike:p2p:host
```

In another terminal:

```sh
npm run spike:p2p:client
```

1. Open `http://127.0.0.1:5174/` on the host machine in Chrome/Chromium.
2. Click **Host game**, then create a normal **1v1** room in the game's lobby. Select the same
   tick preset you will use for the comparison (the automated smoke uses High).
3. Share the normal room ID with the guest. This experiment uses that room ID, not a HOST code.
4. Keep the Node terminal open. It accepts one complete JSON offer per line and prints an
   `ANSWER {...}` line to send back. Its WebSocket listener is loopback-only, on port 2577.

Use the default port 2577 for the page's Host button. The terminal's optional `P2P_SPIKE_PORT`
override is for developer diagnostics; the page does not automatically discover it.

## Guest and full-match test

The guest needs only a browser. After the prebuilt experiment is deployed through the existing
deployment flow, its URL is `https://strafeball.xyz/p2p-spike/`. This guide does not imply that it
has already been deployed. Developer localhost copies also work, but are not the intended
download-free guest test.

1. Use two machines on genuinely different internet connections. Two devices on one Wi-Fi or
   two tabs on the same computer do not satisfy the gate.
2. Guest opens the diagnostic URL and clicks **Generate guest offer**. Send the entire JSON
   privately to the host, who pastes it into the Node terminal. SDP and the exported ICE stats
   contain connection addresses; do not commit raw reports to the repository.
3. Host sends back the entire `ANSWER {...}` line. Guest pastes it in the answer box and clicks
   **Apply answer**, then **Load guest game**. Join using the host's normal room ID.
4. Host starts the match. Play a full 1v1 including movement, throws, catches, a completed match,
   and leaving the room. Keep the guest tab visible while measuring.
5. Before closing the tab, reopen the diagnostic panel and click **Download direct measurements**.
   Record match duration, tick preset, visible stalls, and each player's network/browser separately.
6. Play the same duration with the same players and preset through the existing relay private-host
   flow. Record typical/max RTT, jitter, server loop p95, buffer peaks, and stall count from the
   normal HUD/flight recorder. Keep the exported report alongside these observations.

The direct JSON contains application ping samples, median/p95/max RTT, sampled server loop p95,
sampled send buffers, and browser ICE stats. It retains the most recent 3,600 visible-tab pongs;
RTT uses the existing game's millisecond clock. Zero-millisecond loopback values reflect clock
resolution. The count of pongs above one second is **not** a complete gameplay-stall detector.
Inspect the selected candidate pair to establish the actual network path. Compare the matched
pair's relay measurement, not just the historical approximately 99ms reference.

If direct ICE fails, record that result. This spike uses public Google STUN, with no TURN and no
fallback; some NAT/firewall combinations will fail. Applying an answer has a 30-second budget,
and unused host peers expire after five minutes. Refresh the guest page and restart the host
process for a clean retry; choose either Host or Guest once per page. The host accepts at most
four peer attempts per run. Do not use this diagnostic's loopback Host button on the HTTPS site.

Append dated results to DIRECT_P2P_PLAN.md. Proceed only after a real full cross-network match
shows a dramatic RTT improvement. If it does not, stop for a decision, as the implementation
prompt requires. The automated test below cannot grant that approval.

## Automated verification and deployment artifacts

```sh
npm --prefix server run spike:p2p:typecheck
npm --prefix server run spike:p2p:smoke
npm test -- --reporter=dot --maxWorkers=4
npm run verify:live
npm run spike:p2p:build
```

The smoke needs Playwright Chromium (`npx playwright install chromium` if missing), uses port
5174, and runs a real Node DuelRoom with a WebSocket host and a headless browser DataChannel
guest. It checks live-match snapshots, acknowledged input, pongs, and leaving. It does not render
or play a complete match. Results go to ignored `tmp/p2p-spike-loopback.json`. By default traffic
runs for 20 seconds; `P2P_SPIKE_SECONDS` may extend it. STUN is disabled for this loopback test.

`verify:live` now rebuilds the spike after the normal build clears `dist/`. The isolated Vite build
writes `dist/p2p-spike/`, bundles the actual game, and reuses game assets already at `dist/assets/`.
Commit that directory with the source and any changed normal deployment artifacts, then use the
existing DEPLOY.md / update-strafeball.sh / PM2 flow. No droplet build or new service is needed.
The Node experiment runs on the host checkout, not on the droplet; it is deliberately excluded
from the normal server build and portable production archive. Regular production pages do not
import or activate the spike.
