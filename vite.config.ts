import { defineConfig } from 'vite';

// Mirrors the production Nginx rule: the client talks to `<page origin>/colyseus` and the proxy
// strips that prefix before handing the request (HTTP matchmaking + WebSocket upgrade) to the
// game server on :2567. Having the same rule here lets the committed prebuilt `dist/` be played
// through `vite preview` with a local server and zero rebuild — see LOCALHOST_SETUP.md.
const colyseusProxy = {
  '/colyseus': {
    target: `http://localhost:${process.env.COLYSEUS_PORT ?? '2567'}`,
    ws: true,
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/colyseus/, '')
  }
};

export default defineConfig({
  server: {
    port: 5173,
    open: true,
    proxy: colyseusProxy
  },
  preview: {
    port: 4173,
    open: true,
    proxy: colyseusProxy
  }
});
