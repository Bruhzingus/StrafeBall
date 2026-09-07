# Private host sessions

The host runs the simulation on their computer. Friends visit **https://strafeball.xyz**, enter
the host's `HOST-...` code in Join, and install nothing. Direct WebRTC is attempted automatically;
the existing byte relay takes over if negotiation fails or reaches five seconds.

## Play with a friend

1. Download the [Windows host app](https://github.com/Bruhzingus/StrafeBall/releases/download/private-host-latest/strafeball-host-win32-x64.zip),
   unzip it, and double-click **Start Private Host.cmd**. The archive includes Node and dependencies.
2. The website opens in host mode. Use Chrome and allow local network access when prompted.
   If the browser cannot connect, open **http://localhost:2567** instead. This fallback serves the
   same website through the agent and also requires internet access.
3. Enter your name, select 1v1 or 2v2 and a tick preset, and click **Host**. The share code appears
   only after the room is published. Send that code to your friend.
4. Your friend opens the normal website, enters their name and your code, then clicks **Join**.
   Start the match when both players are ready. Keep the host app and computer awake throughout.

The ping display identifies **Direct**, **Relay**, or **Local host**. The host's own browser uses
loopback. Public server rooms still use their existing connection and display **Server**.
For a comparison, the guest can leave, enable **Use relay for this join** under Connection options,
and join again. Use a fresh match with matching settings if the old one has ended or is locked.

Closing the host app disconnects guests. Restarting generates a new code. One agent publishes one
room at a time. Existing room capacity, disposal, and match rules still apply. Direct peer sessions
continue if only the signaling broker connection is lost; relay sessions disconnect and can rejoin
once the agent reconnects. There is no automatic mid-match transport migration or reconnection.
Loss of direct traffic is bounded by a ten-second heartbeat deadline (plus timer scheduling).

Chrome's website-to-loopback permission is documented by [Chrome](https://developer.chrome.com/blog/local-network-access).
Firefox/Safari website-to-agent behavior remains unverified; use the localhost fallback. Direct
WebRTC exposes connection addresses to the other players, as expected for peer-to-peer networking.

## Build and release

```sh
npm run verify:live
npm test -- --reporter=dot --maxWorkers=4
npm --prefix server run test:direct
npm run host:package
```

`verify:live` rebuilds the normal client, server, and isolated manual spike. Commit source and
`dist/` / `server/dist/` together. The host package includes the compiled server, runtime
dependencies, Node and its license. It omits the game asset directory and prunes foreign-platform
uWebSockets binaries. Windows produces a ZIP; other platforms produce a tar.gz when built on that
platform. Only the Windows package has been tested here. Artifacts are in ignored `releases/`.

`node scripts/publish-private-host.mjs <tested.zip>` creates the initial `private-host-latest`
GitHub Release and its Windows download. It uses the existing Git credential helper, uploads to
a draft first, and publishes only after upload succeeds. It refuses to overwrite an existing release.
Push the source/artifact commit before publishing so the release resolves to the correct commit.
Future releases should use a reviewed versioned replacement and update the lobby's download link.

Use the existing DEPLOY.md / update-strafeball.sh / PM2 pull-and-restart flow on the droplet. No
new service, TURN server, database, or port is required. The existing `/colyseus/` prefix proxy
must forward the new `/relay/HOST-.../signal` WebSocket route as it does other relay paths.

## Developer options

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `COLYSEUS_PORT` | `2567` | Loopback agent port; the website's host discovery uses the default |
| `RELAY_BROKER_URL` | `wss://strafeball.xyz/colyseus` | Broker endpoint; remote brokers require WSS |
| `HOST_CLIENT_DIR` | Repository `dist/` | Optional local game files; absent files use the website proxy |
| `HOST_OPEN_BROWSER` | Off in source, on in portable launcher | Open the website when the agent starts |
| `DIRECT_DISABLED` | Off | Set `1` on the host to force relay for diagnostics |
| `DIRECT_NO_STUN` | Off | Set `1` only for local integration tests |

`npm --prefix server run test:direct` uses real broker/host processes and Chromium. It verifies
automatic direct joins, a five-second ICE failure followed by relay, explicit relay selection,
live snapshots, acknowledged input, consented leave, and host death. It writes a local integration
report to ignored `tmp/direct-integration.json`. These checks do not establish internet latency.

WebRTC gameplay uses one reliable ordered channel. The conditional unreliable snapshot work is
still deferred: tiered snapshots are not safe to drop, and there is no measured loss/stall result
justifying that change. DuelRoom and ServerGameLoop are unmodified.

The cross-network performance gate remains **unverified**. Compare a full match through Direct
and Relay with the same pair, preset and duration, and record typical/max ping, jitter, server
loop p95, buffer peaks and visible stalls in [DIRECT_P2P_PLAN.md](DIRECT_P2P_PLAN.md).
