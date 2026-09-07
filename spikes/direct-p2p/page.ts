import { Client } from '@colyseus/sdk';
import { BrowserSpike, installSpikeJoin } from './client';
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const spike = new BrowserSpike(!new URLSearchParams(location.search).has('no-stun'));
Object.assign(window, { p2pSpike: spike }); // Playwright/console diagnostics, confined to this page.
let loaded = false;
async function game(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await import('../../src/main');
  document.querySelector<HTMLDetailsElement>('#spike-panel')!.open = false;
}
function button(id: string, action: () => Promise<void>): void {
  document.querySelector<HTMLButtonElement>(id)!.onclick = () => {
    status.textContent = 'Working…';
    void action().catch((error) => { status.textContent = error.message; });
  };
}
button('#host', async () => {
  const local = new Client('ws://127.0.0.1:2577');
  const create = Client.prototype.create;
  const join = Client.prototype.joinById;
  Client.prototype.create = ((...args: Parameters<Client['create']>) => create.apply(local, args)) as Client['create'];
  Client.prototype.joinById = ((...args: Parameters<Client['joinById']>) => join.apply(local, args)) as Client['joinById'];
  await game();
  status.textContent = 'Host uses loopback WebSocket. Create a normal 1v1 and share its room ID.';
});
button('#offer', async () => {
  document.querySelector<HTMLTextAreaElement>('#offer-json')!.value = JSON.stringify(await spike.offer());
  status.textContent = 'Send the offer JSON privately to your host. SDP contains connection addresses.';
});
button('#answer', async () => {
  await spike.answer(JSON.parse(document.querySelector<HTMLTextAreaElement>('#answer-json')!.value.replace(/^ANSWER\s+/, '')));
  status.textContent = 'Direct channel open. Load the guest game and join the host’s room ID.';
});
button('#guest', async () => {
  installSpikeJoin(spike);
  await game();
  status.textContent = 'Enter the normal room ID in Join. All gameplay uses the direct reliable DataChannel.';
});
button('#report', async () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(await spike.report(), null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `p2p-spike-${Date.now()}.json`; link.click();
  URL.revokeObjectURL(url);
  status.textContent = 'Saved direct samples and ICE stats. Add the same-pair relay measurements to the decision log.';
});
window.addEventListener('beforeunload', () => spike.close());
