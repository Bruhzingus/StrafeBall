import { TUNING } from '../config/tuning';
import { MatchRules } from '../rules/MatchRules';
import { PlayerController } from '../player/PlayerController';
import { BallManager } from '../ball/BallManager';
import { BallState } from '../ball/BallState';
import { Crosshair } from './Crosshair';

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly topLeft: HTMLDivElement;
  private readonly topCenter: HTMLDivElement;
  private readonly bottomLeft: HTMLDivElement;
  private readonly bottomRight: HTMLDivElement;
  private readonly crosshair: Crosshair;
  // Last rendered markup per panel — we only touch the DOM when the text actually changes,
  // so the HUD doesn't thrash innerHTML 60+ times a second while values are static.
  private readonly lastHtml = new Map<HTMLDivElement, string>();

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    parent.appendChild(this.root);

    this.crosshair = new Crosshair(this.root);
    this.topLeft = this.panel('hud-top-left');
    this.topCenter = this.panel('hud-top-center');
    this.bottomLeft = this.panel('hud-bottom-left');
    this.bottomRight = this.panel('hud-bottom-right');

    // Controls panel is static — write it once.
    this.bottomRight.innerHTML = `
      <div class="hud-title">Controls</div>
      <div>Click canvas for pointer lock</div>
      <div>M1/M2 hands | E pickup | R drop | F fake</div>
      <div>Shift dash | C/Ctrl slide | Q backflip</div>
      <div>K reset pos | J reset balls | U reset match</div>
      <div>L launch test ball</div>
    `;
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

    // Performance + movement debug overlay.
    this.setHtml(this.topLeft, `
      <div class="hud-title">Debug</div>
      <div>FPS <span class="hud-good">${Math.round(fps)}</span> · ${frameMs.toFixed(1)} ms</div>
      <div>Speed: <span class="hud-good">${movement.speed.toFixed(1)}</span> m/s</div>
      <div>Vel: ${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}</div>
      <div>State: ${this.movementState(player)}</div>
      <div>${movement.grounded ? 'GROUNDED' : 'AIRBORNE'}</div>
      <div>Dash: <span class="hud-good">${player.dash.charges}/${TUNING.dash.maxCharges}</span> (${dashRecharge})</div>
      <div>Backflip CD: ${player.backflip.cooldown.toFixed(1)}s</div>
    `);

    const superReady = player.backflip.isSuperThrowWindow();
    this.setHtml(this.topCenter, `
      <div class="hud-title">Score</div>
      <div>You ${rules.scoring.playerHits} — ${rules.boundary.opponentPenaltyHits} Opp / ${TUNING.match.scoreLimit} hits</div>
      <div class="${rules.boundary.noBoundaries ? 'hud-bad' : 'hud-warn'}">
        ${rules.boundary.noBoundaries ? 'NO BOUNDARIES' : `Half-court: ${noBoundariesTime.toFixed(0)}s`}
      </div>
      <div>${rules.boundary.lastMessage}</div>
      ${superReady ? '<div class="hud-bad">★ SUPER THROW WINDOW ★</div>' : ''}
    `);

    const parryReady = hands.hasTwoBalls() && player.catching.getParryCooldown() <= 0;
    this.setHtml(this.bottomLeft, `
      <div class="hud-title">Hands</div>
      <div>M1 Left: ${this.handText(hands.left)}</div>
      <div>${this.chargeBar(hands.left)}</div>
      <div>M2 Right: ${this.handText(hands.right)}</div>
      <div>${this.chargeBar(hands.right)}</div>
      <div>Catch track: ${player.catching.getDebugTrackingTime().toFixed(2)}s / ${TUNING.catch.trackingSeconds.toFixed(2)}s</div>
      <div>Auto-parry: ${parryReady ? '<span class="hud-good">ready</span>' : hands.hasTwoBalls() ? `CD ${player.catching.getParryCooldown().toFixed(2)}s` : 'need 2 balls'}</div>
      <div>Balls — ${this.ballTally(ballManager)}</div>
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

  dispose(): void {
    this.root.remove();
  }

  private panel(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = `hud-panel ${className}`;
    this.root.appendChild(el);
    return el;
  }

  private handText(hand: { ball: unknown; charging: boolean; chargeSeconds: number; catchStance: boolean; cooldown: number }): string {
    if (hand.ball) {
      return hand.charging ? `charging ${Math.round(this.charge01(hand) * 100)}%` : 'holding ball';
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
