import { spawn } from 'node:child_process';

// "Play the prebuilt game" path for people who downloaded the repo zip: runs the committed
// server build (server/dist) plus `vite preview` over the committed client build (dist/), with
// the /colyseus proxy in vite.config.ts wiring the two together. No tsc/vite build is needed —
// only the two `npm install`s. Developers iterating on source should use dev-online.mjs instead.
const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';
// Windows Node refuses to spawn .cmd shims without shell mode (see dev-online.mjs).
const spawnOptions = { stdio: 'inherit', shell: isWindows };
const port = process.env.COLYSEUS_PORT ?? '2567';

const children = [
  spawn(npm, ['--prefix', 'server', 'start'], {
    ...spawnOptions,
    env: { ...process.env, COLYSEUS_PORT: port }
  }),
  // Extra CLI flags (e.g. `-- --host` for LAN play, `-- --port 8080`) go straight to vite preview.
  spawn(npm, ['run', 'preview', '--', '--strictPort', ...process.argv.slice(2)], {
    ...spawnOptions,
    env: { ...process.env, COLYSEUS_PORT: port }
  })
];

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(isWindows ? undefined : 'SIGTERM');
  }
  process.exitCode = code;
}

for (const child of children) {
  child.on('exit', (code) => {
    if (!shuttingDown && code !== 0 && code !== null) shutdown(code);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
