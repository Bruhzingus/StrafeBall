# StrafeBall — Localhost Setup Guide

This guide walks you from "I just downloaded a zip" to "StrafeBall is running on my own computer
and my friends on my Wi-Fi can join". No prior experience with Node or web development is assumed.

The zip you downloaded is a snapshot of the game's source repository at the moment you clicked
the button, so it is always the same version as the live site at https://strafeball.xyz. It
already contains a **prebuilt** copy of the game (`dist/` and `server/dist/`), which is why the
quick path below never has to compile anything.

---

## Table of contents

1. [What you get](#1-what-you-get)
2. [Install Node.js (one time)](#2-install-nodejs-one-time)
3. [Unzip and open a terminal in the folder](#3-unzip-and-open-a-terminal-in-the-folder)
4. [Quick path — play the prebuilt game](#4-quick-path--play-the-prebuilt-game)
5. [Developer path — edit the code and see changes live](#5-developer-path--edit-the-code-and-see-changes-live)
6. [Play with friends on the same network (LAN)](#6-play-with-friends-on-the-same-network-lan)
7. [Play with friends over the internet](#7-play-with-friends-over-the-internet)
8. [Ports, environment variables and options](#8-ports-environment-variables-and-options)
9. [Updating to a newer version](#9-updating-to-a-newer-version)
10. [Troubleshooting](#10-troubleshooting)
11. [Folder map](#11-folder-map)

---

## 1. What you get

StrafeBall is two programs that talk to each other:

| Part | What it is | Where it lives in the zip |
|---|---|---|
| **Client** | The game itself — a web page running Babylon.js in your browser. | `src/` (source), `dist/` (prebuilt) |
| **Server** | A Node.js process (Colyseus) that runs the authoritative match simulation for online play. | `server/src/` (source), `server/dist/` (prebuilt) |

Offline modes (practice lobby, bots, Movement Course, Creator Sandbox) only need the client.
Online 1v1 / 2v2 duels need the server running too. On the live site both are hosted for you;
locally, you run both on your machine and your browser connects to `localhost`.

Rough sizes: the zip is about **530 MB**, almost all of it game audio and 3D assets. Installing
dependencies adds roughly another 400 MB of `node_modules`. Nothing is installed system-wide
except Node.js itself.

---

## 2. Install Node.js (one time)

StrafeBall needs **Node.js 20 or newer** (22 or 24 LTS is ideal). Node ships with `npm`, the
package manager we use for everything below.

**Windows / macOS**

1. Go to https://nodejs.org and download the **LTS** installer.
2. Run it with the default options. On Windows, leave "Add to PATH" checked.
3. Close and reopen any terminal windows you already had open.

**Linux (Debian/Ubuntu)**

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Or use your distro's package manager / `nvm` — any Node ≥ 20 works.

**Check it worked** — open a terminal and run:

```sh
node --version    # should print v20.x.x or higher
npm --version     # should print 10.x.x or higher
```

If either command says "not found", the installer didn't update your PATH: reopen the terminal
(or log out and back in) and try again.

---

## 3. Unzip and open a terminal in the folder

1. Extract the zip somewhere without spaces or special characters in the path if you can, e.g.
   `C:\Games\StrafeBall` or `~/games/strafeball`. (Spaces work, they're just easier to typo.)
   The extracted folder will be named something like `StrafeBall-main`.
2. Open a terminal **inside that folder**:
   - **Windows**: open the folder in File Explorer, click the address bar, type `cmd` and press
     Enter. Or right-click inside the folder → "Open in Terminal".
   - **macOS**: right-click the folder in Finder → Services → "New Terminal at Folder", or drag
     the folder onto the Terminal icon.
   - **Linux**: right-click → "Open in Terminal", or `cd` to it.
3. Confirm you're in the right place: `dir` (Windows) or `ls` (macOS/Linux) should show
   `package.json`, `dist`, `server`, `src` and this `LOCALHOST_SETUP.md`.

Every command from here on is run from this folder unless it says otherwise.

---

## 4. Quick path — play the prebuilt game

This runs exactly the build that is on the live site. Two installs, one command, done.

### 4.1 Install dependencies (first time only, or after updating)

```sh
npm install
npm --prefix server install --omit=dev
```

The first command fetches the client tooling (Vite, Babylon.js). The second fetches the server's
runtime libraries (Colyseus, WebRTC relay support). Expect a few minutes on the first run. Warnings
about "deprecated" packages are normal; only red `ERR!` lines matter.

### 4.2 Start the game

```sh
npm run play:local
```

This launches both halves:

- the **server** on `ws://localhost:2567`
- the **client** on `http://localhost:4173`, which should open in your default browser
  automatically. If it doesn't, open that address yourself.

Leave the terminal window open — closing it stops the game. Press `Ctrl+C` in the terminal to stop.

### 4.3 Play

- **Practice / Movement Course / Creator** work immediately.
- **Online duel**: enter a name in the multiplayer panel (top-left) and click **Host** or
  **Join**. Because you're the only server, you'll see only rooms that you or people on your
  network created — see [section 6](#6-play-with-friends-on-the-same-network-lan).
- The ping display will say **Server** and show sub-millisecond latency; that's your own machine.

Use **Chrome or Edge** for the best experience — pointer lock, WebGL2 and audio all behave best
there. Firefox works; Safari is untested.

---

## 5. Developer path — edit the code and see changes live

If you want to modify the game, run it from source with hot reload instead of the prebuilt bundle.

### 5.1 Install (includes dev tooling)

```sh
npm install
npm --prefix server install
```

(Same as before but without `--omit=dev` for the server, so TypeScript and `tsx` are available.)

### 5.2 Run client + server from source

```sh
npm run dev:online
```

- Server starts from `server/src` via `tsx` on port 2567.
- Client starts via Vite on **http://localhost:5173** with `VITE_SERVER_URL=ws://localhost:2567`.
- Editing anything under `src/` or `shared/` refreshes the browser instantly. Editing
  `server/src/` needs a server restart (`Ctrl+C`, run again).

Prefer to run them in separate terminals? That's what `dev:online` does under the hood:

```sh
# terminal 1
cd server
npm run dev

# terminal 2 (repo root)
npm run dev
```

Client-only, no server (offline modes still work, online panel shows "offline"):

```sh
npm run dev
```

### 5.3 Useful commands

| Command | What it does |
|---|---|
| `npm test` | Runs the shared-simulation / client unit tests (Vitest). |
| `npm --prefix server test` | Runs the server unit tests. |
| `npm run typecheck:all` | Type-checks client and server without emitting. |
| `npm run build` | Compiles the client into `dist/`. |
| `npm --prefix server run build` | Compiles the server into `server/dist/`. |
| `npm run verify:live` | Typecheck + build everything — what the maintainers run before a release. |
| `npm run preview` | Serves whatever is in `dist/` (what `play:local` uses). |

After `npm run build` + `npm --prefix server run build`, `npm run play:local` will serve **your**
modified build.

The `shared/` folder is imported by both client and server; it holds the movement and ball
simulation so prediction on the client matches the server tick for tick. If you change a physics
constant there, rebuild both sides.

---

## 6. Play with friends on the same network (LAN)

Your local instance can host a match for anyone who can reach your computer's IP address.

1. Find your LAN IP:
   - Windows: `ipconfig` → look for "IPv4 Address" under your active adapter (e.g. `192.168.1.42`).
   - macOS/Linux: `ifconfig` or `ip addr` (e.g. `192.168.1.42`).
2. Start the game so it listens on all interfaces instead of only `localhost`:

   ```sh
   npm run play:local -- --host
   ```

   (For the dev path: `npm run dev -- --host` in the client terminal; the server already listens
   on all interfaces.)
3. Friends open `http://<your-ip>:4173` (or `:5173` on the dev path) in their browser. The
   `/colyseus` proxy on that same page forwards them to your server, so nothing else to configure.
4. You **Host** a room, they **Join** with the room code, everyone readies up.

If they can't connect, your OS firewall is almost certainly blocking inbound connections on the
client port (4173/5173) — allow "Node.js" through Windows Defender Firewall when prompted, or add
an inbound rule for that port. The server port (2567) does not need to be opened on the LAN path
because all traffic goes through the page's proxy.

---

## 7. Play with friends over the internet

You have two options.

**Option A — use the official relay (recommended, no port forwarding).**
The live site supports "private host sessions": you run the server on your PC, your friends visit
https://strafeball.xyz and enter a `HOST-…` code, and the game auto-negotiates a direct WebRTC
connection or falls back to the official relay. From this folder:

```sh
npm --prefix server run host:private
```

Then open https://strafeball.xyz/?host=1 (or `http://localhost:2567` as a fallback) and click
**Host**. Full details, including the standalone one-click host app, are in
[docs/PRIVATE_HOST_SESSIONS.md](docs/PRIVATE_HOST_SESSIONS.md).

**Option B — self-host end to end.**
Put the machine behind a domain, run the server under a process manager, and serve `dist/` from
a web server that proxies `/colyseus` (HTTP **and** WebSocket upgrades, prefix stripped) to port
2567. This is exactly how the live site is deployed — see [DEPLOY.md](DEPLOY.md) and
[scripts/update-strafeball.sh](scripts/update-strafeball.sh) for the reference setup. You'll
need to handle HTTPS yourself (the browser will only unlock pointer lock and audio reliably on
`https://` or `localhost`).

---

## 8. Ports, environment variables and options

| Setting | Default | How to change |
|---|---|---|
| Server port | `2567` | `COLYSEUS_PORT=3000 npm run play:local` (or `PORT=`). The client proxy follows it automatically. |
| Prebuilt client port | `4173` | `npm run play:local -- --port 8080` |
| Dev client port | `5173` | `npm run dev -- --port 8080` |
| Listen on LAN | localhost only | append `-- --host` to `play:local` / `dev` |
| Client → server URL (dev only) | `ws://localhost:2567` | `VITE_SERVER_URL=ws://otherhost:2567 npm run dev` (build-time; the prebuilt `dist/` always uses same-origin `/colyseus`) |
| Network tick preset | `A_128_128_96` | `NET_MODE=<mode>` for the server + `VITE_NET_MODE=<mode>` for a client build; see `shared/netConfig.ts` |

On Windows `cmd`, set env vars with `set COLYSEUS_PORT=3000` on its own line first; in
PowerShell use `$env:COLYSEUS_PORT = "3000"`.

---

## 9. Updating to a newer version

The download button in the in-game Settings panel always gives you the current `main` branch, so
"updating" is just downloading again:

1. Stop the running game (`Ctrl+C`).
2. Download the zip again from **Settings → Download game** (or
   https://github.com/Bruhzingus/StrafeBall/archive/refs/heads/main.zip).
3. Extract it over the old folder (or into a fresh one).
4. Re-run the install step from [4.1](#41-install-dependencies-first-time-only-or-after-updating)
   — it's fast when nothing changed.
5. `npm run play:local`.

If you'd rather update in place, the same folder is a git repository on GitHub, so you can
`git clone https://github.com/Bruhzingus/StrafeBall.git` once and then `git pull` for each update.
What changed between versions is listed in [CHANGELOG.md](CHANGELOG.md).

---

## 10. Troubleshooting

**`'node' is not recognized` / `command not found: npm`**
Node isn't installed or isn't on your PATH. Redo [section 2](#2-install-nodejs-one-time) and open a
*new* terminal.

**`npm ERR! EACCES` / permission denied (macOS/Linux)**
Don't use `sudo npm install`. Fix your npm prefix or install Node via `nvm` instead.

**`Error: listen EADDRINUSE: address already in use :::2567` (or 4173/5173)**
Something else — usually a previous StrafeBall run you didn't `Ctrl+C` — is on that port. Close
it, or pick a different port ([section 8](#8-ports-environment-variables-and-options)).

**Page loads but the multiplayer panel says "offline" or "error"**
The server isn't running or isn't on the port the proxy expects. Check the terminal for the line
`Strafeball Colyseus server listening on ws://localhost:2567`. If you changed `COLYSEUS_PORT`,
make sure it was set in the *same* terminal that ran `play:local`.

**`spawn EINVAL` on Windows**
Your Node version is very new and refuses to spawn `npm.cmd` without a shell. The launch scripts
already handle this; if you're running commands manually, use `npm.cmd` or run from PowerShell.

**Black screen / "WebGL not supported"**
Update your GPU drivers and make sure hardware acceleration is enabled in the browser
(`chrome://settings/system`). Try the **Graphics → Performance** preset in the Settings panel.

**Mouse won't lock / keeps escaping**
Pointer lock only works on `https://` or `localhost`. If you're connecting via a LAN IP
(`http://192.168.x.x`), Chrome treats it as insecure. Workarounds: add the origin to
`chrome://flags/#unsafely-treat-insecure-origin-as-secure`, or put the game behind HTTPS.

**No music / no sound until I click**
Browsers block audio until the first user gesture. Click anywhere in the page.

**`npm install` is extremely slow or hangs on `uWebSockets.js`**
The server's WebSocket library is a prebuilt binary downloaded from GitHub. Corporate proxies and
some VPNs block it; retry off the VPN or set `HTTPS_PROXY`.

**Something else**
Open an issue at https://github.com/Bruhzingus/StrafeBall/issues with your OS, Node version
(`node --version`), the exact command and the full terminal output.

---

## 11. Folder map

```
StrafeBall-main/
├── LOCALHOST_SETUP.md      ← you are here
├── README.md               ← feature overview and controls
├── CHANGELOG.md            ← what changed per release
├── DEPLOY.md               ← how the live site is deployed (self-hosting reference)
├── docs/                   ← design docs, private host sessions, creator sandbox, netcode
├── package.json            ← client scripts (dev, build, play:local, test)
├── vite.config.ts          ← dev/preview server config incl. the /colyseus proxy
├── index.html              ← the single page the game boots from
├── src/                    ← client source (Babylon.js scene, HUD, input, netcode client)
├── shared/                 ← simulation code compiled into BOTH client and server
├── public/                 ← raw audio + 3D assets (copied into dist/ on build)
├── dist/                   ← PREBUILT client — what play:local serves
├── server/
│   ├── package.json        ← server scripts (dev, start, build, host:private)
│   ├── src/                ← server source (Colyseus rooms, simulation loop, relay broker)
│   └── dist/               ← PREBUILT server — what play:local runs
├── scripts/                ← launchers (dev-online, play-local), packagers, deploy script
├── tests/                  ← client/shared unit tests (Vitest)
└── spikes/                 ← experimental prototypes, not part of the game
```
