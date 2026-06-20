/**
 * TeamScoreboard — a top-center "classroom whiteboard" scoreboard HUD.
 *
 * Built entirely from HTML/CSS (see `.team-scoreboard*` rules in style.css) — never a baked PNG.
 * All labels, scores, names and the timer are real text so they stay crisp and can update live.
 * The three decorative classroom assets (blue marker, red marker, eraser) are optional <img>
 * slots on the bottom tray; if the files are missing they simply hide themselves and the board
 * still looks complete.
 *
 * Data-driven: feed it a `MatchScoreboardData` and it renders 1v1 or 2v2 from the same markup,
 * driven by the per-team `players[]` array (no hardcoded second row). In 1v1 the board hides the
 * empty second row and stays compact via a mode class on the root.
 *
 * Like the rest of the HUD, it diffs its markup and only touches the DOM when something actually
 * changed, so calling `update()` every frame is cheap.
 */

export type TeamColor = 'blue' | 'red';

export type TeamScoreboardData = {
  name: string;
  color: TeamColor;
  score: number;
  /** One entry per player. 1 entry → 1v1 row, 2 entries → 2v2 rows. */
  players: string[];
};

export type MatchScoreboardData = {
  mode: '1v1' | '2v2';
  /** Seconds until the half drops; rendered as M:SS. */
  halfDropSecondsRemaining: number;
  blueTeam: TeamScoreboardData;
  redTeam: TeamScoreboardData;
};

/** Paths to the optional decorative tray assets. Swap these if you relocate the images. */
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

export class TeamScoreboard {
  private readonly root: HTMLDivElement;
  private readonly assets: ScoreboardAssetPaths;
  private lastMarkup = '';

  constructor(parent: HTMLElement, assets: Partial<ScoreboardAssetPaths> = {}) {
    this.assets = { ...DEFAULT_ASSETS, ...assets };
    this.root = document.createElement('div');
    this.root.className = 'team-scoreboard';
    this.root.style.display = 'none';
    parent.appendChild(this.root);
  }

  /** Show/hide without losing state — handy for menus, replays, etc. */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /**
   * Render the scoreboard from match data. Cheap to call every frame: markup is diffed and the
   * DOM is only rewritten when the rendered string changes.
   */
  update(data: MatchScoreboardData): void {
    const markup = this.render(data);
    if (markup === this.lastMarkup) return;
    this.lastMarkup = markup;
    this.root.innerHTML = markup;
    // Mode class drives the compact 1v1 layout (shorter roster, centered single row).
    this.root.classList.toggle('team-scoreboard--1v1', data.mode === '1v1');
    this.root.classList.toggle('team-scoreboard--2v2', data.mode === '2v2');
    if (this.root.style.display === 'none') this.root.style.display = '';
  }

  private render(data: MatchScoreboardData): string {
    const modeLabel = `${data.mode} TEAM MATCH`;
    const timer = formatClock(data.halfDropSecondsRemaining);
    return `
      <!-- ===== Outer aluminium frame: dark rounded corner brackets + a real pen tray ===== -->
      <div class="team-scoreboard__frame">
        <span class="ts-corner ts-corner--tl"></span>
        <span class="ts-corner ts-corner--tr"></span>
        <span class="ts-corner ts-corner--bl"></span>
        <span class="ts-corner ts-corner--br"></span>

        <!-- ===== Off-white board surface ===== -->
        <div class="team-scoreboard__surface">

          <!-- ===== LEFT: Blue team (header, score box, roster) ===== -->
          ${this.teamSection(data.blueTeam, 'left')}

          <!-- hand-drawn marker divider between left team and center -->
          <span class="ts-divider ts-divider--blue">${MARKER_DIVIDER}</span>

          <!-- ===== CENTER: mode title + half-drop timer ===== -->
          <div class="team-scoreboard__center">
            <div class="ts-mode">${escapeHtml(modeLabel)}</div>
            <div class="ts-timer-card">
              <!-- hand-drawn marker box around the timer -->
              <span class="ts-timer-box">${markerBox('rgba(28,32,38,0.85)')}</span>
              <div class="ts-timer-label">
                Half Drops In
                <span class="ts-underline ts-underline--ink">${MARKER_UNDERLINE}</span>
              </div>
              <div class="ts-timer-value">${escapeHtml(timer)}</div>
            </div>
          </div>

          <!-- hand-drawn marker divider between center and right team -->
          <span class="ts-divider ts-divider--red">${MARKER_DIVIDER}</span>

          <!-- ===== RIGHT: Red team (header, score box, roster) ===== -->
          ${this.teamSection(data.redTeam, 'right')}

        </div>

        <!-- ===== Pen tray ledge: center clip + decorative markers / eraser ===== -->
        ${this.tray()}
      </div>
    `;
  }

