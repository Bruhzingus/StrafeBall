export interface PendingOnlineThrowRelease {
  ballId: string;
  releasedAtMs: number;
}

export const ONLINE_THROW_RELEASE_ACK_TIMEOUT_MS = 1000;

export function shouldClearPendingOnlineThrowRelease(
  serverHeldBallId: string | null,
  pending: PendingOnlineThrowRelease | null,
  nowMs: number,
  timeoutMs = ONLINE_THROW_RELEASE_ACK_TIMEOUT_MS
): boolean {
  if (!pending) return false;
  if (!serverHeldBallId) return true;
  if (serverHeldBallId !== pending.ballId) return true;
  return nowMs - pending.releasedAtMs > timeoutMs;
}

export function hasPendingOnlineThrowRelease(
  serverHeldBallId: string | null,
  pending: PendingOnlineThrowRelease | null,
  nowMs: number,
  timeoutMs = ONLINE_THROW_RELEASE_ACK_TIMEOUT_MS
): boolean {
  if (!pending) return false;
  if (!serverHeldBallId || serverHeldBallId !== pending.ballId) return false;
  return nowMs - pending.releasedAtMs <= timeoutMs;
}

export function onlineHandInputLooksEmpty(
  serverHeldBallId: string | null,
  pending: PendingOnlineThrowRelease | null,
  nowMs: number,
  timeoutMs = ONLINE_THROW_RELEASE_ACK_TIMEOUT_MS
): boolean {
  return !serverHeldBallId || hasPendingOnlineThrowRelease(serverHeldBallId, pending, nowMs, timeoutMs);
}
