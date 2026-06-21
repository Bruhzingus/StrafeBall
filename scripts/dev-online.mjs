import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npm = isWindows ? 'npm.cmd' : 'npm';

// On Windows, recent Node versions (CVE-2024-27980 fix) refuse to spawn .cmd shims like npm.cmd
// without shell mode, throwing `spawn EINVAL`. Run through the shell on Windows to restore it.
const spawnOptions = { stdio: 'inherit', shell: isWindows };

const children = [
  spawn(npm, ['--prefix', 'server', 'run', 'dev'], {
    ...spawnOptions,
    env: { ...process.env, COLYSEUS_PORT: process.env.COLYSEUS_PORT ?? '2567' }
  }),
  spawn(npm, ['run', 'dev'], {
    ...spawnOptions,
    env: {
      ...process.env,
      VITE_SERVER_URL: process.env.VITE_SERVER_URL ?? 'ws://localhost:2567'
    }
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
