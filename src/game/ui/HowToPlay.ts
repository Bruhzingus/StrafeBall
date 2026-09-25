import { GAME_CONSTANTS } from '../../../shared/constants';
import { CONTROL_KEYS } from '../config/controls';

/**
 * A quick-reference rulebook, opened from Settings. Built as flip-through pages (like the Quick
 * Start card, just deeper) instead of one long scroll, so a player mid-lobby can jump straight to
 * "how does the powerup work" without hunting. Pure reference — reads game constants, doesn't
 * touch any gameplay state.
 */

interface Page {
  title: string;
  html: string;
}

const key = (code: string): string => code.replace(/^Key/, '').replace(/^Digit/, '').replace('Left', '').replace('Right', '');

function buildPages(): Page[] {
  const halfCourtWarnings = GAME_CONSTANTS.match.illegalCrossWarningsBeforePenalty;
  const dashCharges = GAME_CONSTANTS.dash.maxCharges;
  const dashRecharge = GAME_CONSTANTS.dash.rechargeSeconds;
  const backflipCooldown = GAME_CONSTANTS.backflip.cooldownSeconds;
  const respawn = GAME_CONSTANTS.powerup.respawnSeconds;
  const buffSeconds = GAME_CONSTANTS.powerup.buffSeconds;
  const grenades = GAME_CONSTANTS.powerup.grenadeCharges;
  const frenzyMult = GAME_CONSTANTS.mapEffect.frenzyBallMultiplier;
  const frenzySeconds = GAME_CONSTANTS.mapEffect.frenzySeconds;

  return [
    {
      title: 'Controls',
      html: `
        <div class="htp-grid">
          <div><span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> move</div>
          <div><span class="key">Space</span> jump</div>
          <div><span class="key">${key(CONTROL_KEYS.dash)}</span> dash (mid-air = double jump)</div>
          <div><span class="key">${key(CONTROL_KEYS.crouch)}</span> crouch</div>
          <div><span class="key">${key(CONTROL_KEYS.slide)}</span> slide (while moving fast)</div>
          <div><span class="key">${key(CONTROL_KEYS.backflip)}</span> backflip</div>
          <div><span class="key">M1</span> left hand · <span class="key">M2</span> right hand</div>
          <div><span class="key">${key(CONTROL_KEYS.interact)}</span> grab a loose ball / stand a mat back up</div>
          <div><span class="key">${key(CONTROL_KEYS.drop)}</span> drop a held ball</div>
          <div><span class="key">${key(CONTROL_KEYS.fakeThrow)}</span> pump fake</div>
          <div><span class="key">${key(CONTROL_KEYS.activatePowerup)}</span> use your powerup</div>
        </div>
        <p>Empty hand, click toward a loose ball, and you'll snap it up if it's close enough — you don't have to walk right up to the small drops. Walk near a wall at an angle while airborne to grab on and run it; steer with A/D to climb or drop off the wall.</p>
      `
    },
    {
      title: 'The Half',
      html: `
        <p>The court is split down the middle. Cross into the other team's half and a warning kicks in — get back within a second or two or it starts costing you a life every second you're still over there. You get ${halfCourtWarnings} free warning${halfCourtWarnings === 1 ? '' : 's'} before it starts ticking.</p>
        <p>The <b>center strip</b> is neutral ground for everyone — stand there, throw from there, get hit there, it's fair game either way. That's also where the powerup spawns, so it's worth fighting over instead of always retreating.</p>
        <p>Late in a round the boundary drops and the whole court opens up, so a stalled game can't just sit at a standoff forever.</p>
      `
    },
    {
      title: 'Stamina & Movement',
      html: `
        <p>Dashing, wall-jumping off a wall-run, and double-jumping all pull from the same pool of ${dashCharges} charges. They refill on their own — about one every ${dashRecharge}s — so burn them when you need the burst, they'll come back.</p>
        <p>Sliding keeps your speed instead of dumping it, so the move is chaining a sprint into a slide to carry momentum through a turn, not just ducking under something.</p>
        <p>Backflip (${key(CONTROL_KEYS.backflip)}) sends you up and back while holding a ball. Land it and a quick timing bar pops up — click closer to the center of the bar for a harder, faster throw. Miss the bar entirely and you just keep the ball, no throw. It's on a ${backflipCooldown}s cooldown.</p>
      `
    },
    {
      title: 'Catch, Parry, Throw',
      html: `
        <p>Aim your hand where the ball's headed and click to catch — the game reads your aim relative to the incoming ball, not a giant hitbox, so actually track it. Hold both hands full and you can also parry: aim at a live ball and it gets batted away instead of caught.</p>
        <p>Tap a hand for a quick throw, or hold it to charge up — charging trades a beat of wind-up for real extra speed and a straighter line. Throwing twice in a fast burst (the "double-ball" trick) gets both throws penalized, so it's not a free way to double your damage.</p>
        <p>Getting hit costs a life. Run out and you're eliminated for that round.</p>
      `
    },
    {
      title: 'Powerups',
      html: `
        <p>A mystery box spawns at center court (2v2 gets two, one on each side of the strip) every ${respawn}s after the last one's taken. Walk over it to grab it — only you know what it does until you use it with <span class="key">${key(CONTROL_KEYS.activatePowerup)}</span>. If it's something visible on the field (a giant black ball, someone glowing), everyone else can see that too.</p>
        <div class="htp-items">
          <div><b>⚡ Adrenaline</b> — doubles your dash charges and refills them faster for ${buffSeconds}s.</div>
          <div><b>» Speed</b> — a solid move-speed boost and higher jumps for ${buffSeconds}s.</div>
          <div><b>● Cannonball</b> — hold the throw button to charge it, then release. Early throws are weak and fall quickly; charge nearly to full to send it far. It gains 10% speed every 6 metres and punches through everyone — enemies, teammates, even you if it comes back. It can ricochet four times off walls and obstacles, but touching the floor destroys it instantly. You can't dash while carrying it.</div>
          <div><b>+ Heal Station</b> — drop it and stand in the ring for a few seconds straight to earn back a life. Step out and the timer resets.</div>
          <div><b>∩ Ball Magnet</b> — loose balls drift toward you, and once your hands are full, extras stick to you as armor that'll eat a hit for you.</div>
          <div><b>✹ Bomb Ball</b> — throw it like normal, but the first bounce arms a short fuse. Three beeps, then it goes off and tags everyone standing close, thrower included.</div>
          <div><b>◎ Shockwave</b> — you get ${grenades}. It doesn't bounce; whatever it hits first (floor, wall, mat, a player) is where it sticks, then a beat later it goes off. Nobody loses a life — it just launches everyone and every loose ball near it, flattens mats, and cancels any throw someone was winding up. Shove someone over the line and let the half-court rule do the rest.</div>
          <div><b>✦ Stun</b> — same throw-and-stick as the shockwave, ${grenades} of them. When it pops, everyone close (you included, if you're standing there) gets dazed for a couple seconds: blurry screen, mouse feels like molasses, slow feet, no dash.</div>
        </div>
      `
    },
    {
      title: 'Map Effects',
      html: `
        <p>Sometimes the spawn clock doesn't drop an item at all — a glowing capsule appears instead, a banner warns everyone what's coming, and a few seconds later the whole court changes. Nobody picks these up; they hit both teams the same.</p>
        <div class="htp-items">
          <div><b>☾ Moon Gravity</b> — gravity goes way down for a bit. Huge floaty jumps, long hang time, balls sail further. Chaos, but the same chaos for everyone.</div>
          <div><b>♨ Don't Touch the Lava</b> — the floor starts flooding. It rises until only the very top of the bleachers is dry, so get up there or keep moving — wall-runs keep you above it. Standing in it costs a life about every second. Loose balls float on top and drift out to the bleachers so you can still grab ammo from up high.</div>
          <div><b>※ Ball Frenzy</b> — ${frenzyMult}× the balls rain down from the ceiling for ${frenzySeconds}s, and nothing dies on a bounce: a live throw stays live off the floor, walls, mats, all of it. Watch the ricochets.</div>
        </div>
      `
    },
    {
      title: 'Match Basics',
      html: `
        <p>Every player starts with a set number of lives (the host sets it in the lobby). Get hit, lose one. Last team standing wins the round.</p>
        <p>Mats scattered around the court are cover — throws can't punch through a standing one. Knock one flat and it stops blocking until someone holds ${key(CONTROL_KEYS.interact)} on it to stand it back up.</p>
        <p>Hosts can tweak lives, ball count, mat layout, powerups on/off and more from the lobby settings before starting.</p>
      `
    }
  ];
}

