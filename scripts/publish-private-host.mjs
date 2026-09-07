// Uses the repository's existing GitHub credential helper. Never logs or writes its token.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
const repo = 'Bruhzingus/StrafeBall';
const tag = 'private-host-latest';
async function git(args, input = '') {
  return new Promise((done, reject) => {
    const child = spawn('git', args, { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, stdio: 'pipe' });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    child.on('error', reject);
    child.on('exit', code => code === 0 ? done(output.trim()) : reject(new Error('Git credentials unavailable; authenticate GitHub before publishing.')));
    child.stdin.end(input);
  });
}
const credential = await git(['credential', 'fill'], 'protocol=https\nhost=github.com\n\n');
const token = credential.split('\n').find(line => line.startsWith('password='))?.slice(9);
if (!token) throw new Error('No GitHub publishing credential available.');
async function request(path, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    ...options, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json', ...options.headers }
  });
  if (response.status === 404 && options.allowMissing) return null;
  if (!response.ok) throw new Error(`GitHub request failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
if (process.argv.includes('--check')) {
  const metadata = await request('');
  console.log(JSON.stringify({ repository: repo, canPublish: metadata.permissions?.push === true }));
} else {
  const path = resolve(process.argv[2] ?? '');
  if (!path.endsWith('.zip')) throw new Error('Pass a tested Windows host ZIP.');
  const size = (await stat(path)).size;
  const commit = await git(['rev-parse', 'HEAD']);
  const body = `Windows x64 private host. Built from ${commit}.\n\nDownload and unzip the archive, then run Start Private Host.cmd. The website opens automatically. Allow local network access, enter your name and create a match. Share the HOST code with your friend, who joins on https://strafeball.xyz with no download. Keep the host window open.\n\nDirect WebRTC is attempted automatically with relay fallback. Use http://localhost:2567 if your browser cannot connect to the local host app from the website. Internet access is required. Cross-network latency improvement remains to be measured with your own player pair.`;
  let release = await request(`/releases/tags/${tag}`, { allowMissing: true });
  if (release) throw new Error('Stable host release already exists; review a versioned replacement instead of overwriting it.');
  release = await request('/releases', { method: 'POST', body: JSON.stringify({ tag_name: tag, target_commitish: commit,
    name: 'Strafeball Private Host — Windows', body, draft: true }) });
  const upload = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=strafeball-host-win32-x64.zip`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip', 'Content-Length': String(size), 'X-GitHub-Api-Version': '2022-11-28' },
    body: createReadStream(path), duplex: 'half'
  });
  if (!upload.ok) throw new Error(`ZIP upload failed (${upload.status}); draft release retained for retry.`);
  const asset = await upload.json();
  await request(`/releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false }) });
  console.log(JSON.stringify({ release: release.html_url, download: asset.browser_download_url, bytes: size, commit }));
}
