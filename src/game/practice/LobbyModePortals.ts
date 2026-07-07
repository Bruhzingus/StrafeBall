import { Color3, Scene, Vector3 } from '@babylonjs/core';
import { PortalArch, type PortalPalette } from './PortalArch';

export type LobbyMode = '1v1' | '2v2';
export type LobbyPortalAction =
  | { type: 'matchmaking'; mode: LobbyMode }
  | { type: 'movementCourse' };

type LobbyPortalId = 'privateMatch' | 'movementCourse';

interface ModeZoneDef {
  id: LobbyPortalId;
  action: LobbyPortalAction;
  eyebrow: string;
  title: string;
  subtitle: string;
  position: Vector3;
  palette: PortalPalette;
}

interface ModeZone extends ModeZoneDef {
  portal: PortalArch;
}

const HOLD_SECONDS = 0.65;
const ACTIVATE_RADIUS = 2.7;

const PRIVATE_MATCH_ENERGY: PortalPalette = {
  edge: new Color3(0.3, 0.55, 1.0),
  status: new Color3(0.18, 0.4, 0.8),
  // Kept deliberately unsaturated-but-NOT-equal-channel: R well below G/B so the ACES tonemap + scene
  // exposure can't clip this toward white the way a near-equal-RGB bright value would. surfaceBack is
  // the deeper "blue" base layer; surfaceFront is the lighter "light blue" highlight layer on top.
  surfaceBack: new Color3(0.1, 0.32, 0.82),
  surfaceFront: new Color3(0.22, 0.5, 0.95)
};

const MOVEMENT_COURSE_ENERGY: PortalPalette = {
  edge: new Color3(0.1, 0.7, 1.0),
  status: new Color3(0.08, 0.52, 0.95),
  surfaceBack: new Color3(0.04, 0.26, 0.82),
  surfaceFront: new Color3(0.16, 0.62, 1.0)
};

// Practice-lobby portals stay client-only. Private Match opens the existing room menu; Movement Course
// is a local training destination and never touches the online room/server path.
const ZONES: ModeZoneDef[] = [
  {
    id: 'privateMatch',
    action: { type: 'matchmaking', mode: '1v1' },
    eyebrow: 'Match Lobby',
    title: 'PRIVATE MATCH',
    subtitle: 'Create or join with a code',
    position: new Vector3(0, 0, -11.15),
    palette: PRIVATE_MATCH_ENERGY
  },
  {
    id: 'movementCourse',
    action: { type: 'movementCourse' },
    eyebrow: 'Training',
    title: 'MOVEMENT COURSE',
    subtitle: 'Enter the local movement course',
    position: new Vector3(3.35, 0, -11.15),
    palette: MOVEMENT_COURSE_ENERGY
  }
];

export class LobbyModePortals {
  private readonly zones: ModeZone[] = [];
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly prompt: HTMLDivElement;
  private readonly promptEyebrow: HTMLDivElement;
  private readonly promptTitle: HTMLDivElement;
  private readonly promptSubtitle: HTMLDivElement;
  private readonly promptFill: HTMLDivElement;
  private activeZoneId: LobbyPortalId | null = null;
  private lastPromptZoneId: LobbyPortalId | null = null;
  private lastPromptPercent = -1;
  private promptVisible = false;
  private holdSeconds = 0;
  private activatedThisHold = false;
  private enabled = true;
  private elapsed = 0;

  constructor(private readonly scene: Scene) {
    for (const def of ZONES) this.createZone(def);

    this.prompt = document.createElement('div');
    this.prompt.className = 'lobby-mode-prompt';
    this.prompt.innerHTML = `
      <div class="lobby-mode-prompt__eyebrow"></div>
      <div class="lobby-mode-prompt__title"></div>
      <div class="lobby-mode-prompt__subtitle"></div>
      <div class="lobby-mode-prompt__hint"><span class="key">E</span> hold to enter</div>
      <div class="lobby-mode-prompt__bar"><div></div></div>
    `;
    document.getElementById('hud-root')?.appendChild(this.prompt);
    this.promptEyebrow = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__eyebrow');
    this.promptTitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__title');
    this.promptSubtitle = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__subtitle');
    this.promptFill = this.mustPromptElement<HTMLDivElement>('.lobby-mode-prompt__bar > div');
    this.setPromptVisible(false);
  }

