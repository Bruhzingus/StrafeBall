import type { MatchStatus } from '../../../shared/types';
import './scoreboard.css';

export type TeamColor = 'blue' | 'red';

export type TeamScoreboardData = {
  name: string;
  color: TeamColor;
  score: number;
  players: string[];
  /** The series score is separate from the remaining lives shown by the large number. */
  roundsWon?: number;
};

export type MatchScoreboardData = {
  mode: '1v1' | '2v2';
  /** This is the half-court boundary clock, not a match-duration clock. */
  halfDropSecondsRemaining: number;
  noBoundaries: boolean;
  phase?: MatchStatus | 'practice';
  currentRound?: number;
  roundCount?: number;
  countdownSeconds?: number;
  scoreLabel?: string;
  blueTeam: TeamScoreboardData;
  redTeam: TeamScoreboardData;
};

export type ScoreboardAssetPaths = {
  blueMarker: string;
  redMarker: string;
  eraser: string;
};

const DEFAULT_ASSETS: ScoreboardAssetPaths = {
  blueMarker: '/assets/ui/scoreboard/marker-blue.png',
  redMarker: '/assets/ui/scoreboard/marker-red.png',
  eraser: '/assets/ui/scoreboard/eraser.png'
};

type TeamElements = {
  name: HTMLElement;
  score: HTMLElement;
  scoreLabel: HTMLElement;
  roster: HTMLElement;
  rounds: HTMLElement;
  lastRoster: string;
  lastScore: string | null;
};

/**
 * Compact physical whiteboard. Scores and timer share a baseline; names and series state are
 * secondary. The DOM stays mounted, so a timer tick never restarts a score-change animation or
 * recreates the decorative images. No work is done for unchanged text/rosters.
 */
export class TeamScoreboard {
  private readonly root: HTMLDivElement;
  private readonly blue: TeamElements;
  private readonly red: TeamElements;
  private readonly mode: HTMLElement;
  private readonly timer: HTMLElement;
  private readonly timerLabel: HTMLElement;
  private readonly timerValue: HTMLElement;
  private wasNoBoundaries = false;
  private boundaryNoticeUntil = 0;

  constructor(parent: HTMLElement, assets: Partial<ScoreboardAssetPaths> = {}) {
    const trayAssets = { ...DEFAULT_ASSETS, ...assets };
    this.root = document.createElement('div');
    this.root.className = 'team-scoreboard team-scoreboard--compact';
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', 'Match scoreboard');
    this.root.style.display = 'none';
    this.root.innerHTML = `
      <div class="team-scoreboard__frame">
        <span class="ts-corner ts-corner--tl" aria-hidden="true"></span>
        <span class="ts-corner ts-corner--tr" aria-hidden="true"></span>
        <span class="ts-corner ts-corner--bl" aria-hidden="true"></span>
        <span class="ts-corner ts-corner--br" aria-hidden="true"></span>
        <div class="team-scoreboard__surface">
          ${teamMarkup('blue', 'left')}
          <div class="team-scoreboard__center">
            <div class="ts-mode"></div>
            <div class="ts-timer-card">
              <div class="ts-timer-value"></div>
              <div class="ts-timer-label"></div>
            </div>
          </div>
          ${teamMarkup('red', 'right')}
        </div>
        <div class="team-scoreboard__tray" aria-hidden="true">
          <img class="ts-tray-item ts-tray-item--marker-blue" src="${escapeHtml(trayAssets.blueMarker)}" alt="" />
          <span class="ts-tray-clip"></span>
          <img class="ts-tray-item ts-tray-item--eraser" src="${escapeHtml(trayAssets.eraser)}" alt="" />
          <img class="ts-tray-item ts-tray-item--marker-red" src="${escapeHtml(trayAssets.redMarker)}" alt="" />
        </div>
      </div>`;
    for (const image of this.root.querySelectorAll('img')) {
      image.addEventListener('error', () => { image.style.display = 'none'; }, { once: true });
    }
    this.blue = this.teamElements('blue');
    this.red = this.teamElements('red');
    this.mode = this.root.querySelector('.ts-mode')!;
    this.timer = this.root.querySelector('.ts-timer-card')!;
    this.timerLabel = this.root.querySelector('.ts-timer-label')!;
    this.timerValue = this.root.querySelector('.ts-timer-value')!;
    parent.appendChild(this.root);
  }

  setVisible(visible: boolean): void {
    const display = visible ? '' : 'none';
    if (this.root.style.display !== display) this.root.style.display = display;
  }

