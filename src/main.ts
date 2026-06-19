import './style.css';
import { Game } from './game/Game';
import { LoadingScreen } from './game/ui/LoadingScreen';
import {
  describeBrowserCompatibility,
  detectBrowserCompatibility,
  installBrowserCompatAttributes
} from './game/browser/browserCompat';
import { ACTIVE_NET_MODE, describeNetConfig, netModeConfig } from '../shared/netConfig';

// Netcode mode guard. The active rates (sim/input/snapshot Hz, prediction dt, interpolation delay)
// are compiled into the client from shared/netConfig.ts; the client and server MUST run the same
// mode or prediction will desync (e.g. 60Hz client prediction against a 30Hz server). If a tester
// sets VITE_NET_MODE we validate it and warn loudly when it disagrees with the compiled mode,
// rather than silently running mismatched rates (for example 72Hz prediction against a 60Hz server).
const requestedNetMode = import.meta.env.VITE_NET_MODE;
if (requestedNetMode && requestedNetMode !== ACTIVE_NET_MODE) {
  const known = netModeConfig(requestedNetMode);
  console.warn(
    `[net] VITE_NET_MODE=${requestedNetMode} ${known ? 'is known but' : 'is UNKNOWN and'} does not match the ` +
    `compiled client mode (${ACTIVE_NET_MODE}). The client runs the compiled mode; rebuild with the ` +
    `matching VITE_NET_MODE and run the server with NET_MODE=${requestedNetMode} to actually switch. ` +
    `Active config: ${describeNetConfig()}`
  );
}

const canvas = document.getElementById('gameCanvas') as HTMLCanvasElement | null;

if (!canvas) {
  throw new Error('Missing canvas element with id="gameCanvas".');
}

const compat = detectBrowserCompatibility();
installBrowserCompatAttributes(compat);
console.info(`[compat] ${describeBrowserCompatibility(compat)}`);

if (compat.missingRequired.length > 0) {
  // Tear down the loading splash so the "browser not supported" message is visible underneath.
  document.getElementById('loading-screen')?.remove();
  const lockOverlay = document.getElementById('lock-overlay');
  if (lockOverlay) {
    lockOverlay.innerHTML = `
      Browser not supported
      <span>Missing: ${compat.missingRequired.join(', ')}. Firefox and Zen should work when these APIs are enabled.</span>
    `;
  }
  throw new Error(`Missing required browser APIs: ${compat.missingRequired.join(', ')}`);
}

const loadingScreen = new LoadingScreen();
const game = new Game(canvas);
game.start();
if (game.activeScene) {
  loadingScreen.track(game.activeScene);
}

window.addEventListener('beforeunload', () => {
  game.dispose();
});
