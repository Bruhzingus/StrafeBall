/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  // Optional netcode mode label for local-vs-deployed tests. Must match the compiled shared
  // DEFAULT_NET_MODE and the server NET_MODE; src/main.ts warns if it does not.
  readonly VITE_NET_MODE?: string;
}