export class HowToPlay {
  private readonly overlay: HTMLDivElement;
  private readonly panel: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly tabs: HTMLDivElement;
  private readonly pageLabel: HTMLDivElement;
  private readonly pages: Page[];
  private index = 0;
  private open = false;
  private previousFocus: HTMLElement | null = null;
  private readonly tabButtons: HTMLButtonElement[] = [];

  constructor(private readonly parent: HTMLElement = document.body) {
    this.pages = buildPages();

    this.overlay = document.createElement('div');
    this.overlay.className = 'htp-overlay';
    this.overlay.setAttribute('data-no-lock', '');
    this.overlay.hidden = true;
    this.overlay.addEventListener('click', (event) => { if (event.target === this.overlay) this.close(); });

    this.panel = document.createElement('div');
    this.panel.className = 'htp-panel';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-modal', 'true');
    this.panel.setAttribute('aria-label', 'StrafeBall rulebook');
    this.panel.addEventListener('keydown', (event) => {
      this.onKeydown(event);
      event.stopPropagation();
    });

    const header = document.createElement('div');
    header.className = 'htp-header';
    const title = document.createElement('div');
    title.className = 'htp-title';
    title.textContent = 'StrafeBall Rulebook';
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'htp-close';
    closeButton.textContent = 'x';
    closeButton.setAttribute('aria-label', 'Close');
    closeButton.addEventListener('click', () => this.close());
    header.append(title, closeButton);

    this.tabs = document.createElement('div');
    this.tabs.className = 'htp-tabs';
    this.tabs.setAttribute('aria-label', 'Rulebook sections');
    this.pages.forEach((page, i) => {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = 'htp-tab';
      tab.textContent = page.title;
      tab.addEventListener('click', () => this.goTo(i));
      this.tabs.appendChild(tab);
      this.tabButtons.push(tab);
    });

    this.body = document.createElement('div');
    this.body.className = 'htp-body';

    const footer = document.createElement('div');
    footer.className = 'htp-footer';
    const prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'htp-nav';
    prev.textContent = '< Prev';
    prev.addEventListener('click', () => this.goTo(this.index - 1));
    this.pageLabel = document.createElement('div');
    this.pageLabel.className = 'htp-page-label';
    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'htp-nav';
    next.textContent = 'Next >';
    next.addEventListener('click', () => this.goTo(this.index + 1));
    footer.append(prev, this.pageLabel, next);

    this.panel.append(header, this.tabs, this.body, footer);
    this.overlay.appendChild(this.panel);
    this.parent.appendChild(this.overlay);

    document.addEventListener('keydown', this.onKeydown);
    this.render();
  }

