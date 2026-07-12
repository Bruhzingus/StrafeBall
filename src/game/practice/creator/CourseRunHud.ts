/**
 * Timed-course HUD for Creator layouts (live Movement Sandbox + creator Playtest): a top-center run
 * timer with checkpoint progress while an attempt is live, and a transient result/miss/reset banner.
 * Reuses the existing Movement Course HUD styling (.course-hud / .course-timer / .course-banner in
 * style.css) so it reads as the same product language. Self-contained DOM under hud-root; local
 * only — no networking, no gameplay reads.
 */

export class CourseRunHud {
  private readonly root: HTMLDivElement;
  private readonly timer: HTMLDivElement;
  private readonly clock: HTMLDivElement;
  private readonly hint: HTMLDivElement;
  private readonly leaderboard: HTMLDivElement;
  private readonly leaderboardList: HTMLOListElement;
  private readonly banner: HTMLDivElement;
  private lastClockText = '';
  private lastHintText = '';
  private bannerTimer: number | null = null;

  constructor(parent: HTMLElement, title: string) {
    this.root = document.createElement('div');
    this.root.className = 'course-hud';

    this.timer = document.createElement('div');
    this.timer.className = 'course-timer';
    const titleEl = document.createElement('div');
    titleEl.className = 'course-timer__title';
    titleEl.textContent = title;
    this.clock = document.createElement('div');
    this.clock.className = 'course-timer__clock';
    this.clock.textContent = '0:00.00';
    this.hint = document.createElement('div');
    this.hint.className = 'course-timer__hint';
    this.timer.append(titleEl, this.clock, this.hint);

    this.leaderboard = document.createElement('div');
    this.leaderboard.className = 'course-leaderboard';
    const leaderboardTitle = document.createElement('div');
    leaderboardTitle.className = 'course-leaderboard__title';
    leaderboardTitle.textContent = 'LOCAL TOP 10';
    this.leaderboardList = document.createElement('ol');
    this.leaderboardList.className = 'course-leaderboard__list';
    this.leaderboard.append(leaderboardTitle, this.leaderboardList);

    this.banner = document.createElement('div');
    this.banner.className = 'course-banner';

    this.root.append(this.timer, this.leaderboard, this.banner);
    parent.appendChild(this.root);
  }

  /** Show/hide the whole HUD layer (hidden = no timer, no banners). */
  setVisible(visible: boolean): void {
    this.root.classList.toggle('course-hud--visible', visible);
    if (!visible) this.leaderboard.classList.remove('course-leaderboard--visible');
    if (!visible) this.clearBanner();
  }

  /** Live clock while a run is on. Cheap: only touches the DOM when the text changes. */
  tick(elapsedMs: number, collected: number, total: number): void {
    this.leaderboard.classList.remove('course-leaderboard--visible');
    const clockText = formatRunTime(elapsedMs);
    if (clockText !== this.lastClockText) {
      this.lastClockText = clockText;
      this.clock.textContent = clockText;
    }
    const hintText = total > 0 ? `CHECKPOINTS ${collected}/${total}` : 'TO THE FINISH';
    if (hintText !== this.lastHintText) {
      this.lastHintText = hintText;
      this.hint.textContent = hintText;
    }
    this.timer.style.display = '';
  }

  /** Idle (no live run): hide the clock, keep the layer for banners. */
  showIdle(bestMs: number | null): void {
    this.leaderboard.classList.add('course-leaderboard--visible');
    this.timer.style.display = '';
    const clockText = 'CROSS START TO RUN';
    if (clockText !== this.lastClockText) {
      this.lastClockText = clockText;
      this.clock.textContent = clockText;
    }
    const hintText = bestMs !== null ? `BEST ${formatRunTime(bestMs)}` : '';
    if (hintText !== this.lastHintText) {
      this.lastHintText = hintText;
      this.hint.textContent = hintText;
    }
  }

  showFinished(timeMs: number, bestMs: number | null): void {
    this.leaderboard.classList.add('course-leaderboard--visible');
    const clockText = formatRunTime(timeMs);
    if (clockText !== this.lastClockText) {
      this.lastClockText = clockText;
      this.clock.textContent = clockText;
    }
    const hintText = bestMs !== null ? `BEST ${formatRunTime(bestMs)}` : 'FINISHED';
    if (hintText !== this.lastHintText) {
      this.lastHintText = hintText;
      this.hint.textContent = hintText;
    }
  }

  renderLeaderboard(records: readonly number[], highlightPlacement: number | null = null): void {
    this.leaderboardList.replaceChildren();
    if (records.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'course-leaderboard__empty';
      empty.textContent = 'No times yet — run it!';
      this.leaderboardList.appendChild(empty);
      return;
    }
    records.forEach((timeMs, index) => {
      const row = document.createElement('li');
      row.className = 'course-leaderboard__entry';
      if (highlightPlacement === index + 1) row.classList.add('course-leaderboard__entry--new');
      const rank = document.createElement('span');
      rank.className = 'course-leaderboard__rank';
      rank.textContent = `${index + 1}.`;
      const name = document.createElement('span');
      name.className = 'course-leaderboard__name';
      name.textContent = 'You';
      const time = document.createElement('span');
      time.className = 'course-leaderboard__time';
      time.textContent = formatRunTime(timeMs);
      row.append(rank, name, time);
      this.leaderboardList.appendChild(row);
    });
  }

  showCheckpoint(collected: number, total: number, splitMs: number): void {
    this.showBanner(`CHECKPOINT ${collected}/${total} — ${formatRunTime(splitMs)}`, 'good', 1600);
  }

  showMissedCheckpoint(checkpointNumber: number): void {
    this.showBanner(`MISSED CHECKPOINT ${checkpointNumber} — finish won't count`, 'warn', 2600);
  }

  showFinish(timeMs: number, bestMs: number | null, isPersonalBest: boolean): void {
    const text = isPersonalBest
      ? `FINISH ${formatRunTime(timeMs)} — NEW BEST!`
      : `FINISH ${formatRunTime(timeMs)}${bestMs !== null ? ` (best ${formatRunTime(bestMs)})` : ''}`;
    this.showBanner(text, isPersonalBest ? 'good' : 'neutral', 3600);
  }

  showRunReset(reason: 'death' | 'reset' | 'leave'): void {
    if (reason === 'leave') return; // leaving the yard needs no banner
    this.showBanner(reason === 'death' ? 'RUN RESET — eliminated' : 'RUN RESET', 'warn', 1800);
  }

  private showBanner(text: string, tone: 'good' | 'warn' | 'neutral', ms: number): void {
    this.banner.textContent = text;
    this.banner.dataset.tone = tone;
    this.banner.classList.remove('course-banner--visible');
    // Force a reflow so re-adding the class restarts the pop animation.
    void this.banner.offsetWidth;
    this.banner.classList.add('course-banner--visible');
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.banner.classList.remove('course-banner--visible'), ms);
  }

  private clearBanner(): void {
    if (this.bannerTimer !== null) window.clearTimeout(this.bannerTimer);
    this.bannerTimer = null;
    this.banner.classList.remove('course-banner--visible');
  }

  dispose(): void {
    this.clearBanner();
    this.root.remove();
  }
}

/** m:ss.cc — matches the in-gym Movement Course clock format. */
export function formatRunTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms));
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  const centis = Math.floor((total % 1000) / 10);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
