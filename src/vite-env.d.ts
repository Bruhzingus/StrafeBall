/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  // Optional netcode mode override for local-vs-deployed tests (A_144_144_128 | A_144_144_96 | A_180_180_96 | A_90_90_60 | A_72_72_60 | A_60_60_60 | B_60_60_30 | C_30_30_30).
  // Must match the server's NET_MODE — see main.ts startup guard.
  readonly VITE_NET_MODE?: string;
}
