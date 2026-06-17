import { TUNING } from '../config/tuning';
import { MatchRules } from '../rules/MatchRules';
import { PlayerController } from '../player/PlayerController';
import { BallManager } from '../ball/BallManager';
import { BallState } from '../ball/BallState';
import { Crosshair } from './Crosshair';
import type { ServerSnapshot } from '../../../shared/protocol';
import { SERVER_TICK_RATE, SNAPSHOT_RATE } from '../../../shared/netConfig';

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly topLeft: HTMLDivElement;
  private readonly topCenter: HTMLDivElement;
  private readonly bottomLeft: HTMLDivElement;
  private readonly bottomRight: HTMLDivElement;
  private readonly scoreEvent: HTMLDivElement;
  private readonly qteEvent: HTMLDivElement;
  private readonly countdown: HTMLDivElement;
  private lastCountdownLabel = '';
  private readonly crosshair: Crosshair;
  // Last rendered markup per panel — we only touch the DOM when the text actually changes,
  // so the HUD doesn't thrash innerHTML 60+ times a second while values are static.
  private readonly lastHtml = new Map<HTMLDivElement, string>();
  private scoreEventTimer: number | null = null;
  private qteEventTimer: number | null = null;
  private debugVisible = true;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    parent.appendChild(this.root);

    this.crosshair = new Crosshair(this.root);
    this.topLeft = this.panel('hud-top-left');
    this.topCenter = this.panel('hud-top-center');
    this.bottomLeft = this.panel('hud-bottom-left');
    this.bottomRight = this.panel('hud-bottom-right');
    this.scoreEvent = document.createElement('div');
    this.scoreEvent.className = 'score-event';
    this.root.appendChild(this.scoreEvent);

    // Backflip-QTE result callout — its own popup, placed off to the right of center so it doesn't
    // collide with the top-center hit callout.
    this.qteEvent = document.createElement('div');
    this.qteEvent.className = 'qte-event';
    this.root.appendChild(this.qteEvent);

    this.countdown = document.createElement('div');
    this.countdown.className = 'countdown';
    this.root.appendChild(this.countdown);

    // Controls panel is static — write it once.
    this.bottomRight.innerHTML = `
      <div class="hud-title">Controls</div>
      <div>Click canvas for pointer lock</div>
      <div>M1/M2 hands | E pickup | R drop | F fake</div>
      <div>Shift dash | C/Ctrl slide | Q backflip</div>
      <div>K reset/vote | J reset balls | U reset match</div>
      <div>L launch test ball | Tab debug</div>
      <div>Hold E by a fallen mat to stand it up</div>
    `;
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.topLeft.style.display = this.debugVisible ? '' : 'none';
  }

  showScoreEvent(title: string, subtitle: string, variant: 'good' | 'bad' | 'neutral' = 'neutral'): void {
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
    }, 1150);
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

  update(player: PlayerController, rules: MatchRules, ballManager: BallManager, fps: number, frameMs: number): void {
    // No countdown in offline practice.
    this.updateCountdown('playing', 0);
    const movement = player.lastMovementSnapshot;
    const hands = player.hands;
    const v = movement.velocity;
    const noBoundariesTime = Math.max(0, TUNING.match.noBoundariesSeconds - rules.boundary.elapsed);

    const dashRecharge =
      player.dash.charges >= TUNING.dash.maxCharges
        ? 'full'
        : `+1 in ${Math.max(0, TUNING.dash.rechargeSeconds - player.dash.rechargeTimer).toFixed(1)}s`;
    const staminaHtml = this.staminaBar(player.dash.charges, TUNING.dash.maxCharges, dashRecharge);

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

    // The old "★ SUPER THROW ★" timed-window indicator is gone — the backflip throw is now the
    // landing quick-time event (its own on-screen timing bar), so no HUD prompt is needed here.
    this.setHtml(this.topCenter, `
      <div class="scoreboard-title">StrafeBall</div>
      <div class="scoreboard-digits">
        <span class="scoreboard-team">YOU</span>
        <span class="scoreboard-num scoreboard-num--red">${rules.scoring.playerHits}</span>
        <span class="scoreboard-sep">—</span>
        <span class="scoreboard-num scoreboard-num--blue">${rules.boundary.opponentPenaltyHits}</span>
        <span class="scoreboard-team">OPP</span>
      </div>
      <div class="scoreboard-sub">First to ${TUNING.match.scoreLimit}</div>
      <div class="${rules.boundary.noBoundaries ? 'hud-bad' : 'hud-warn'}" style="text-align:center;margin-top:3px">
        ${rules.boundary.noBoundaries ? 'NO BOUNDARIES' : `Half-court: ${noBoundariesTime.toFixed(0)}s`}
      </div>
      ${rules.boundary.lastMessage ? `<div class="scoreboard-msg">${rules.boundary.lastMessage}</div>` : ''}
    `);

    const parryReady = hands.hasTwoBalls() && player.catching.getParryCooldown() <= 0;
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
      inputSeq: number;
      lastAckedSeq: number;
      pendingInputs: number;
      predictionErrorM: number;
      residualAfterReplayM: number;
      expectedLeadM: number;
      ackAgeMs: number | null;
      predictionActive: boolean;
    }
  ): void {
    const room = snapshot.room;
    this.updateCountdown(room.match.status, room.match.countdownSeconds);
    const local = room.players[localPlayerId];
    const opponent = Object.values(room.players).find((player) => player.id !== localPlayerId);
    const localScore = local ? room.match.scoreByTeamId[local.teamId] ?? 0 : 0;
    const opponentScore = opponent ? room.match.scoreByTeamId[opponent.teamId] ?? 0 : 0;
    const noBoundariesTime = Math.max(0, TUNING.match.noBoundariesSeconds - room.match.boundary.elapsedSeconds);
    const resetVoteText = room.resetVote.voteCount > 0
      ? `<div class="scoreboard-msg hud-warn">Reset vote: ${room.resetVote.voteCount}/${room.resetVote.requiredVotes}</div>`
      : '';

    if (this.debugVisible) {
      const residualColor = netDebug.residualAfterReplayM > 0.15 ? 'hud-bad' : netDebug.residualAfterReplayM > 0.05 ? 'hud-warn' : 'hud-good';
      this.setHtml(this.topLeft, `
        <div class="hud-title">Online <span style="font-weight:400;opacity:0.45;font-size:10px">[Tab]</span></div>
        <div>FPS <span class="hud-good">${Math.round(fps)}</span> &middot; ${frameMs.toFixed(1)} ms</div>
        <div>Room: <span class="hud-good">${escapeHtml(room.id)}</span> · Players: ${Object.keys(room.players).length}/2</div>
        <div>Ping: <span class="hud-good">${pingMs === null ? '-' : `${pingMs} ms`}</span> · Tick: ${snapshot.tick}</div>
        <div>Snap rate: <span class="hud-good">${netDebug.snapshotRateHz.toFixed(1)} Hz</span> | Ack age: ${netDebug.ackAgeMs === null ? '-' : `${netDebug.ackAgeMs} ms`}</div>
        <div>Tick rate: <span class="hud-good">${SERVER_TICK_RATE} Hz</span> &middot; Snap ${SNAPSHOT_RATE} Hz</div>
        <div>Raw lead: ${netDebug.predictionErrorM.toFixed(3)} m / ~${netDebug.expectedLeadM.toFixed(3)} m</div>
        <div>Input seq: ${netDebug.inputSeq} · Acked: ${netDebug.lastAckedSeq} · Pending: ${netDebug.pendingInputs}</div>
        <div>Residual: <span class="${residualColor}">${netDebug.residualAfterReplayM.toFixed(3)} m</span> · Active: ${netDebug.predictionActive ? '<span class="hud-good">yes</span>' : '<span class="hud-bad">no</span>'}</div>
        <div>Interp remote: <span class="hud-good">yes (exp-20)</span> · Balls: <span class="hud-good">yes (exp-30/15)</span></div>
        ${local ? `<div>Speed: <span class="hud-good">${local.movement.speed.toFixed(1)}</span> m/s · Vel: ${local.movement.velocity.x.toFixed(1)}, ${local.movement.velocity.y.toFixed(1)}, ${local.movement.velocity.z.toFixed(1)}</div>` : ''}
      `);
    }

    const winner = room.match.winnerTeamId
      ? `<div class="scoreboard-msg hud-good">Winner: ${escapeHtml(room.match.winnerTeamId)}</div>`
      : '';

    this.setHtml(this.topCenter, `
      <div class="scoreboard-title">Private Duel</div>
      <div class="scoreboard-digits">
        <span class="scoreboard-team">${escapeHtml(local?.name ?? 'YOU')}</span>
        <span class="scoreboard-num scoreboard-num--blue">${localScore}</span>
        <span class="scoreboard-sep">-</span>
        <span class="scoreboard-num scoreboard-num--red">${opponentScore}</span>
        <span class="scoreboard-team">${escapeHtml(opponent?.name ?? 'OPP')}</span>
      </div>
      <div class="scoreboard-sub">First to ${room.match.scoreLimit}</div>
      <div class="${room.match.boundary.noBoundaries ? 'hud-bad' : 'hud-warn'}" style="text-align:center;margin-top:3px">
        ${room.match.boundary.noBoundaries ? 'NO BOUNDARIES' : `Half-court: ${noBoundariesTime.toFixed(0)}s`}
      </div>
      ${resetVoteText}
      ${winner}
    `);

    const left = local?.hands.left;
    const right = local?.hands.right;
    const staminaHtml = local
      ? this.staminaBar(local.dash.charges, TUNING.dash.maxCharges, local.dash.charges >= TUNING.dash.maxCharges ? 'full' : `+1 in ${Math.max(0, TUNING.dash.rechargeSeconds - local.dash.rechargeTimerSeconds).toFixed(1)}s`)
      : this.staminaBar(0, TUNING.dash.maxCharges, '-');
    this.setHtml(this.bottomLeft, `
      <div class="hud-title">Server State</div>
      <div>M1 L [${escapeHtml(left?.heldBallId ?? '-')}]: ${escapeHtml(left?.mode ?? 'empty')}</div>
      <div>M2 R [${escapeHtml(right?.heldBallId ?? '-')}]: ${escapeHtml(right?.mode ?? 'empty')}</div>
      <div>Stamina: ${staminaHtml}</div>
      <div>Catch: face ball inside cone</div>
      <div>Balls - ${this.networkBallTally(snapshot)}</div>
      <div style="max-width:320px;white-space:normal">${this.networkBallList(snapshot)}</div>
    `);
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

  /** Writes markup to a panel only if it changed since last frame (avoids per-frame DOM churn). */
  private setHtml(el: HTMLDivElement, html: string): void {
    if (this.lastHtml.get(el) === html) return;
    this.lastHtml.set(el, html);
    el.innerHTML = html;
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
    this.root.remove();
  }

  private panel(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `hud-panel ${className}`;
    this.root.appendChild(el);
    return el;
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
    return Math.min(1, hand.chargeSeconds / TUNING.ball.maxChargeSeconds);
  }

  private staminaBar(charges: number, maxCharges: number, rechargeText: string): string {
    const full = Math.max(0, Math.min(maxCharges, Math.floor(charges)));
    const pips = Array.from({ length: maxCharges }, (_, i) => `<span class="stamina-pip ${i < full ? 'stamina-pip--full' : ''}"></span>`).join('');
    return `<span class="stamina-meter">${pips}</span> <span class="${full > 0 ? 'hud-good' : 'hud-bad'}">${full}/${maxCharges}</span> <span class="stamina-recharge">(${escapeHtml(rechargeText)})</span>`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
