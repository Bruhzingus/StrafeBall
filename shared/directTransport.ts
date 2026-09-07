/** The broker only forwards these as opaque strings; peers own this protocol. */
export const DIRECT_CHANNEL = 'strafeball-reliable-v1';
export const DIRECT_CONNECT_MS = 5000;
export const DIRECT_MAX_FRAME = 1024 * 1024;
export const DIRECT_HEARTBEAT_MS = 2000;
export const DIRECT_DEAD_MS = 10_000;
export const DIRECT_STUN = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];
export type ConnectionPath = 'public' | 'local' | 'direct' | 'relay';
