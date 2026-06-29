import { TUNING } from '../config/tuning';
import { MatchRules } from '../rules/MatchRules';
import { PlayerController } from '../player/PlayerController';
import { BallManager } from '../ball/BallManager';
import { BallState } from '../ball/BallState';
import { Crosshair } from './Crosshair';
import { MusicHud } from './MusicHud';
import { TeamScoreboard, type MatchScoreboardData } from './TeamScoreboard';
import type { ServerSnapshot } from '../../../shared/protocol';
import type { HalfCourtViolationState, PlayerState, RoomState } from '../../../shared/types';
import { SERVER_TICK_RATE, SNAPSHOT_RATE } from '../../../shared/netConfig';
import type { MusicHudState } from '../audio/MusicManager';

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly topLeft: HTMLDivElement;
  private readonly topCenter: HTMLDivElement;
  private readonly bottomLeft: HTMLDivElement;
  private readonly bottomRight: HTMLDivElement;
  private readonly hearts: HTMLDivElement;
  private readonly scoreEvent: HTMLDivElement;
  private readonly clutchEvent: HTMLDivElement;
  private readonly qteEvent: HTMLDivElement;
  private readonly hitMarker: HTMLDivElement;
  private readonly interactPrompt: HTMLDivElement;
  private lastInteractPromptText: string | null = null;
  private readonly gameplayHud: HTMLDivElement;
  private readonly leftCatchCard: HTMLDivElement;
  private readonly leftCatchStatus: HTMLDivElement;
  private readonly rightCatchCard: HTMLDivElement;
  private readonly rightCatchStatus: HTMLDivElement;
  private readonly backflipCard: HTMLDivElement;
  private readonly backflipStatus: HTMLDivElement;
  private readonly leftPowerBar: HTMLDivElement;
  private readonly rightPowerBar: HTMLDivElement;
  private readonly speedValue: HTMLDivElement;
  private smoothedSpeed = 0;
  private hasSmoothedSpeed = false;
  private readonly countdown: HTMLDivElement;
  private readonly halfCourtWarning: HTMLDivElement;
  private readonly musicHud: MusicHud;
  private readonly teamScoreboard: TeamScoreboard;
  private lastCountdownLabel = '';
  private readonly crosshair: Crosshair;
  // Last rendered markup per panel — we only touch the DOM when the text actually changes,
  // so the HUD doesn't thrash innerHTML 60+ times a second while values are static.
  private readonly lastHtml = new Map<HTMLDivElement, string>();
  private scoreEventTimer: number | null = null;
  private clutchEventTimer: number | null = null;
  private clutchBuffWasActive = false;
  private qteEventTimer: number | null = null;
  private hitMarkerTimer: number | null = null;
  private debugVisible = false;
  private readonly staminaWidget: HTMLDivElement;
  private readonly staminaWidgetSegs: HTMLDivElement[] = [];
  private readonly staminaWidgetFills: HTMLDivElement[] = [];
  private readonly lastSegState: Array<'empty' | 'charging' | 'full'> = [];

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    parent.appendChild(this.root);

    this.crosshair = new Crosshair(this.root);
    // Appended directly to <body>, NOT this.root/#hud-root: #hud-root is `position: fixed`, which
    // always opens its own stacking context regardless of z-index, so anything nested inside it
    // (even with a huge z-index of its own) is capped at #hud-root's rank among body's children —
    // it can never out-rank a sibling overlay like the multiplayer lobby modal. Living directly under
    // <body> lets the debug panel's own z-index (see .hud-debug-panel) compete at the top level, so it
    // is never covered by the lobby panel, settings panel, or any other modal.
    this.topLeft = document.createElement('div');
    this.topLeft.className = 'hud-panel hud-debug-panel';
    document.body.appendChild(this.topLeft);
    this.topLeft.style.display = 'none';
    this.topCenter = this.panel('hud-top-center');
    this.bottomLeft = this.panel('hud-bottom-left');
    this.bottomLeft.style.display = 'none';
    this.bottomRight = this.panel('hud-bottom-right');
    this.hearts = this.panel('hud-hearts');
    this.hearts.style.display = 'none';
    this.scoreEvent = document.createElement('div');
    this.scoreEvent.className = 'score-event';
    this.root.appendChild(this.scoreEvent);

    this.clutchEvent = document.createElement('div');
    this.clutchEvent.className = 'clutch-event';
    this.root.appendChild(this.clutchEvent);

    // Backflip-QTE result callout — its own popup, placed off to the right of center so it doesn't
    // collide with the top-center hit callout.
    this.qteEvent = document.createElement('div');
    this.qteEvent.className = 'qte-event';
    this.root.appendChild(this.qteEvent);

    this.hitMarker = document.createElement('div');
    this.hitMarker.className = 'hit-marker';
    this.root.appendChild(this.hitMarker);

    this.interactPrompt = document.createElement('div');
    this.interactPrompt.className = 'interact-prompt';
    this.root.appendChild(this.interactPrompt);

    this.gameplayHud = document.createElement('div');
    this.gameplayHud.className = 'ability-hud';
    this.gameplayHud.innerHTML = `
      <div class="ability-power-bar ability-power-bar--left" aria-hidden="true">
        <div class="ability-power-bar__fill"></div>
      </div>
      <div class="ability-hud-card ability-hud-card--catch" data-ability="left-catch">
        <div class="ability-ring">
          <div class="ability-icon ability-icon--hand ability-icon--left" aria-label="Left hand catch">
            <svg class="ability-glyph ability-glyph--hand" viewBox="0 0 64 64" aria-hidden="true">
              <g class="ability-hand-shape">
                <path class="ability-glyph-fill" d="M18 29c0-3 4-3 4 0V17c0-4 6-4 6 0v12-16c0-4 6-4 6 0v16-14c0-4 6-4 6 0v16-9c0-4 6-4 6 0v17c0 10-7 17-17 17h-2c-8 0-14-5-17-13l-4-11c-1-4 5-6 7-2l4 7 1-4z" />
              </g>
              <text x="32" y="40">L</text>
            </svg>
          </div>
        </div>
        <div class="ability-keybind">M1</div>
        <div class="ability-label">Catch</div>
        <div class="ability-status">READY</div>
      </div>
      <div class="ability-hud-card ability-hud-card--catch" data-ability="right-catch">
        <div class="ability-ring">
          <div class="ability-icon ability-icon--hand ability-icon--right" aria-label="Right hand catch">
            <svg class="ability-glyph ability-glyph--hand" viewBox="0 0 64 64" aria-hidden="true">
              <g class="ability-hand-shape" transform="translate(64 0) scale(-1 1)">
                <path class="ability-glyph-fill" d="M18 29c0-3 4-3 4 0V17c0-4 6-4 6 0v12-16c0-4 6-4 6 0v16-14c0-4 6-4 6 0v16-9c0-4 6-4 6 0v17c0 10-7 17-17 17h-2c-8 0-14-5-17-13l-4-11c-1-4 5-6 7-2l4 7 1-4z" />
              </g>
              <text x="32" y="40">R</text>
            </svg>
          </div>
        </div>
        <div class="ability-keybind">M2</div>
        <div class="ability-label">Catch</div>
        <div class="ability-status">READY</div>
      </div>
      <div class="ability-hud-card ability-hud-card--flip" data-ability="backflip">
        <div class="ability-ring">
          <div class="ability-icon ability-icon--flip" aria-label="Backflip">
            <img class="ability-backflip-img" src="/assets/ui/backflip-icon.png" alt="" aria-hidden="true" />
          </div>
        </div>
        <div class="ability-keybind">Q</div>
        <div class="ability-label">Backflip</div>
        <div class="ability-status">READY</div>
      </div>
      <div class="ability-speed">
        <div class="ability-speed-label">Speed</div>
        <div class="ability-speed-value">0.0</div>
        <div class="ability-speed-unit">m/s</div>
      </div>
      <div class="ability-power-bar ability-power-bar--right" aria-hidden="true">
        <div class="ability-power-bar__fill"></div>
      </div>
    `;
    this.root.appendChild(this.gameplayHud);
    this.leftCatchCard = this.mustHudElement<HTMLDivElement>('[data-ability="left-catch"]');
    this.leftCatchStatus = this.mustHudElement<HTMLDivElement>('[data-ability="left-catch"] .ability-status');
    this.rightCatchCard = this.mustHudElement<HTMLDivElement>('[data-ability="right-catch"]');
    this.rightCatchStatus = this.mustHudElement<HTMLDivElement>('[data-ability="right-catch"] .ability-status');
    this.backflipCard = this.mustHudElement<HTMLDivElement>('[data-ability="backflip"]');
    this.backflipStatus = this.mustHudElement<HTMLDivElement>('[data-ability="backflip"] .ability-status');
    this.leftPowerBar = this.mustHudElement<HTMLDivElement>('.ability-power-bar--left .ability-power-bar__fill');
    this.rightPowerBar = this.mustHudElement<HTMLDivElement>('.ability-power-bar--right .ability-power-bar__fill');
    this.speedValue = this.mustHudElement<HTMLDivElement>('.ability-speed-value');

    this.countdown = document.createElement('div');
    this.countdown.className = 'countdown';
    this.root.appendChild(this.countdown);
    this.halfCourtWarning = document.createElement('div');
    this.halfCourtWarning.className = 'half-court-warning';
    this.root.appendChild(this.halfCourtWarning);
    this.musicHud = new MusicHud(this.root);
    // Top-center classroom-whiteboard scoreboard (Blue/Red teams, scores, half-drop timer).
    // Hidden until a team match drives it via updateNetwork(); the legacy hud-top-center panel
    // still carries votes/messages and is suppressed while the whiteboard is up.
    this.teamScoreboard = new TeamScoreboard(this.root);

    // Center stamina segments — one block + inner fill per charge, pre-built, no per-frame allocations.
    this.staminaWidget = document.createElement('div');
    this.staminaWidget.className = 'stamina-widget';
    for (let i = 0; i < TUNING.dash.maxCharges; i++) {
      const seg = document.createElement('div');
      seg.className = 'stamina-widget-seg';
      const fill = document.createElement('div');
      fill.className = 'stamina-widget-seg-fill';
      seg.appendChild(fill);
      this.staminaWidget.appendChild(seg);
      this.staminaWidgetSegs.push(seg);
      this.staminaWidgetFills.push(fill);
      this.lastSegState.push('empty');
    }
    this.root.appendChild(this.staminaWidget);

    // Controls panel is static — write it once.
    this.bottomRight.innerHTML = `
      <div class="hud-title">Quick Start</div>
      <div><span class="key">M1</span><span class="key">M2</span> hands / catch / throw</div>
      <div><span class="key">E</span> pickup ball / hold reset mat <span class="key">R</span> drop</div>
      <div><span class="key">Shift</span> dash <span class="key">Ctrl</span> slide / crouch <span class="key">Q</span> backflip</div>
      <div><span class="key">F</span> fake <span class="key">K</span> reset <span class="key">Tab</span> debug</div>
    `;
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.topLeft.style.display = this.debugVisible ? '' : 'none';
  }

  /** Hide/show the entire gameplay HUD (scoreboard, hands, crosshair, speed, music, help). Used by the
   * Creator Sandbox so the editor isn't cluttered by gameplay UI you aren't using. */
  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  showScoreEvent(title: string, subtitle: string, variant: 'good' | 'bad' | 'neutral' = 'neutral'): void {
    this.showTimedScoreEvent(title, subtitle, variant, 1150);
  }

  /** Bottom-middle "Hold/Press E to ..." prompt. Pass null to hide it. */
  setInteractPrompt(verb: 'Hold' | 'Press' | null, action: string): void {
    const text = verb === null ? null : `${verb}|${action}`;
    if (this.lastInteractPromptText === text) return;
    this.lastInteractPromptText = text;
    if (verb === null) {
      this.interactPrompt.classList.remove('interact-prompt--visible');
      return;
    }
    this.interactPrompt.innerHTML = `${escapeHtml(verb)} <span class="key">E</span> ${escapeHtml(action)}`;
    this.interactPrompt.classList.add('interact-prompt--visible');
  }

  showTeamJoinEvent(message: string, teamId: string): void {
    this.showTimedScoreEvent(message, '', teamId === 'red' ? 'team-red' : 'team-blue', 2000);
  }

  showClutchBuffEvent(): void {
    if (this.clutchEventTimer !== null) {
      window.clearTimeout(this.clutchEventTimer);
      this.clutchEventTimer = null;
    }

    const speedPct = Math.round((TUNING.match.lastPlayerBuffMultiplier - 1) * 100);
    const cooldownPct = Math.round((TUNING.match.lastPlayerBuffCooldownRateMultiplier - 1) * 100);

    this.clutchEvent.className = 'clutch-event';
    this.clutchEvent.innerHTML = `
      <div class="clutch-event-title">Clutch!</div>
      <div class="clutch-event-subtitle">Last one standing</div>
      <div class="clutch-event-bonuses">
        <span>+${speedPct}% Speed</span><span class="clutch-event-dot">&middot;</span><span>+${cooldownPct}% Cooldowns</span>
      </div>
    `;

    void this.clutchEvent.offsetWidth;
    this.clutchEvent.classList.add('clutch-event--visible');
    this.clutchEventTimer = window.setTimeout(() => {
      this.clutchEvent.classList.remove('clutch-event--visible');
      this.clutchEventTimer = null;
    }, 1800);
  }

  private showTimedScoreEvent(title: string, subtitle: string, variant: string, ms: number): void {
    if (this.scoreEventTimer !== null) {
      window.clearTimeout(this.scoreEventTimer);
      this.scoreEventTimer = null;
    }

    this.scoreEvent.className = `score-event score-event--${variant}`;
    this.scoreEvent.innerHTML = `
      <div class="score-event-title">${escapeHtml(title)}</div>
      <div class="score-event-subtitle">${escapeHtml(subtitle)}</div>
    `;

    // Restart the CSS keyframe when consecutive hits land within the same animation window.
    void this.scoreEvent.offsetWidth;
    this.scoreEvent.classList.add('score-event--visible');
    this.scoreEventTimer = window.setTimeout(() => {
      this.scoreEvent.classList.remove('score-event--visible');
      this.scoreEventTimer = null;
    }, ms);
  }

  /**
   * Backflip-QTE result callout: a comic pop with the tier rank. `strength` (0..1) tints it from a
   * modest blue (slow tier) up to bright gold (perfect/top tier).
   */
  showQteEvent(title: string, subtitle: string, strength: number): void {
    if (this.qteEventTimer !== null) {
      window.clearTimeout(this.qteEventTimer);
      this.qteEventTimer = null;
    }

    const variant = strength >= 0.999 ? 'perfect' : strength >= 0.5 ? 'good' : 'ok';
    this.qteEvent.className = `qte-event qte-event--${variant}`;
    this.qteEvent.innerHTML = `
      <div class="qte-event-title">${escapeHtml(title)}</div>
      <div class="qte-event-subtitle">${escapeHtml(subtitle)}</div>
    `;

    void this.qteEvent.offsetWidth; // restart the keyframe on back-to-back throws
    this.qteEvent.classList.add('qte-event--visible');
    this.qteEventTimer = window.setTimeout(() => {
      this.qteEvent.classList.remove('qte-event--visible');
      this.qteEventTimer = null;
    }, 1100);
  }

  showHitMarker(variant: 'good' | 'bad' | 'neutral' = 'good'): void {
    if (this.hitMarkerTimer !== null) {
      window.clearTimeout(this.hitMarkerTimer);
      this.hitMarkerTimer = null;
    }

    this.hitMarker.className = `hit-marker hit-marker--${variant}`;
    void this.hitMarker.offsetWidth;
    this.hitMarker.classList.add('hit-marker--visible');
    this.crosshair.pulse(variant === 'good' ? 'hit' : 'throw');
    this.hitMarkerTimer = window.setTimeout(() => {
      this.hitMarker.classList.remove('hit-marker--visible');
      this.hitMarkerTimer = null;
    }, 260);
  }

  pulseCrosshair(kind: 'hit' | 'catch' | 'parry' | 'throw'): void {
    this.crosshair.pulse(kind);
  }

  updateMusic(state: MusicHudState | null): void {
    this.musicHud.update(state);
  }

  update(player: PlayerController, rules: MatchRules, ballManager: BallManager, fps: number, frameMs: number): void {
    // No countdown in offline practice.
    this.updateCountdown('playing', 0);
    this.hearts.style.display = 'none';
    this.bottomLeft.style.display = 'none';
    this.updateHalfCourtWarning({
      deathCountdownActive: rules.boundary.illegalCountdownActive,
      countdownSeconds: rules.boundary.illegalCountdownSeconds,
      warningsIssued: rules.boundary.illegalCrossWarnings,
      illegalCrossCount: rules.boundary.illegalCrossWarnings,
      penaltiesIssued: 0,
      penaltyTickSeconds: rules.boundary.illegalCountdownSeconds,
      wasAcross: rules.boundary.illegalCountdownActive,
      eliminationIssued: false
    });
    const movement = player.lastMovementSnapshot;
    const hands = player.hands;
    const v = movement.velocity;
    const noBoundariesTime = Math.max(0, TUNING.match.noBoundariesSeconds - rules.boundary.elapsed);
    this.updateGameplayHud({
      leftCatchCooldown: hands.left.cooldown,
      rightCatchCooldown: hands.right.cooldown,
      backflipCooldown: player.backflip.cooldown,
      leftCharge: hands.left.ball && hands.left.charging ? this.charge01(hands.left) : 0,
      rightCharge: hands.right.ball && hands.right.charging ? this.charge01(hands.right) : 0,
      speed: movement.speed,
      dt: Math.max(0, frameMs / 1000)
    });

    const dashRecharge =
      player.dash.charges >= TUNING.dash.maxCharges
        ? 'full'
        : `+1 in ${Math.max(0, TUNING.dash.rechargeSeconds - player.dash.rechargeTimer).toFixed(1)}s`;
    const staminaHtml = this.staminaBar(player.dash.charges, TUNING.dash.maxCharges, dashRecharge);
    this.updateStaminaWidget(
      this.staminaWidgetValue(player.dash.charges, player.dash.rechargeTimer),
      TUNING.dash.maxCharges
    );

    // Bhop: grace window visible while it's active so you can time re-jumps.
    const bhopHtml = movement.bhopGraceTimer > 0
      ? `<span class="hud-good">GRACE ${movement.bhopGraceTimer.toFixed(2)}s</span>`
      : '<span style="opacity:0.45">—</span>';

    const wallHtml = movement.wallRunning
      ? `<span class="hud-good">${movement.wallRunTimer.toFixed(1)}s</span>`
      : '<span style="opacity:0.45">—</span>';

    // Performance + movement debug overlay.
    if (this.debugVisible) {
      this.setHtml(this.topLeft, `
        <div class="hud-title">Debug <span style="font-weight:400;opacity:0.45;font-size:10px">[Tab]</span></div>
        <div>FPS <span class="hud-good">${Math.round(fps)}</span> · ${frameMs.toFixed(1)} ms</div>
        <div>Tick rate: <span class="hud-good">${SERVER_TICK_RATE} Hz</span> &middot; Snap ${SNAPSHOT_RATE} Hz</div>
        <div>Speed: <span class="hud-good">${movement.speed.toFixed(1)}</span> m/s</div>
        <div>Vel: ${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}</div>
        <div>State: ${this.movementState(player)}</div>
        <div>${movement.grounded ? 'GROUNDED' : 'AIRBORNE'} · fric: ${movement.frictionMode}</div>
        <div>bhop: ${bhopHtml} · wall: ${wallHtml}</div>
        <div>Stamina: ${staminaHtml}</div>
        <div>Backflip CD: ${player.backflip.cooldown.toFixed(1)}s</div>
        <div>Last: ${hands.lastAction}</div>
      `);
    }

    // Practice uses the same whiteboard scoreboard as real matches (consistent UI everywhere).
    // It's a 1v1: Blue = You, Red = opponent. The old dark STRAFEBALL panel is retired here and
    // now only carries the boundary status/message line beneath the board.
    this.teamScoreboard.update({
      mode: '1v1',
      halfDropSecondsRemaining: rules.boundary.noBoundaries ? 0 : noBoundariesTime,
      noBoundaries: rules.boundary.noBoundaries,
      blueTeam: { name: 'BLUE TEAM', color: 'blue', score: rules.scoring.playerHits, players: ['You'] },
      redTeam: { name: 'RED TEAM', color: 'red', score: rules.boundary.opponentPenaltyHits, players: ['Player 2'] }
    });
    // The whiteboard is the only scoreboard now — the old dark top-center strip is retired.
    this.topCenter.style.display = 'none';

    const parryReady = hands.hasTwoBalls() && player.catching.getParryCooldown() <= 0;
    this.updateCrosshairMode({
      holding: !!hands.left.ball || !!hands.right.ball,
      charging: hands.left.charging || hands.right.charging,
      catching: hands.left.catchStance || hands.right.catchStance,
      parryReady
    });
    const leftBallId = hands.left.ball ? `#${hands.left.ball.id}` : '—';
    const rightBallId = hands.right.ball ? `#${hands.right.ball.id}` : '—';
    this.setHtml(this.bottomLeft, `
      <div class="hud-title">Hands</div>
      <div>M1 L [${leftBallId}]: ${this.handText(hands.left)}</div>
      <div>${this.chargeBar(hands.left)}</div>
      <div>M2 R [${rightBallId}]: ${this.handText(hands.right)}</div>
      <div>${this.chargeBar(hands.right)}</div>
      <div>Stamina: ${staminaHtml}</div>
      <div>Catch: face ball inside cone</div>
      <div>Auto-parry: ${parryReady ? '<span class="hud-good">ready</span>' : hands.hasTwoBalls() ? `CD ${player.catching.getParryCooldown().toFixed(2)}s` : 'need 2 balls'}</div>
      <div>Balls — ${this.ballTally(ballManager)}</div>
    `);
  }

  updateNetwork(
    snapshot: ServerSnapshot,
    localPlayerId: string,
    fps: number,
    frameMs: number,
    pingMs: number | null,
    netDebug: {
      snapshotRateHz: number;
      renderSnapshotRateHz: number;
      inputSeq: number;
      lastAckedSeq: number;
      pendingInputs: number;
      predictionErrorM: number;
      residualAfterReplayM: number;
      expectedLeadM: number;
      desyncAverageM: number;
      desyncRecentMaxM: number;
      desyncPeakM: number;
      ackAgeMs: number | null;
      pingJitterMs: number;
      lastPongAgeMs: number | null;
      missedPongs: number;
      socketBufferedAmount: number;
      socketBufferedPeak: number;
      pingSendBufferedAmount: number;
      rttEstimateMs: number;
      maxRecentPingMs: number;
      predictionActive: boolean;
    }
  ): void {
    const room = snapshot.room;
    this.updateCountdown(room.match.status, room.match.countdownSeconds);
    this.bottomLeft.style.display = 'none';
    const players = Object.values(room.players).sort(compareHudPlayers);
    const local = room.players[localPlayerId];
    this.updateHalfCourtWarning(local ? room.match.boundary.illegalCrossByPlayerId[localPlayerId] : undefined);
    const localTeamId = local?.teamId ?? room.match.teamIds[0] ?? 'blue';
    const isTeamElimination = room.match.mode === '2v2';
    const roomStatus = onlineRoomStatus(room);
    const disconnectStatus = onlineDisconnectStatus(players);
    // Half-court drop clock counts down the HOST-CONFIGURED timer, not the fixed constant.
    const noBoundariesTime = Math.max(0, room.settings.halfCourtTimerSeconds - room.match.boundary.elapsedSeconds);
    const roundLabel = room.match.roundCount > 1 ? `Round ${room.match.currentRound}/${room.match.roundCount}` : '';
    const resetVoteText = room.resetVote.voteCount > 0
      ? `<div class="scoreboard-msg hud-warn">${room.resetVote.mode === 'reset-teams' ? 'Reset teams' : 'Reset match'}: ${room.resetVote.voteCount}/${room.resetVote.requiredVotes} (${votersLabel(room, room.resetVote.votesByPlayerId)})</div>`
      : '';
    const startVoteText = room.match.mode === '2v2' && room.match.status === 'warmup'
      ? room.startVote.requiredTeamChoices > 0 && room.startVote.teamChoiceCount < room.startVote.requiredTeamChoices
        ? `<div class="scoreboard-msg hud-warn">Choose teams: ${room.startVote.teamChoiceCount}/${room.startVote.requiredTeamChoices} (${votersLabel(room, room.startVote.teamChoicesByPlayerId)})</div>`
        : room.startVote.voteCount > 0
          ? `<div class="scoreboard-msg hud-warn">Start vote: ${room.startVote.voteCount}/${room.startVote.requiredVotes} (${votersLabel(room, room.startVote.votesByPlayerId)})</div>`
          : ''
      : '';

    if (this.debugVisible) {
      const desyncColor = netDebug.residualAfterReplayM > 0.15 || netDebug.desyncRecentMaxM > 0.25
        ? 'hud-bad'
        : netDebug.residualAfterReplayM > 0.05 || netDebug.desyncRecentMaxM > 0.1
          ? 'hud-warn'
          : 'hud-good';
      this.setHtml(this.topLeft, `
        <div class="hud-title">Online <span style="font-weight:400;opacity:0.45;font-size:10px">[Tab]</span></div>
        <div>FPS <span class="hud-good">${Math.round(fps)}</span> &middot; ${frameMs.toFixed(1)} ms</div>
        <div>Room: <span class="hud-good">${escapeHtml(room.id)}</span> · Players: ${Object.keys(room.players).length}/${room.match.maxPlayers}</div>
        <div>Ping: <span class="hud-good">${pingMs === null ? '-' : `${pingMs} ms`}</span> · net RTT ~${netDebug.rttEstimateMs} ms · recent max ${netDebug.maxRecentPingMs} ms · Tick: ${snapshot.tick}</div>
        <div>Snap recv/render: <span class="hud-good">${netDebug.snapshotRateHz.toFixed(1)}</span> / ${netDebug.renderSnapshotRateHz.toFixed(1)} Hz | Ack age: ${netDebug.ackAgeMs === null ? '-' : `${netDebug.ackAgeMs} ms`}</div>
        <div>Jitter: ${netDebug.pingJitterMs.toFixed(1)} ms | Pong age: ${netDebug.lastPongAgeMs === null ? '-' : `${netDebug.lastPongAgeMs} ms`} | Missed: ${netDebug.missedPongs}</div>
        <div>WS buf: <span class="${wsBufferColor(netDebug.socketBufferedPeak)}">${netDebug.socketBufferedAmount} B</span> · peak ${netDebug.socketBufferedPeak} B · @ping ${netDebug.pingSendBufferedAmount} B</div>
        <div>Tick rate: <span class="hud-good">${SERVER_TICK_RATE} Hz</span> &middot; Snap ${SNAPSHOT_RATE} Hz</div>
        <div>Raw lead: ${netDebug.predictionErrorM.toFixed(3)} m / ~${netDebug.expectedLeadM.toFixed(3)} m</div>
        <div>Desync: <span class="${desyncColor}">${netDebug.residualAfterReplayM.toFixed(3)} m</span> avg ${netDebug.desyncAverageM.toFixed(3)} max ${netDebug.desyncRecentMaxM.toFixed(3)} peak ${netDebug.desyncPeakM.toFixed(3)}</div>
        <div>Input seq: ${netDebug.inputSeq} · Acked: ${netDebug.lastAckedSeq} · Pending: ${netDebug.pendingInputs}</div>
        <div>Prediction: ${netDebug.predictionActive ? '<span class="hud-good">active</span>' : '<span class="hud-bad">inactive</span>'} · Desync = after replay</div>
        <div>Interp remote: <span class="hud-good">yes (exp-20)</span> · Balls: <span class="hud-good">yes (exp-30/15)</span></div>
        ${local ? `<div>Speed: <span class="hud-good">${local.movement.speed.toFixed(1)}</span> m/s · Vel: ${local.movement.velocity.x.toFixed(1)}, ${local.movement.velocity.y.toFixed(1)}, ${local.movement.velocity.z.toFixed(1)}</div>` : ''}
      `);
    }

    const winner = room.match.winnerTeamId
      ? `<div class="scoreboard-msg hud-good">Winner: ${escapeHtml(room.match.winnerTeamId === localTeamId ? 'Your Team' : 'Opponents')}</div>`
      : '';
    this.updateLivesPanel(room, localPlayerId);

    const downedBanner = isTeamElimination && local?.combatState === 'eliminated' && room.match.status !== 'complete'
      ? '<div class="scoreboard-msg hud-warn">DOWNED &middot; Free Cam — WASD + mouse to fly, Space/Ctrl up/down</div>'
      : '';

    // Every online mode (2v2, 1v1 team match, private duel) uses the same whiteboard scoreboard,
    // so the UI is identical to practice. Colors key off the real teamIds ('blue'/'red') so each
    // side keeps its accent regardless of which is local.
    const blueTeamId = room.match.teamIds.includes('blue') ? 'blue' : room.match.teamIds[0];
    const redTeamId = room.match.teamIds.find((id) => id !== blueTeamId) ?? room.match.teamIds[1] ?? 'red';
    const teamPlayers = (teamId: string) =>
      players
        .filter((player) => player.teamId === teamId)
        .map((player) => `${player.name}${player.id === localPlayerId ? ' (You)' : ''}`);
    const scoreboardData: MatchScoreboardData = {
      mode: room.match.mode === '2v2' ? '2v2' : '1v1',
      halfDropSecondsRemaining: room.match.boundary.noBoundaries ? 0 : noBoundariesTime,
      noBoundaries: room.match.boundary.noBoundaries,
      blueTeam: {
        name: 'BLUE TEAM',
        color: 'blue',
        score: teamLivesForHud(room, blueTeamId),
        players: teamPlayers(blueTeamId)
      },
      redTeam: {
        name: 'RED TEAM',
        color: 'red',
        score: teamLivesForHud(room, redTeamId),
        players: teamPlayers(redTeamId)
      }
    };
    this.teamScoreboard.update(scoreboardData);
    // The whiteboard is the scoreboard. The old top-center match strip duplicated team/timer info and
    // collided with the board, so this anchor now only carries temporary status messages below it.
    this.topCenter.classList.add('hud-top-center--below-scoreboard');

    if (isTeamElimination) {
      const teamStatus = [
        roomStatus ? `<div class="scoreboard-msg hud-warn">${escapeHtml(roomStatus)}</div>` : '',
        disconnectStatus ? `<div class="scoreboard-msg hud-bad">${escapeHtml(disconnectStatus)}</div>` : '',
        downedBanner,
        startVoteText,
        resetVoteText,
        winner
      ].join('');
      if (teamStatus.trim()) {
        this.topCenter.style.display = '';
        this.setHtml(this.topCenter, teamStatus);
      } else {
        this.topCenter.style.display = 'none';
      }
    } else {
      // Private duel: scores/timer live on the whiteboard now. Only surface the strip when there's
      // actual status (room state, disconnects, vote, winner); otherwise hide it completely.
      const roundStatus = roundLabel && (room.match.status === 'playing' || room.match.status === 'countdown')
        ? `<div class="scoreboard-msg hud-good">${roundLabel}</div>`
        : '';
      const duelStatus = [
        roundStatus,
        roomStatus ? `<div class="scoreboard-msg hud-warn">${escapeHtml(roomStatus)}</div>` : '',
        disconnectStatus ? `<div class="scoreboard-msg hud-bad">${escapeHtml(disconnectStatus)}</div>` : '',
        resetVoteText,
        winner
      ].join('');
      if (duelStatus.trim()) {
        this.topCenter.style.display = '';
        this.setHtml(this.topCenter, duelStatus);
      } else {
        this.topCenter.style.display = 'none';
      }
    }

    const left = local?.hands.left;
    const right = local?.hands.right;
    this.updateGameplayHud({
      leftCatchCooldown: left?.cooldownSeconds ?? 0,
      rightCatchCooldown: right?.cooldownSeconds ?? 0,
      backflipCooldown: local?.movementInternal.backflipCooldown ?? 0,
      leftCharge: left?.heldBallId && left.mode === 'charging' ? this.chargeSeconds01(left.chargeSeconds) : 0,
      rightCharge: right?.heldBallId && right.mode === 'charging' ? this.chargeSeconds01(right.chargeSeconds) : 0,
      speed: local?.movement.speed ?? 0,
      dt: Math.max(0, frameMs / 1000)
    });
    this.updateStaminaWidget(
      local ? this.staminaWidgetValue(local.dash.charges, local.dash.rechargeTimerSeconds) : 0,
      TUNING.dash.maxCharges
    );
    this.updateCrosshairMode({
      holding: !!left?.heldBallId || !!right?.heldBallId,
      charging: left?.mode === 'charging' || right?.mode === 'charging',
      catching: left?.mode === 'catching' || right?.mode === 'catching',
      parryReady: !!left?.heldBallId && !!right?.heldBallId
    });
  }

  /**
   * Drive the big centered pre-round countdown from the authoritative match state. Shows the
   * remaining whole second (5..1), a brief "GO!" the moment it flips to playing, and nothing
   * otherwise. The number re-pops each time the displayed digit changes (CSS keyframe restart).
   */
  private updateCountdown(status: string, countdownSeconds: number): void {
    let label = '';
    if (status === 'countdown') {
      label = String(Math.max(1, Math.ceil(countdownSeconds)));
    } else if (this.lastCountdownLabel !== '' && this.lastCountdownLabel !== 'GO!' && status === 'playing') {
      // Just transitioned out of the countdown → flash GO! once.
      label = 'GO!';
    }

    if (label === this.lastCountdownLabel) return;

    if (label === '') {
      this.countdown.classList.remove('countdown--visible');
      this.lastCountdownLabel = '';
      return;
    }

    this.countdown.textContent = label;
    this.countdown.classList.toggle('countdown--go', label === 'GO!');
    // Restart the pop animation for the new digit.
    this.countdown.classList.remove('countdown--visible');
    void this.countdown.offsetWidth;
    this.countdown.classList.add('countdown--visible');
    this.lastCountdownLabel = label;

    if (label === 'GO!') {
      // Auto-hide GO! shortly after.
      window.setTimeout(() => {
        if (this.lastCountdownLabel === 'GO!') {
          this.countdown.classList.remove('countdown--visible');
          this.lastCountdownLabel = '';
        }
      }, 700);
    }
  }

  private updateHalfCourtWarning(violation: HalfCourtViolationState | undefined): void {
    const active = !!violation?.wasAcross && !violation.eliminationIssued;
    if (!active) {
      this.halfCourtWarning.classList.remove('half-court-warning--visible', 'half-court-warning--urgent');
      this.halfCourtWarning.innerHTML = '';
      return;
    }

    const danger = !!violation?.deathCountdownActive && violation.countdownSeconds > 0;
    const seconds = Math.max(1, Math.ceil(violation.countdownSeconds));
    this.halfCourtWarning.classList.toggle('half-court-warning--urgent', danger);
    this.halfCourtWarning.innerHTML = `
      <div class="half-court-warning__stamp">${danger ? 'DANGER' : 'WARNING'}</div>
      <div class="half-court-warning__title">GET BACK TO YOUR SIDE</div>
      <div class="half-court-warning__body">${danger ? 'Taking 1 hit/life per second' : 'Wait until half court drops'}</div>
      <div class="half-court-warning__timer">${danger ? `NEXT HIT IN <strong>${seconds}</strong>` : 'WARNING USED'}</div>
    `;
    this.halfCourtWarning.classList.add('half-court-warning--visible');
  }

  /** Writes markup to a panel only if it changed since last frame (avoids per-frame DOM churn). */
  private setHtml(el: HTMLDivElement, html: string): void {
    if (this.lastHtml.get(el) === html) return;
    this.lastHtml.set(el, html);
    el.innerHTML = html;
  }

  private updateGameplayHud(state: {
    leftCatchCooldown: number;
    rightCatchCooldown: number;
    backflipCooldown: number;
    leftCharge: number;
    rightCharge: number;
    speed: number;
    dt: number;
  }): void {
    this.updateAbilityCard(this.leftCatchCard, this.leftCatchStatus, state.leftCatchCooldown, TUNING.catch.cooldownSeconds);
    this.updateAbilityCard(this.rightCatchCard, this.rightCatchStatus, state.rightCatchCooldown, TUNING.catch.cooldownSeconds);
    this.updateAbilityCard(this.backflipCard, this.backflipStatus, state.backflipCooldown, TUNING.backflip.cooldownSeconds);
    this.updatePowerBar(this.leftPowerBar, state.leftCharge);
    this.updatePowerBar(this.rightPowerBar, state.rightCharge);

    const speed = Number.isFinite(state.speed) ? Math.max(0, state.speed) : 0;
    if (!this.hasSmoothedSpeed) {
      this.smoothedSpeed = speed;
      this.hasSmoothedSpeed = true;
    } else {
      const alpha = 1 - Math.exp(-Math.max(0, state.dt) / 0.12);
      this.smoothedSpeed += (speed - this.smoothedSpeed) * alpha;
    }
    this.speedValue.textContent = this.smoothedSpeed.toFixed(1);
  }

  private updateAbilityCard(card: HTMLDivElement, status: HTMLDivElement, cooldown: number, maxCooldown: number): void {
    const remaining = Math.max(0, Number.isFinite(cooldown) ? cooldown : 0);
    const max = Math.max(0.001, maxCooldown);
    const progress = remaining <= 0 ? 1 : Math.max(0, Math.min(1, 1 - remaining / max));
    card.style.setProperty('--ability-progress', `${(progress * 360).toFixed(1)}deg`);
    card.classList.toggle('ability-hud-card--ready', remaining <= 0);
    card.classList.toggle('ability-hud-card--cooldown', remaining > 0);
    status.textContent = remaining <= 0 ? 'READY' : `${remaining.toFixed(1)}s`;
  }

  private updatePowerBar(fill: HTMLDivElement, charge01: number): void {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(charge01) ? charge01 : 0));
    fill.style.transform = `scaleY(${clamped.toFixed(3)})`;
    fill.parentElement?.classList.toggle('ability-power-bar--active', clamped > 0.001);
    fill.parentElement?.classList.toggle('ability-power-bar--full', clamped >= 0.995);
  }

  private movementState(player: PlayerController): string {
    const m = player.lastMovementSnapshot;
    const parts: string[] = [];
    parts.push(m.grounded ? 'ground' : 'air');
    if (m.crouching) parts.push('crouch');
    if (m.sliding) parts.push('slide');
    if (m.wallRunning) parts.push('wallrun');
    if (m.dashingThisFrame) parts.push('dash');
    if (player.backflip.active) parts.push('backflip');
    return parts.join(' · ');
  }

  private ballTally(ballManager: BallManager): string {
    let live = 0;
    let held = 0;
    let loose = 0;
    let dead = 0;
    for (const ball of ballManager.balls) {
      if (ball.state === BallState.Live) live += 1;
      else if (ball.state === BallState.Held) held += 1;
      else if (ball.state === BallState.Loose) loose += 1;
      else dead += 1;
    }
    return `live ${live} · held ${held} · loose ${loose} · dead ${dead}`;
  }

  private networkBallTally(snapshot: ServerSnapshot): string {
    const counts = { live: 0, held: 0, loose: 0, dead: 0, deflected: 0 };
    for (const ball of Object.values(snapshot.room.balls)) {
      counts[ball.phase] += 1;
    }
    return `live ${counts.live} &middot; held ${counts.held} &middot; loose ${counts.loose} &middot; dead ${counts.dead} &middot; defl ${counts.deflected}`;
  }

  private networkBallList(snapshot: ServerSnapshot): string {
    return Object.values(snapshot.room.balls)
      .map((ball) => {
        const spd = Math.sqrt(ball.velocity.x ** 2 + ball.velocity.y ** 2 + ball.velocity.z ** 2);
        const owner = ball.heldByPlayerId ? `(${escapeHtml(ball.heldByPlayerId.slice(0, 4))}/${escapeHtml(ball.heldHand ?? '-')})` : '';
        return `${escapeHtml(ball.id)}:${escapeHtml(ball.phase)}${owner}${ball.isSuper ? '★' : ''} ${spd.toFixed(0)}m/s`;
      })
      .join(' · ');
  }

  dispose(): void {
    if (this.scoreEventTimer !== null) {
      window.clearTimeout(this.scoreEventTimer);
      this.scoreEventTimer = null;
    }
    if (this.clutchEventTimer !== null) {
      window.clearTimeout(this.clutchEventTimer);
      this.clutchEventTimer = null;
    }
    if (this.qteEventTimer !== null) {
      window.clearTimeout(this.qteEventTimer);
      this.qteEventTimer = null;
    }
    if (this.hitMarkerTimer !== null) {
      window.clearTimeout(this.hitMarkerTimer);
      this.hitMarkerTimer = null;
    }
    this.musicHud.dispose();
    this.teamScoreboard.dispose();
    this.root.remove();
  }

  private updateCrosshairMode(state: { holding: boolean; charging: boolean; catching: boolean; parryReady: boolean }): void {
    if (state.charging) this.crosshair.setMode('charge');
    else if (state.catching) this.crosshair.setMode('catch');
    else if (state.parryReady) this.crosshair.setMode('parry');
    else if (state.holding) this.crosshair.setMode('hold');
    else this.crosshair.setMode('idle');
  }

  private updateLivesPanel(room: RoomState, localPlayerId: string): void {
    const local = room.players[localPlayerId];
    // Both formats are lives-based now, so the hearts panel shows in 1v1 too (the last-player buff
    // line below only ever fires in 2v2). Hide it only outside a live round / when there's no local.
    const liveRound = room.match.status === 'countdown' || room.match.status === 'playing';
    if (!local || !liveRound) {
      this.hearts.style.display = 'none';
      this.clutchBuffWasActive = false;
      return;
    }

    this.hearts.style.display = '';
    const buffSeconds = Math.max(0, Math.ceil(((local.lastPlayerBuffUntilMs ?? 0) - Date.now()) / 1000));
    const buffActive = buffSeconds > 0;
    const buffLine = buffActive
      ? `<div class="hearts-warning">Last player alive, finish the mission <span>${buffSeconds}s</span></div>`
      : '';

    if (buffActive && !this.clutchBuffWasActive) this.showClutchBuffEvent();
    this.clutchBuffWasActive = buffActive;

    this.setHtml(this.hearts, `
      <div class="hearts-row hearts-row--local">
        ${formatHearts(local.lives, room.settings.livesPerPlayer)}
      </div>
      ${buffLine}
    `);
  }

  private panel(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `hud-panel ${className}`;
    this.root.appendChild(el);
    return el;
  }

  private mustHudElement<T extends Element>(selector: string): T {
    const element = this.gameplayHud.querySelector<T>(selector);
    if (!element) throw new Error(`Missing gameplay HUD element: ${selector}`);
    return element;
  }

  private handText(hand: { ball: { id: number } | null; charging: boolean; chargeSeconds: number; catchStance: boolean; cooldown: number }): string {
    if (hand.ball) {
      return hand.charging ? `charging ${Math.round(this.charge01(hand) * 100)}%` : 'holding';
    }
    if (hand.catchStance) return 'catch stance';
    if (hand.cooldown > 0) return `catch CD ${hand.cooldown.toFixed(2)}s`;
    return 'empty';
  }

  // Throw charge meter: a simple text bar so it stays readable and allocation-light.
  private chargeBar(hand: { ball: unknown; charging: boolean; chargeSeconds: number }): string {
    if (!hand.ball || !hand.charging) return '&nbsp;';
    const filled = Math.round(this.charge01(hand) * 10);
    const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
    return `<span class="hud-good">[${bar}]</span>`;
  }

  private charge01(hand: { chargeSeconds: number }): number {
    return this.chargeSeconds01(hand.chargeSeconds);
  }

  private chargeSeconds01(chargeSeconds: number): number {
    return Math.max(0, Math.min(1, chargeSeconds / TUNING.ball.maxChargeSeconds));
  }

  private updateStaminaWidget(charges: number, maxCharges: number): void {
    const clamped = Math.min(maxCharges, Math.max(0, charges));
    const full = Math.floor(clamped);
    const partial = clamped - full;
    this.staminaWidget.classList.toggle('stamina-widget--ready', full > 0);
    this.staminaWidget.classList.toggle('stamina-widget--empty', full <= 0);

    for (let i = 0; i < this.staminaWidgetSegs.length; i++) {
      const seg = this.staminaWidgetSegs[i];
      const fill = this.staminaWidgetFills[i];
      const prev = this.lastSegState[i];

      if (i < full) {
        if (prev !== 'full') {
          this.lastSegState[i] = 'full';
          seg.classList.remove('stamina-widget-seg--charging');
          seg.classList.add('stamina-widget-seg--full');
          fill.style.width = '100%';
          if (prev === 'charging') {
            // Brief glow burst when a charge completes.
            seg.classList.add('stamina-widget-seg--glow');
            window.setTimeout(() => seg.classList.remove('stamina-widget-seg--glow'), 420);
          }
        }
      } else if (i === full && partial > 0.004) {
        if (prev !== 'charging') {
          this.lastSegState[i] = 'charging';
          seg.classList.remove('stamina-widget-seg--full', 'stamina-widget-seg--glow');
          seg.classList.add('stamina-widget-seg--charging');
        }
        // Update fill every tick during recharge — just a style.width write, very cheap.
        fill.style.width = `${(partial * 100).toFixed(1)}%`;
      } else {
        if (prev !== 'empty') {
          this.lastSegState[i] = 'empty';
          seg.classList.remove('stamina-widget-seg--full', 'stamina-widget-seg--charging', 'stamina-widget-seg--glow');
          fill.style.width = '0%';
        }
      }
    }
  }

  private staminaWidgetValue(charges: number, rechargeTimerSeconds: number): number {
    const clampedCharges = Math.min(TUNING.dash.maxCharges, Math.max(0, Math.floor(charges)));
    if (clampedCharges >= TUNING.dash.maxCharges) return TUNING.dash.maxCharges;
    const recharge01 = Math.max(0, Math.min(1, rechargeTimerSeconds / TUNING.dash.rechargeSeconds));
    return clampedCharges + recharge01;
  }

  private staminaBar(charges: number, maxCharges: number, rechargeText: string): string {
    const full = Math.max(0, Math.min(maxCharges, Math.floor(charges)));
    const pips = Array.from({ length: maxCharges }, (_, i) => `<span class="stamina-pip ${i < full ? 'stamina-pip--full' : ''}"></span>`).join('');
    return `<span class="stamina-meter">${pips}</span> <span class="${full > 0 ? 'hud-good' : 'hud-bad'}">${full}/${maxCharges}</span> <span class="stamina-recharge">(${escapeHtml(rechargeText)})</span>`;
  }
}