  /** One team column. `side` flips the score-box / roster order so colors hug their edge. */
  private teamSection(team: TeamScoreboardData, side: 'left' | 'right'): string {
    const accent = `ts-team--${team.color}`;
    const strokeColor = team.color === 'blue' ? 'var(--ts-blue)' : 'var(--ts-red)';
    const header = `
      <div class="ts-team-header">
        ${escapeHtml(team.name)}
        <span class="ts-underline">${MARKER_UNDERLINE}</span>
      </div>
    `;
    const scoreBox = `
      <div class="ts-score-box">
        <span class="ts-score-box__draw">${markerBox(strokeColor)}</span>
        <span class="ts-score">${formatScore(team.score)}</span>
      </div>
    `;
    const roster = `
      <div class="ts-roster">
        ${team.players
          .map(
            (player) => `
              <div class="ts-player">
                <span class="ts-player-dot"></span>
                <span class="ts-player-name">${escapeHtml(player)}</span>
                <span class="ts-rule">${MARKER_RULE}</span>
              </div>`
          )
          .join('')}
      </div>
    `;
    // Blue: score box sits inside (toward center), roster outside. Red mirrors it.
    const body = side === 'left' ? `${roster}${scoreBox}` : `${scoreBox}${roster}`;
    return `
      <div class="team-scoreboard__team ${accent} ts-team--${side}">
        ${header}
        <div class="ts-team-body">${body}</div>
      </div>
    `;
  }

  /**
   * The pen-tray ledge along the bottom: a blue marker on the left, the eraser + a center clip in
   * the middle, a red marker on the right. Each <img> hides itself (onerror) if its file is missing,
   * so the tray still reads as a tray. Purely decorative.
   */
  private tray(): string {
    return `
      <div class="team-scoreboard__tray" aria-hidden="true">
        <img class="ts-tray-item ts-tray-item--marker-blue" src="${escapeHtml(this.assets.blueMarker)}" alt="" onerror="this.style.display='none'" />
        <span class="ts-tray-clip"></span>
        <img class="ts-tray-item ts-tray-item--eraser" src="${escapeHtml(this.assets.eraser)}" alt="" onerror="this.style.display='none'" />
        <img class="ts-tray-item ts-tray-item--marker-red" src="${escapeHtml(this.assets.redMarker)}" alt="" onerror="this.style.display='none'" />
      </div>
    `;
  }

  dispose(): void {
    this.root.remove();
  }
}

/* ----------------------------------------------------------------------------------------------
 * Hand-drawn marker accents.
 * These are tiny inline SVGs with round linecaps and intentionally imperfect (wobbly, tapered)
 * paths so the underlines / boxes / dividers read as dry-erase strokes rather than crisp CSS
 * borders. They scale to their container via viewBox + preserveAspectRatio="none" where needed,
 * and inherit color from `stroke="currentColor"` so the team accent drives them.
 * They're static markup (built once per render), so there's no per-frame cost.
 * -------------------------------------------------------------------------------------------- */

// A thick underline that tapers and dips like a single marker stroke. Stretches to fill width.
const MARKER_UNDERLINE = `<svg class="ts-stroke" viewBox="0 0 300 12" preserveAspectRatio="none" aria-hidden="true"><path d="M4 7 C 60 3, 110 9, 165 6 S 250 4, 296 7" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/></svg>`;

// A faint thin ruled line under each player name (the whiteboard "row").
const MARKER_RULE = `<svg class="ts-stroke" viewBox="0 0 300 8" preserveAspectRatio="none" aria-hidden="true"><path d="M3 5 C 70 3, 150 6, 230 4 S 285 5, 297 5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`;

// A vertical marker divider, hand-drawn with a slight lean and tapered ends.
const MARKER_DIVIDER = `<svg class="ts-stroke" viewBox="0 0 12 120" preserveAspectRatio="none" aria-hidden="true"><path d="M6 4 C 4 32, 8 60, 5 88 S 7 110, 6 116" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/></svg>`;

/** A wobbly rounded-rectangle outline drawn like a marker box. `color` sets the stroke. */
function markerBox(color: string): string {
  // Two slightly offset passes give the "drawn twice / pressed harder at corners" marker feel.
  return `<svg class="ts-stroke ts-stroke--box" viewBox="0 0 120 100" preserveAspectRatio="none" aria-hidden="true">
    <path d="M14 8 C 40 5, 84 6, 108 9 C 113 30, 112 64, 109 90 C 80 94, 38 93, 12 91 C 7 64, 8 34, 14 8 Z"
      fill="none" stroke="${color}" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

/** Seconds → "M:SS". Clamps negatives to 0:00 so a finished timer never shows garbage. */
function formatClock(secondsRemaining: number): string {
  const total = Math.max(0, Math.floor(secondsRemaining));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Scores are non-negative integers; guard against NaN/floats so the big digit stays clean. */
function formatScore(score: number): string {
  const n = Number.isFinite(score) ? Math.max(0, Math.round(score)) : 0;
  return String(n);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