  /**
   * `menuOpen` is true while the match menu (the portal flow) is up. While it is, the hold is latched
   * shut: the portal shows only idle motion and a still-held interact key cannot re-open the menu the
   * instant it closes — re-arming requires a genuine release first (see the latch handling below).
   */
  update(
    dt: number,
    playerPosition: Vector3,
    interactHeld: boolean,
    menuOpen: boolean,
    onActivate: (action: LobbyPortalAction) => void
  ): void {
    this.elapsed += dt;

    if (!this.enabled) {
      this.setPromptVisible(false);
      this.updateStationVisuals(null, 0);
      return;
    }

    if (menuOpen) {
      // The portal flow owns input right now. Keep the activation latched and hold timer drained so a
      // held interact key can't immediately re-trigger when the menu closes; only idle motion plays.
      this.activatedThisHold = true;
      this.holdSeconds = 0;
      this.setPromptVisible(false);
      this.updateStationVisuals(this.activeZoneId, 0);
      return;
    }

    const nearest = this.nearestZone(playerPosition);
    if (!nearest) {
      this.activeZoneId = null;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
      this.setPromptVisible(false);
      this.updateStationVisuals(null, 0);
      return;
    }

    if (this.activeZoneId !== nearest.id) {
      this.activeZoneId = nearest.id;
      this.holdSeconds = 0;
      this.activatedThisHold = false;
    }

    if (!interactHeld) {
      this.holdSeconds = 0;
      this.activatedThisHold = false;
    } else if (!this.activatedThisHold) {
      this.holdSeconds = Math.min(HOLD_SECONDS, this.holdSeconds + dt);
      if (this.holdSeconds >= HOLD_SECONDS) {
        this.activatedThisHold = true;
        onActivate(nearest.action);
      }
    }

    // onActivate may have disabled the portals this same frame (entering the movement sandbox or
    // going online). If so, don't fall through and re-show the prompt — update() won't run again
    // until the portals are re-enabled, so the prompt would otherwise stay stuck on screen.
    if (!this.enabled) {
      this.setPromptVisible(false);
      this.updateStationVisuals(null, 0);
      return;
    }

    const progress = this.holdSeconds / HOLD_SECONDS;
    this.updateStationVisuals(nearest.id, progress);
    this.updatePrompt(nearest);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    for (const zone of this.zones) zone.portal.setEnabled(enabled);
    if (!enabled) this.setPromptVisible(false);
  }

  dispose(): void {
    this.prompt.remove();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private createZone(def: ModeZoneDef): void {
    // Lobby portals face +Z (toward the court), matching the original inline implementation.
    const portal = new PortalArch({
      id: def.id,
      scene: this.scene,
      position: new Vector3(def.position.x, def.position.y, def.position.z),
      yaw: 0,
      title: def.title,
      palette: def.palette
    });
    this.disposables.push(portal);
    this.zones.push({ ...def, portal });
  }

  private nearestZone(playerPosition: Vector3): ModeZone | null {
    let best: ModeZone | null = null;
    let bestDistSq = ACTIVATE_RADIUS * ACTIVATE_RADIUS;
    for (const zone of this.zones) {
      const dx = playerPosition.x - zone.position.x;
      const dz = playerPosition.z - zone.position.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > bestDistSq) continue;
      bestDistSq = distSq;
      best = zone;
    }
    return best;
  }

  private updatePrompt(zone: ModeZone): void {
    if (this.lastPromptZoneId !== zone.id) {
      this.lastPromptZoneId = zone.id;
      this.promptEyebrow.textContent = zone.eyebrow;
      this.promptTitle.textContent = zone.title;
      this.promptSubtitle.textContent = zone.subtitle;
      this.prompt.dataset.mode = zone.id;
    }
    const percent = Math.round((this.holdSeconds / HOLD_SECONDS) * 100);
    if (percent !== this.lastPromptPercent) {
      this.lastPromptPercent = percent;
      this.promptFill.style.width = `${percent}%`;
    }
    this.setPromptVisible(true);
  }

  /**
   * Idle: slow interior scroll only. Player nearby: the thin edge brightens slightly. Holding E: a
   * small extra edge lift (the clear progress feedback lives in the HTML prompt bar). The portal
   * never flashes or out-glows the ceiling fixtures / scoreboard.
   */
  private updateStationVisuals(activeZoneId: LobbyPortalId | null, activeProgress: number): void {
    for (const zone of this.zones) {
      const active = zone.id === activeZoneId;
      const proximity = active ? 1 : 0;
      const progress = active ? Math.max(0, Math.min(1, activeProgress)) : 0;
      zone.portal.update(this.elapsed, proximity, progress);
    }
  }

  private setPromptVisible(visible: boolean): void {
    if (this.promptVisible === visible) return;
    this.promptVisible = visible;
    this.prompt.classList.toggle('lobby-mode-prompt--visible', visible);
    if (!visible) {
      this.lastPromptPercent = -1;
      this.promptFill.style.width = '0%';
    }
  }

  private mustPromptElement<T extends Element>(selector: string): T {
    const element = this.prompt.querySelector<T>(selector);
    if (!element) throw new Error(`Missing lobby mode prompt element: ${selector}`);
    return element;
  }
}
