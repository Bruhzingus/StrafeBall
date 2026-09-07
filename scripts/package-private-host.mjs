import { cp, copyFile, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Build on the target OS/architecture. The resulting folder includes Node, runtime dependencies,
// the existing compiled server and client. Recipients need no npm install or separate Node download.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'releases', `strafeball-host-${process.platform}-${process.arch}-${Date.now()}`);
await mkdir(resolve(output, 'server'), { recursive: true });
// UI comes from the website. The agent also serves a localhost proxy for browsers without LNA.
await cp(resolve(root, 'server/dist'), resolve(output, 'server/dist'), { recursive: true });
await copyFile(resolve(root, 'server/package.json'), resolve(output, 'server/package.json'));
await copyFile(resolve(root, 'server/package-lock.json'), resolve(output, 'server/package-lock.json'));
await copyFile(process.execPath, resolve(output, process.platform === 'win32' ? 'node.exe' : 'node'));
await writeFile(resolve(output, 'NODE-LICENSE.txt'), await readFile(resolve(dirname(process.execPath), 'LICENSE')).catch(() =>
  fetch(`https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`).then(async (response) => {
    if (!response.ok) throw new Error('Unable to obtain the bundled Node runtime license');
    return response.text();
  })));
await new Promise((resolveRun, reject) => {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev'], {
    cwd: resolve(output, 'server'), stdio: 'inherit', shell: process.platform === 'win32', windowsHide: true
  });
  child.on('error', reject);
  child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`Runtime dependency install failed (${code})`)));
});
const uwsDir = resolve(output, 'server/node_modules/uWebSockets.js');
for (const file of await readdir(uwsDir)) {
  if (!file.endsWith('.node') || file === `uws_${process.platform}_${process.arch}_${process.versions.modules}.node`) continue;
  const target = resolve(uwsDir, file);
  if (!target.startsWith(output + sep)) throw new Error('Refusing to prune outside host package');
  await rm(target);
}
await writeFile(resolve(output, 'Start Private Host.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nset HOST_OPEN_BROWSER=1\r\nnode.exe server\\dist\\server\\src\\index.js --private-host\r\npause\r\n');
await writeFile(resolve(output, 'start-private-host.sh'), '#!/usr/bin/env sh\ncd -- "$(dirname -- "$0")" || exit 1\nexport HOST_OPEN_BROWSER=1\nexec ./node server/dist/server/src/index.js --private-host\n', { mode: 0o755 });
await writeFile(resolve(output, 'README.txt'), `Strafeball Private Host (${process.platform}/${process.arch})\n\nRun ${process.platform === 'win32' ? 'Start Private Host.cmd' : './start-private-host.sh'}.\nThe website opens automatically. Allow local network access, enter your name, and create a match.\nIf your browser cannot connect to the app, open http://localhost:2567 instead.\nShare the HOST- code shown after creating the match. Friends join at https://strafeball.xyz with no download.\nDirect connections are automatic; relay is the fallback. The ping display identifies the active path.\nKeep the host window running. Closing it disconnects guests. Restarting generates a new code.\nNo port forwarding, npm install, or separate Node download is needed. Internet access is required for the game UI.\n\nThe production broker and client must be deployed before remote joining works.\n`);
console.log(`Portable host prepared: ${output}`);
if (process.platform === 'win32') {
  // Literal paths are passed via environment variables; no shell interpolation of generated paths.
  await new Promise((resolveRun, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-Command',
      'Compress-Archive -LiteralPath $env:STRAFEBALL_PACKAGE_DIR -DestinationPath $env:STRAFEBALL_PACKAGE_ZIP'], {
      env: { ...process.env, STRAFEBALL_PACKAGE_DIR: output, STRAFEBALL_PACKAGE_ZIP: `${output}.zip` },
      stdio: 'inherit', windowsHide: true
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`Archive creation failed (${code})`)));
  });
  console.log(`One-download host archive: ${output}.zip`);
} else {
  await new Promise((resolveRun, reject) => {
    const child = spawn('tar', ['-czf', `${output}.tar.gz`, '-C', dirname(output), output.slice(dirname(output).length + 1)], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolveRun() : reject(new Error(`Archive creation failed (${code})`)));
  });
  console.log(`One-download host archive: ${output}.tar.gz`);
}
