import { COURSE_VERSION, LEADERBOARD_MAX_ENTRIES, LEADERBOARD_STORAGE_KEY } from './MovementCourseConfig';

/**
 * Browser-local Top-10 leaderboard for the Movement Course. localStorage only — no server reads,
 * writes, accounts, networking, or global rankings. All access is defensive: unavailable, disabled,
 * or malformed storage degrades to an empty board instead of throwing.
 */

export interface CourseRecord {
  /** Total run time in milliseconds (validated: finite, > 0, sane upper bound). */
  timeMs: number;
  /** Local display label only (no identity plumbing). */
  name: string;
  /** Epoch ms the record was set (best-effort; not displayed, used only as a stable tiebreak). */
  at: number;
}

interface StoredPayload {
  version: number;
  records: CourseRecord[];
}

// A completed run can't realistically be under ~5s or over ~20min; reject anything outside that as
// corrupt/impossible so the board can't be poisoned by bad data.
const MIN_VALID_MS = 5_000;
const MAX_VALID_MS = 20 * 60_000;

export function isValidCourseTime(timeMs: unknown): timeMs is number {
  return (
    typeof timeMs === 'number' &&
    Number.isFinite(timeMs) &&
    timeMs >= MIN_VALID_MS &&
    timeMs <= MAX_VALID_MS
  );
}

export class MovementCourseStorage {
  /** Read the current sorted board (fastest first), tolerant of any storage problem. */
  load(): CourseRecord[] {
    try {
      const raw = readStorage(LEADERBOARD_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as Partial<StoredPayload> | null;
      if (!parsed || parsed.version !== COURSE_VERSION || !Array.isArray(parsed.records)) return [];
      return sortAndTrim(parsed.records.filter(isValidRecord));
    } catch {
      return [];
    }
  }

  /**
   * Try to insert a finished time. Returns the (1-based) placement if it made the Top-10, else null.
   * Invalid/impossible times are ignored. Never throws on storage failure.
   */
  submit(timeMs: number, name = 'You'): number | null {
    if (!isValidCourseTime(timeMs)) return null;

    const records = this.load();
    const record: CourseRecord = { timeMs, name: safeName(name), at: Date.now() };
    const next = sortAndTrim([...records, record]);

    const placement = next.findIndex((r) => r === record);
    if (placement < 0 || placement >= LEADERBOARD_MAX_ENTRIES) {
      // Didn't qualify (board full of faster times). Still persist the trimmed list (no-op change).
      this.persist(next);
      return null;
    }

    this.persist(next);
    return placement + 1;
  }

  private persist(records: CourseRecord[]): void {
    try {
      const payload: StoredPayload = { version: COURSE_VERSION, records: sortAndTrim(records) };
      writeStorage(LEADERBOARD_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Storage full / disabled / private mode — silently ignore; the in-memory board still works.
    }
  }
}

function sortAndTrim(records: CourseRecord[]): CourseRecord[] {
  return [...records]
    .sort((a, b) => (a.timeMs - b.timeMs) || (a.at - b.at))
    .slice(0, LEADERBOARD_MAX_ENTRIES);
}

function isValidRecord(record: unknown): record is CourseRecord {
  if (!record || typeof record !== 'object') return false;
  const r = record as Partial<CourseRecord>;
  return isValidCourseTime(r.timeMs) && typeof r.name === 'string' && typeof r.at === 'number' && Number.isFinite(r.at);
}

function safeName(name: string): string {
  const trimmed = (name ?? '').toString().trim();
  if (!trimmed) return 'You';
  return trimmed.slice(0, 16);
}

function readStorage(key: string): string | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  return window.localStorage.getItem(key);
}

function writeStorage(key: string, value: string): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.setItem(key, value);
}
