/** Separate namespace from Colyseus room IDs. Codes are case insensitive. */
export const HOST_CODE_PATTERN = /^HOST-[A-F0-9]{16}$/;
export const RELAY_PATH = '/relay';
export const RELAY_TIMEOUT_MS = 10_000;
export const RELAY_CLOSE = { expired: 4404, disconnected: 4410, unreachable: 4411, conflict: 4409 } as const;
export const RELAY_ERRORS = {
  expired: 'Invalid or expired host code. Check the code with your host.',
  disconnected: 'Host disconnected. Ask your host to restart the session, then join again.',
  unreachable: 'Host agent not reachable. Ask your host to keep the agent running and create a match.',
  active: 'A private session is already running. Rejoin its code or close that session before creating another.',
  full: 'This private session is full. Ask your host for an available spot.'
} as const;

export function isHostCode(value: string): boolean {
  return HOST_CODE_PATTERN.test(value.trim().toUpperCase());
}

export function relayErrorMessage(error: unknown): string {
  const code = Number((error as { code?: number } | null)?.code);
  if (code === RELAY_CLOSE.expired) return RELAY_ERRORS.expired;
  if (code === RELAY_CLOSE.disconnected) return RELAY_ERRORS.disconnected;
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
  if (Object.values(RELAY_ERRORS).some((value) => value === message)) return message;
  if (/full|seat|locked/i.test(message)) return RELAY_ERRORS.full;
  return RELAY_ERRORS.unreachable;
}
