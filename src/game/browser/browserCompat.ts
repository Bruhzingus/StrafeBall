export type BrowserFamily = 'zen' | 'firefox' | 'chromium' | 'safari' | 'unknown';

export interface BrowserCompatibility {
  browser: BrowserFamily;
  webgl: boolean;
  pointerLock: boolean;
  fullscreen: boolean;
  webAudio: boolean;
  clipboardWrite: boolean;
  missingRequired: string[];
  missingOptional: string[];
}

export function detectBrowserFamily(nav: Navigator = navigator): BrowserFamily {
  const ua = nav.userAgent.toLowerCase();
  const brands = readBrands(nav).join(' ').toLowerCase();
  const combined = `${ua} ${brands}`;

  if (combined.includes('zen')) return 'zen';
  if (combined.includes('firefox')) return 'firefox';
  if (combined.includes('edg/') || combined.includes('chrome') || combined.includes('chromium')) return 'chromium';
  if (combined.includes('safari')) return 'safari';
  return 'unknown';
}

export function detectBrowserCompatibility(doc: Document = document, nav: Navigator = navigator): BrowserCompatibility {
  const browser = detectBrowserFamily(nav);
  const canvas = doc.createElement('canvas');
  const webgl = !!(canvas.getContext('webgl2') || canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
  const pointerLock = typeof canvas.requestPointerLock === 'function';
  const fullscreen = typeof doc.documentElement.requestFullscreen === 'function';
  const webAudio = typeof window.AudioContext === 'function' || typeof readWebkitAudioContext(window) === 'function';
  const clipboardWrite = !!nav.clipboard?.writeText || typeof doc.execCommand === 'function';

  const missingRequired = [
    !webgl ? 'WebGL' : '',
    !pointerLock ? 'Pointer Lock' : ''
  ].filter(Boolean);

  const missingOptional = [
    !fullscreen ? 'Fullscreen' : '',
    !webAudio ? 'Web Audio' : '',
    !clipboardWrite ? 'Clipboard write' : ''
  ].filter(Boolean);

  return {
    browser,
    webgl,
    pointerLock,
    fullscreen,
    webAudio,
    clipboardWrite,
    missingRequired,
    missingOptional
  };
}

export function installBrowserCompatAttributes(compat: BrowserCompatibility, doc: Document = document): void {
  doc.documentElement.dataset.browserFamily = compat.browser;
  doc.body.dataset.browserFamily = compat.browser;
  doc.documentElement.dataset.pointerLock = compat.pointerLock ? '1' : '0';
  doc.documentElement.dataset.fullscreen = compat.fullscreen ? '1' : '0';
}

export function describeBrowserCompatibility(compat: BrowserCompatibility): string {
  return (
    `browser=${compat.browser} webgl=${Number(compat.webgl)} pointerLock=${Number(compat.pointerLock)}` +
    ` fullscreen=${Number(compat.fullscreen)} webAudio=${Number(compat.webAudio)} clipboard=${Number(compat.clipboardWrite)}` +
    ` missingRequired=${compat.missingRequired.length > 0 ? compat.missingRequired.join('|') : 'none'}` +
    ` missingOptional=${compat.missingOptional.length > 0 ? compat.missingOptional.join('|') : 'none'}`
  );
}

function readBrands(nav: Navigator): string[] {
  const uaData = nav as Navigator & {
    userAgentData?: {
      brands?: Array<{ brand: string }>;
    };
  };
  return uaData.userAgentData?.brands?.map((brand) => brand.brand) ?? [];
}

function readWebkitAudioContext(win: Window): typeof AudioContext | undefined {
  return (win as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}
