/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  // Optional netcode mode label for local-vs-deployed tests. Must match the compiled shared
  // DEFAULT_NET_MODE and the server NET_MODE; src/main.ts warns if it does not.
  readonly VITE_NET_MODE?: string;
  // Local developer-only Creator Sandbox gate: SHA-256 hex hash of the editor password. Set in an
  // uncommitted .env.local (see .env.example). When unset, the Creator Sandbox stays locked. This is
  // a local dev convenience gate, NOT secure authentication (the check runs client-side).
  readonly VITE_CREATOR_PASSWORD_HASH?: string;
}