  show(): void {
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.open = true;
    this.overlay.hidden = false;
    this.tabButtons[this.index].focus();
  }

  close(): void {
    if (!this.open) return;
    this.open = false;
    this.overlay.hidden = true;
    if (!document.pointerLockElement) this.previousFocus?.focus();
    this.previousFocus = null;
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  dispose(): void {
    document.removeEventListener('keydown', this.onKeydown);
    this.overlay.remove();
  }

  private goTo(index: number): void {
    this.index = Math.max(0, Math.min(this.pages.length - 1, index));
    this.render();
  }

  private render(): void {
    const page = this.pages[this.index];
    this.body.innerHTML = page.html;
    this.body.scrollTop = 0;
    this.pageLabel.textContent = `${this.index + 1} / ${this.pages.length}`;
    this.tabButtons.forEach((tab, i) => {
      tab.classList.toggle('htp-tab--active', i === this.index);
      tab.setAttribute('aria-pressed', String(i === this.index));
    });
  }

  private onKeydown = (event: KeyboardEvent): void => {
    if (!this.open) return;
    if (event.code === 'Escape') { event.preventDefault(); this.close(); return; }
    if (event.code === 'Tab') {
      const buttons = this.panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    // Left/right paging so it really is quick to flip through, not just click-only.
    if (event.code === 'ArrowRight') { event.preventDefault(); this.goTo(this.index + 1); }
    else if (event.code === 'ArrowLeft') { event.preventDefault(); this.goTo(this.index - 1); }
  };
}
