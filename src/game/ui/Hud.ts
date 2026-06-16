import { TUNING } from '../config/tuning';
import { MatchRules } from '../rules/MatchRules';
import { PlayerController } from '../player/PlayerController';
import { BallManager } from '../ball/BallManager';
import { BallState } from '../ball/BallState';
import { Crosshair } from './Crosshair';
import type { ServerSnapshot } from '../../../shared/protocol';

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly topLeft: HTMLDivElement;
  private readonly topCenter: HTMLDivElement;
  private readonly bottomLeft: HTMLDivElement;
  private readonly bottomRight: HTMLDivElement;
  private readonly scoreEvent: HTMLDivElement;
  private readonly crosshair: Crosshair;
  // Last rendered markup per panel — we only touch the DOM when the text actually changes,
  // so the HUD doesn't thrash innerHTML 60+ times a second while values are static.
  private readonly lastHtml = new Map<HTMLDivElement, string>();
  private scoreEventTimer: number | null = null;
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

    // Controls panel is static — write it once.
    this.bottomRight.innerHTML = `
      <div class="hud-title">Controls</div>
      <div>Click canvas for pointer lock</div>
      <div>M1/M2 hands | E pickup | R drop | F fake</div>
      <div>Shift dash | C/Ctrl slide | Q backflip</div>
      <div>K reset/vote | J reset balls | U reset match</div>
      <div>L launch test ball | Tab debug</div>
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

  update(player: PlayerController, rules: MatchRules, ballManager: BallManager, fps: number, frameMs: number): void {
    const movement = player.lastMovementSnapshot;
    const hands = player.hands;
    const v = movement.velocity;
    const noBoundariesTime = Math.max(0, TUNING.match.noBoundariesSeconds - rules.boundary.elapsed);

    const dashRecharge =
      player.dash.charges >= TUNING.dash.maxCharges
        ? 'full'
        : `+1 in ${Math.max(0, TUNING.dash.rechargeSeconds - player.dash.rechargeTimer).toFixed(1)}s`;

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
        <div>Speed: <span class="hud-good">${movement.speed.toFixed(1)}</span> m/s</div>
        <div>Vel: ${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}</div>
        <div>State: ${this.movementState(player)}</div>
        <div>${movement.grounded ? 'GROUNDED' : 'AIRBORNE'} · fric: ${movement.frictionMode}</div>
        <div>bhop: ${bhopHtml} · wall: ${wallHtml}</div>
        <div>Dash: <span class="hud-good">${player.dash.charges}/${TUNING.dash.maxCharges}</span> (${dashRecharge})</div>
        <div>Backflip CD: ${player.backflip.cooldown.toFixed(1)}s</div>
        <div>Last: ${hands.lastAction}</div>
      `);
    }

    const superReady = player.backflip.isSuperThrowWindow();
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
      ${superReady ? '<div class="hud-bad" style="text-align:center;margin-top:2px">★ SUPER THROW ★</div>' : ''}
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
      <div>Catch track: ${player.catching.getDebugTrackingTime().toFixed(2)}s / ${TUNING.catch.trackingSeconds.toFixed(2)}s</div>
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
      predictionActive: boolean;
    }
  ): void {
    const room = snapshot.room;
    const local = room.players[localPlayerId];
    const opponent = Object.values(room.players).find((player) => player.id !== localPlayerId);
    const localScore = local ? room.match.scoreByTeamId[local.teamId] ?? 0 : 0;
    const opponentScore = opponent ? room.match.scoreByTeamId[opponent.teamId] ?? 0 : 0;
    const noBoundariesTime = Math.max(0, TUNING.match.noBoundariesSeconds - room.match.boundary.elapsedSeconds);
    const resetVoteText = room.resetVote.voteCount > 0
      ? `<div class="scoreboard-msg hud-warn">Reset vote: ${room.resetVote.voteCount}/${room.resetVote.requiredVotes}</div>`
      : '';

    if (this.debugVisible) {
      const errColor = netDebug.predictionErrorM > 0.5 ? 'hud-bad' : netDebug.predictionErrorM > 0.1 ? 'hud-warn' : 'hud-good';
      this.setHtml(this.topLeft, `
        <div class="hud-title">Online <span style="font-weight:400;opacity:0.45;font-size:10px">[Tab]</span></div>
        <div>FPS <span class="hud-good">${Math.round(fps)}</span> &middot; ${frameMs.toFixed(1)} ms</div>
        <div>Room: <span class="hud-good">${escapeHtml(room.id)}</span> · Players: ${Object.keys(room.players).length}/2</div>
        <div>Ping: <span class="hud-good">${pingMs === null ? '-' : `${pingMs} ms`}</span> · Tick: ${snapshot.tick}</div>
        <div>Snap rate: <span class="hud-good">${netDebug.snapshotRateHz.toFixed(1)} Hz</span></div>
        <div>Input seq: ${netDebug.inputSeq} · Acked: ${netDebug.lastAckedSeq} · Pending: ${netDebug.pendingInputs}</div>
        <div>Pred err: <span class="${errColor}">${netDebug.predictionErrorM.toFixed(3)} m</span> · Active: ${netDebug.predictionActive ? '<span class="hud-good">yes</span>' : '<span class="hud-bad">no</span>'}</div>
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
    const leftTrack = left ? this.bestTrackingTime(left.catchTrackingSecondsByBallId) : 0;
    const rightTrack = right ? this.bestTrackingTime(right.catchTrackingSecondsByBallId) : 0;
    const trackRequired = TUNING.catch.trackingSeconds;
    const leftTrackHtml = left?.heldBallId ? '—' : `<span class="${leftTrack >= trackRequired ? 'hud-good' : ''}">${leftTrack.toFixed(2)}s/${trackRequired.toFixed(2)}s</span>`;
    const rightTrackHtml = right?.heldBallId ? '—' : `<span class="${rightTrack >= trackRequired ? 'hud-good' : ''}">${rightTrack.toFixed(2)}s/${trackRequired.toFixed(2)}s</span>`;
    this.setHtml(this.bottomLeft, `
      <div class="hud-title">Server State</div>
      <div>M1 L [${escapeHtml(left?.heldBallId ?? '-')}]: ${escapeHtml(left?.mode ?? 'empty')} · track ${leftTrackHtml}</div>
      <div>M2 R [${escapeHtml(right?.heldBallId ?? '-')}]: ${escapeHtml(right?.mode ?? 'empty')} · track ${rightTrackHtml}</div>
      <div>Dash: <span class="hud-good">${local?.dash.charges ?? '-'}/${TUNING.dash.maxCharges}</span></div>
      <div>Balls - ${this.networkBallTally(snapshot)}</div>
      <div style="max-width:320px;white-space:normal">${this.networkBallList(snapshot)}</div>
    `);
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

  private bestTrackingTime(trackingByBallId: Record<string, number> | undefined): number {
    if (!trackingByBallId) return 0;
    let best = 0;
    for (const t of Object.values(trackingByBallId)) {
      if (t > best) best = t;
    }
    return best;
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
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
