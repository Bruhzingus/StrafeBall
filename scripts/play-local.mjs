import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Private hosting registers a HOST code with the website. Plain server + preview only creates
// LAN room IDs, so keep that path explicit. Both modes use committed builds without compiling.
const args = process.argv.slice(2);
const lan = args.includes('--lan') || args.some(arg => arg === '--host' || arg.startsWith('--host='));
if (args.includes('--help') || args.includes('-h')) {
  console.log('npm run play:local                 Host on this computer; friends join at https://strafeball.xyz with a HOST code.');
  console.log('npm run play:lan -- --host         LAN only; friends open http://<your-ip>:4173.');
  console.log('npm run play:lan -- --port 8080    Change the LAN preview port.');
  console.log('Set COLYSEUS_PORT to change the local game server port.');
  process.exit(0);
}
if (!lan && args.length) {
  console.error('Preview options require LAN mode: npm run play:lan -- ' + args.join(' '));
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
// Match the server's PORT precedence so the LAN proxy always targets the actual listener.
const port = process.env.PORT ?? process.env.COLYSEUS_PORT ?? '2567';
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
  console.error('PORT / COLYSEUS_PORT must be a port number between 1 and 65535.');
  process.exit(1);
}
const options = {
  cwd: root, stdio: 'inherit', windowsHide: true,
  env: { ...process.env, PORT: port, COLYSEUS_PORT: port,
    HOST_OPEN_BROWSER: process.env.HOST_OPEN_BROWSER ?? 'local' }
};
console.log(lan
  ? '[play:local] LAN mode. Room codes work only on this local server. For website join codes, use npm run play:local.'
  : `[play:local] Private host mode. Open http://localhost:${port}, create a match, then share its HOST code with friends at https://strafeball.xyz.`);

// Spawn Node directly: npm/cmd wrapper processes can leave the server running after Ctrl+C.
const children = [spawn(process.execPath, ['server/dist/server/src/index.js', ...(lan ? [] : ['--private-host'])], options)];
if (lan) {
  children.push(spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--strictPort',
    ...args.filter(arg => arg !== '--lan')], options));
}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  }
  process.exitCode = code;
}

for (const child of children) {
  child.on('error', (error) => {
    console.error('Unable to launch StrafeBall:', error.message);
    shutdown(1);
  });
  child.on('exit', (code) => {
    if (!shuttingDown) shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
