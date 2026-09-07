# Private host sessions

Friends join at **https://strafeball.xyz** by entering a `HOST-…` code in the existing room-code
field. They install nothing. The updated server and client must be deployed together first.

## Host: one portable download

Extract the host archive for your OS and architecture. On Windows, double-click
`Start Private Host.cmd`; on Linux/macOS, run `./start-private-host.sh`. The archive includes
Node, runtime dependencies, the existing server, and the built browser game.

1. Keep the terminal running and open **http://localhost:2567**.
2. Enter your name, choose the usual format/tick preset, and click **Create**.
3. Share the **HOST-…** code displayed in the lobby. Friends join on the normal website.
4. Play with the normal match controls. Your own browser connects directly to localhost.

Only a duel you create in that local page is published. A code printed before you click Create
is registered but not yet playable. One agent publishes one room at a time; creating a new room
publishes that new room under the agent's code. Stop/restart the agent to get a fresh code.
Rooms keep their ordinary private/auto-dispose behavior. No port forwarding or router changes
are needed. Keep the computer awake while playing.

Closing or killing the agent disconnects guests. Temporary tunnel loss also disconnects guests;
the running agent retries with its existing code and secret, and guests can join again once it
reports “Relay connected.” The secret is never printed or placed in URLs.

## Developer/release commands

From the repository root:

```sh
npm run verify:live
npm run host:private
```

To produce a portable archive for the build machine's OS/architecture:

```sh
npm run host:package
```

This runs the existing local prebuild checks, copies the built client/server, installs only server
runtime dependencies into an isolated release folder, and bundles the current Node executable and
license. Windows produces a ZIP; Linux/macOS produce a tar.gz. Outputs are under ignored
`releases/`; publish/distribute the archive separately. Build with a Node version supported by
Colyseus (20+) on the target OS. The package is not a cross-compiled or signed installer.

Environment overrides:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `COLYSEUS_PORT` | `2567` | Local server and local game port; choose another for a second agent |
| `RELAY_BROKER_URL` | `wss://strafeball.xyz/colyseus` | Existing production server endpoint; only loopback brokers may use `ws://` |
| `HOST_CLIENT_DIR` | Repository/package `dist/` | Built client path override, useful when running source through tsx |

For local testing run a normal broker on port 2567, then a host on port 2568 pointed at
`ws://127.0.0.1:2567`. Open the host page on port 2568. A separate client pointed at the broker
can enter the HOST code. This verifies routing but does not replace a test across different homes.

## Deployment

The broker starts additively with the normal server entry point. Keep the existing
`deploy:prebuild` → commit source and artifacts → pull/restart PM2 flow. No second port, database,
service, or DNS entry is required. The existing `/colyseus/` reverse proxy must forward all nested
HTTP paths and WebSocket upgrades, including `/colyseus/relay/…`, stripping `/colyseus` exactly as
it does for normal matchmaking. No new nginx location is needed when that existing prefix proxy
is configured as documented. Heartbeats keep control/data connections active through idle proxies.

The `--private-host` flag selects host mode instead of broker mode and binds the server to
127.0.0.1. The default public-server startup retains its existing bind behavior and room types.

## Friendly failures

| Message | Action |
|---|---|
| Invalid or expired host code | Check the full code; get a fresh code after an agent restart |
| Host disconnected | Wait for the host to reconnect/restart, then join again |
| Host agent not reachable | Ask the host to leave the agent running and Create a local match; check broker connectivity |
| This private session is full | Ask the host for a free player slot |

The live cross-network playtest and dated public/private HUD measurements remain in the
[validation log](LOCAL_HOST_MULTIPLAYER_PLAN.md#2026-09-06--relay-tunnel-implementation-and-local-validation).
