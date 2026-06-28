import type { CourseRecord } from './MovementCourseStorage';

/**
 * Local-only Movement Course HUD: run timer, the three checkpoint splits, the finish result, the
 * local Top-10 board, and transient prompts. Self-contained DOM (its own elements under hud-root)
 * — it never imports multiplayer/connection state and is fully hidden/removed when the course is
 * inactive. Styling reuses the school "paper/ink" panel language from style.css.
 */

export type CourseHudState = 'hidden' | 'exploring' | 'running' | 'finished';

const SPLIT_LABELS = ['CP 1', 'CP 2', 'CP 3'];

export class MovementCourseHud {
  private readonly root: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly splitValues: HTMLDivElement[] = [];
  private readonly hint: HTMLDivElement;
  private readonly leaderboard: HTMLDivElement;
  private readonly leaderboardList: HTMLOListElement;
  private readonly banner: HTMLDivElement;

  private state: CourseHudState = 'hidden';
  private lastClockText = '';
  private readonly lastSplitText: string[] = ['', '', ''];
  private lastHintText = '';
  private bannerTimer = 0;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'course-hud';

    const timer = document.createElement('div');
    timer.className = 'course-timer';

    const title = document.createElement('div');
    title.className = 'course-timer__title';
    title.textContent = 'MOVEMENT COURSE';

    this.clock = document.createElement('div');
    this.clock.className = 'course-timer__clock';
    this.clock.textContent = '0:00.00';

    const splits = document.createElement('div');
    splits.className = 'course-splits';
    for (const label of SPLIT_LABELS) {
      const split = document.createElement('div');
      split.className = 'course-split';
      const labelEl = document.createElement('div');
      labelEl.className = 'course-split__label';
      labelEl.textContent = label;
      const valueEl = document.createElement('div');
      valueEl.className = 'course-split__value';
      valueEl.textContent = '—';
      split.appendChild(labelEl);
      split.appendChild(valueEl);
      splits.appendChild(split);
      this.splitValues.push(valueEl);
    }

    this.hint = document.createElement('div');
    this.hint.className = 'course-timer__hint';
    this.hint.textContent = '';

    timer.appendChild(title);
    timer.appendChild(this.clock);
    timer.appendChild(splits);
    timer.appendChild(this.hint);

    this.leaderboard = document.createElement('div');
    this.leaderboard.className = 'course-leaderboard';
    const lbTitle = document.createElement('div');
    lbTitle.className = 'course-leaderboard__title';
    lbTitle.textContent = 'LOCAL TOP 10';
    this.leaderboardList = document.createElement('ol');
    this.leaderboardList.className = 'course-leaderboard__list';
    this.leaderboard.appendChild(lbTitle);
    this.leaderboard.appendChild(this.leaderboardList);

    this.banner = document.createElement('div');
    this.banner.className = 'course-banner';

    this.root.appendChild(timer);
    this.root.appendChild(this.leaderboard);
    this.root.appendChild(this.banner);
    parent.appendChild(this.root);

    this.setState('hidden');
  }

  setState(state: CourseHudState): void {
    this.state = state;
    this.root.dataset.state = state;
    const visible = state !== 'hidden';
    this.root.classList.toggle('course-hud--visible', visible);
    // The leaderboard shows while exploring + finished, hides during an active run for focus.
    this.leaderboard.classList.toggle('course-leaderboard--visible', state === 'exploring' || state === 'finished');
  }

  /** Advance the transient banner fade. */
  update(dt: number): void {
    if (this.bannerTimer > 0) {
      this.bannerTimer = Math.max(0, this.bannerTimer - dt);
      if (this.bannerTimer === 0) this.banner.classList.remove('course-banner--visible');
    }
  }

  setClock(ms: number): void {
    const text = formatTime(ms);
    if (text === this.lastClockText) return;
    this.lastClockText = text;
    this.clock.textContent = text;
  }

  /** Set one split (raw cumulative time from start), or clear it with null. */
  setSplit(index: number, ms: number | null): void {
    if (index < 0 || index >= this.splitValues.length) return;
    const text = ms === null ? '—' : formatTime(ms);
    if (text === this.lastSplitText[index]) return;
    this.lastSplitText[index] = text;
    this.splitValues[index].textContent = text;
  }

  clearSplits(): void {
    for (let i = 0; i < this.splitValues.length; i += 1) this.setSplit(i, null);
  }

  setHint(text: string): void {
    if (text === this.lastHintText) return;
    this.lastHintText = text;
    this.hint.textContent = text;
  }

  showBanner(text: string, tone: 'neutral' | 'good' | 'warn', seconds = 2.2): void {
    this.banner.textContent = text;
    this.banner.dataset.tone = tone;
    this.banner.classList.remove('course-banner--visible');
    // Force reflow so the pop animation restarts each time.
    void this.banner.offsetWidth;
    this.banner.classList.add('course-banner--visible');
    this.bannerTimer = seconds;
  }

  renderLeaderboard(records: CourseRecord[], highlightAt = -1): void {
    this.leaderboardList.replaceChildren();
    if (records.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'course-leaderboard__empty';
      empty.textContent = 'No times yet — run it!';
      this.leaderboardList.appendChild(empty);
      return;
    }
    records.forEach((record, index) => {
      const li = document.createElement('li');
      li.className = 'course-leaderboard__entry';
      if (index === highlightAt) li.classList.add('course-leaderboard__entry--new');
      const rank = document.createElement('span');
      rank.className = 'course-leaderboard__rank';
      rank.textContent = `${index + 1}.`;
      const name = document.createElement('span');
      name.className = 'course-leaderboard__name';
      name.textContent = record.name;
      const time = document.createElement('span');
      time.className = 'course-leaderboard__time';
      time.textContent = formatTime(record.timeMs);
      li.appendChild(rank);
      li.appendChild(name);
      li.appendChild(time);
      this.leaderboardList.appendChild(li);
    });
  }

  dispose(): void {
    this.root.remove();
  }
}

/** m:ss.cs (centiseconds) — e.g. 28.45s → "0:28.45". */
export function formatTime(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalCentis = Math.floor(clamped / 10);
  const minutes = Math.floor(totalCentis / 6000);
  const seconds = Math.floor((totalCentis % 6000) / 100);
  const centis = totalCentis % 100;
  return `${minutes}:${seconds.toString().padStart(2, '0')}.${centis.toString().padStart(2, '0')}`;
}