  update(data: MatchScoreboardData): void {
    const now = performance.now();
    if (data.noBoundaries && !this.wasNoBoundaries) this.boundaryNoticeUntil = now + 2800;
    if (!data.noBoundaries) this.boundaryNoticeUntil = 0;
    this.wasNoBoundaries = data.noBoundaries;

    this.root.classList.toggle('team-scoreboard--1v1', data.mode === '1v1');
    this.root.classList.toggle('team-scoreboard--2v2', data.mode === '2v2');
    const phase = data.phase ?? 'playing';
    if (this.root.dataset.phase !== phase) this.root.dataset.phase = phase;
    const round = data.roundCount && data.roundCount > 1
      ? ` · RD ${data.currentRound ?? 1}/${data.roundCount}`
      : '';
    setText(this.mode, phase === 'practice' ? 'PRACTICE' : `${data.mode}${round}`);
    this.updateTeam(this.blue, data.blueTeam, data);
    this.updateTeam(this.red, data.redTeam, data);

    let value = formatClock(data.halfDropSecondsRemaining);
    let label = 'HALF DROPS IN';
    let word = false;
    if (phase === 'warmup') {
      value = 'WARMUP';
      label = 'PRE-MATCH';
      word = true;
    } else if (phase === 'countdown') {
      value = String(Math.max(0, Math.ceil(data.countdownSeconds ?? 0)));
      label = 'STARTS IN';
    } else if (phase === 'intermission' || phase === 'complete') {
      value = phase === 'complete' ? 'FINAL' : 'BREAK';
      label = phase === 'complete' ? 'MATCH COMPLETE' : 'ROUND COMPLETE';
      word = true;
    } else if (data.noBoundaries) {
      value = 'OPEN';
      label = 'NO BOUNDARIES';
      word = true;
    }
    const active = phase === 'playing' || phase === 'practice';
    const warning = active && !data.noBoundaries && data.halfDropSecondsRemaining <= 10;
    this.timer.classList.toggle('ts-timer-card--warning', warning);
    this.timer.classList.toggle('ts-timer-card--urgent', warning && data.halfDropSecondsRemaining <= 5);
    this.timer.classList.toggle('ts-timer-card--word', word);
    this.timer.classList.toggle('ts-timer-card--open', active && data.noBoundaries);
    this.timer.classList.toggle('ts-timer-card--notice', active && data.noBoundaries && now < this.boundaryNoticeUntil);
    setText(this.timerLabel, label);
    setText(this.timerValue, value);
    this.setVisible(true);
  }

  private teamElements(color: TeamColor): TeamElements {
    const root = this.root.querySelector<HTMLElement>(`.ts-team--${color}`)!;
    return {
      name: root.querySelector('.ts-team-name')!,
      score: root.querySelector('.ts-score')!,
      scoreLabel: root.querySelector('.ts-score-label')!,
      roster: root.querySelector('.ts-roster')!,
      rounds: root.querySelector('.ts-rounds')!,
      lastRoster: '',
      lastScore: null
    };
  }

  private updateTeam(elements: TeamElements, team: TeamScoreboardData, data: MatchScoreboardData): void {
    const score = formatScore(team.score);
    setText(elements.name, team.name);
    setText(elements.scoreLabel, data.scoreLabel ?? 'SCORE');
    if (elements.lastScore !== score) {
      setText(elements.score, score);
      if (elements.lastScore !== null && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        elements.score.animate(
          [{ transform: 'scale(1)' }, { transform: 'scale(1.16)', offset: 0.35 }, { transform: 'scale(1)' }],
          { duration: 260, easing: 'ease-out' }
        );
      }
      elements.lastScore = score;
    }
    const roster = team.players.length
      ? team.players.map((name) => `<div class="ts-player"><span class="ts-player-dot" aria-hidden="true"></span><span class="ts-player-name">${escapeHtml(name)}</span></div>`).join('')
      : '<div class="ts-player ts-player--empty"><span class="ts-player-name">Waiting for player</span></div>';
    if (roster !== elements.lastRoster) {
      elements.roster.innerHTML = roster;
      elements.lastRoster = roster;
    }
    const rounds = data.roundCount && data.roundCount > 1 && team.roundsWon !== undefined
      ? `${formatScore(team.roundsWon)} ${team.roundsWon === 1 ? 'round' : 'rounds'} won`
      : '';
    setText(elements.rounds, rounds);
    elements.rounds.hidden = !rounds;
  }

  dispose(): void {
    this.root.remove();
  }
}

function teamMarkup(color: TeamColor, side: 'left' | 'right'): string {
  return `<div class="team-scoreboard__team ts-team--${color} ts-team--${side}">
    <div class="ts-team-info">
      <div class="ts-team-header"><span class="ts-team-name"></span><span class="ts-underline" aria-hidden="true"><svg class="ts-stroke" viewBox="0 0 200 8" preserveAspectRatio="none"><path d="M3 4 Q65 2 105 4 T197 3" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" /></svg></span></div>
      <div class="ts-roster"></div>
      <div class="ts-rounds" hidden></div>
    </div>
    <div class="ts-score-box"><span class="ts-score"></span><span class="ts-score-label"></span></div>
  </div>`;
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function formatClock(secondsRemaining: number): string {
  const total = Number.isFinite(secondsRemaining) ? Math.max(0, Math.floor(secondsRemaining)) : 0;
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function formatScore(score: number): string {
  return String(Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