function formatHearts(lives: number, maxLives: number): string {
  const filled = Math.max(0, Math.min(maxLives, Math.ceil(lives)));
  let html = '<span class="hearts">';
  for (let i = 0; i < maxLives; i += 1) {
    html += `<span class="heart ${i < filled ? 'heart--full' : 'heart--empty'}" aria-hidden="true"></span>`;
  }
  return `${html}</span>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/** Color the WS uplink-buffer line by its rolling peak. A healthy socket flushes to ~0 between
 *  sends; a sustained backlog is the signature of an uplink that can't keep up with the send rate,
 *  which is what inflates the measured ping. 4 KB warn / 16 KB bad are well below the server's
 *  64 KB backpressure threshold so the client flags trouble before the server starts skipping. */
function wsBufferColor(peakBytes: number): string {
  if (peakBytes >= 16 * 1024) return 'hud-bad';
  if (peakBytes >= 4 * 1024) return 'hud-warn';
  return 'hud-good';
}

function compareHudPlayers(a: PlayerState, b: PlayerState): number {
  if (a.teamId !== b.teamId) return a.teamId.localeCompare(b.teamId);
  if (a.teamSlotIndex !== b.teamSlotIndex) return a.teamSlotIndex - b.teamSlotIndex;
  return a.id.localeCompare(b.id);
}

function teamLivesForHud(room: RoomState, teamId: string): number {
  return Object.values(room.players).reduce((total, player) => {
    return player.teamId === teamId ? total + Math.max(0, player.lives) : total;
  }, 0);
}

function onlineRoomStatus(room: RoomState): string {
  const playerCount = Object.keys(room.players).length;
  const missingSeats = Math.max(0, room.match.maxPlayers - playerCount);
  if (room.match.status === 'warmup' && room.match.mode === '2v2' && room.startVote.requiredTeamChoices > 0 && room.startVote.teamChoiceCount < room.startVote.requiredTeamChoices) {
    return `Choose teams ${room.startVote.teamChoiceCount}/${room.startVote.requiredTeamChoices}.`;
  }
  if (room.match.status === 'warmup' && room.match.mode === '2v2' && room.startVote.voteCount > 0) {
    return `Start vote ${room.startVote.voteCount}/${room.startVote.requiredVotes}.`;
  }
  if (room.match.status === 'countdown') {
    return `Teams ready. Round starts in ${Math.max(1, Math.ceil(room.match.countdownSeconds))}s.`;
  }
  if (missingSeats > 0) {
    return `Waiting for ${missingSeats} more player${missingSeats === 1 ? '' : 's'}.`;
  }
  if (room.match.status === 'complete') {
    return 'Match complete.';
  }
  return '';
}

/** Names of the players who cast a vote, for showing who picked which option in the vote counter. */
function votersLabel(room: RoomState, votesByPlayerId: Record<string, true>): string {
  const names = Object.keys(votesByPlayerId)
    .map((playerId) => room.players[playerId]?.name)
    .filter((name): name is string => !!name);
  return names.length > 0 ? escapeHtml(names.join(', ')) : '';
}

function onlineDisconnectStatus(players: PlayerState[]): string {
  const disconnected = players.filter((player) => player.connected === false);
  if (disconnected.length === 0) return '';
  return disconnected
    .map((player) => `${player.name} ${Math.max(0, Math.ceil(((player.reconnectDeadlineAtMs ?? 0) - Date.now()) / 1000))}s`)
    .join(' / ');
}
