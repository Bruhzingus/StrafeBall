/**
 * Creator Sandbox — local developer access gate.
 *
 * IMPORTANT: this is NOT secure authentication. The check runs entirely client-side, so anyone with
 * the bundle and dev tools can bypass it. It exists only as a local/dev convenience gate so the
 * editor stays out of the way during normal play and is not exposed unless a developer has
 * configured it on their own machine.
 *
 * Configuration is a SHA-256 hash of the password, provided via `VITE_CREATOR_PASSWORD_HASH` in an
 * uncommitted `.env.local`. The plaintext password is never stored in source, logs, UI, localStorage,
 * URLs, or exported files. If the hash is not configured (or Web Crypto is unavailable), the gate
 * stays locked and reports a non-sensitive "not configured" status.
 */

export type CreatorUnlockResult = 'granted' | 'denied' | 'not-configured';

/** The configured password hash, or '' when unset. Read once; never logged. */
function configuredHash(): string {
  const raw = import.meta.env.VITE_CREATOR_PASSWORD_HASH;
  if (typeof raw !== 'string') return '';
  return raw.trim().toLowerCase();
}

/** Whether the developer has configured creator access on this build. */
export function isCreatorConfigured(): boolean {
  return /^[0-9a-f]{64}$/.test(configuredHash()) && hasSubtleCrypto();
}

function hasSubtleCrypto(): boolean {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.digest === 'function';
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/** Length-independent comparison so we don't leak match progress through timing as obviously. */
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify a password attempt against the configured hash. Returns 'not-configured' when no hash is set
 * (so the UI shows the non-sensitive "Creator access is not configured." message), 'granted' on a
 * match, and 'denied' otherwise. The attempt and the configured hash are never logged.
 */
export async function verifyCreatorPassword(attempt: string): Promise<CreatorUnlockResult> {
  const expected = configuredHash();
  if (!/^[0-9a-f]{64}$/.test(expected) || !hasSubtleCrypto()) return 'not-configured';
  try {
    const actual = await sha256Hex(attempt);
    return safeEquals(actual, expected) ? 'granted' : 'denied';
  } catch {
    // Any crypto failure is treated as "not configured" — never reveal details.
    return 'not-configured';
  }
}

/**
 * Session-scoped unlock latch. Holds whether the current creator session is unlocked. It is never
 * persisted (no localStorage / cookie), so a refresh, leaving the sandbox, or going online all relock
 * the editor automatically — callers just construct a fresh latch or call `lock()`.
 */
export class CreatorAccessLatch {
  private unlocked = false;

  isUnlocked(): boolean {
    return this.unlocked;
  }

  unlock(): void {
    this.unlocked = true;
  }

  lock(): void {
    this.unlocked = false;
  }
}
