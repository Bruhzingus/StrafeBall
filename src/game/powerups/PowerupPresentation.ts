import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { BallState, MapEffectKind, PlayerState, PowerupKind, RoomState, Vec3 } from '../../../shared/types';
import { isGrenadeKind } from '../../../shared/simulation/BallSim';
import { lavaMaxHeight } from '../../../shared/simulation/MapEffectSim';
import type { PowerupEvent, PowerupPrivateMessage } from '../../../shared/protocol';
import { SoundManager } from '../audio/SoundManager';
import { settings } from '../config/Settings';
import type { Hud, PowerupSlotView } from '../ui/Hud';

const ITEMS: Record<PowerupKind, { name: string; icon: string; color: string; hint: string }> = {
  adrenaline: { name: 'ADRENALINE', icon: 'ϟ', color: '#ffce65', hint: '6 dash charges · faster recharge · 15s' },
  speed: { name: 'SPEED', icon: '»', color: '#75e6ff', hint: '+30% speed · higher jumps · 15s' },
  cannon: { name: 'CANNONBALL', icon: '●', color: '#b9c5d8', hint: 'Unblockable · pierces players · locks stamina' },
  heal: { name: 'HEAL STATION', icon: '+', color: '#7fffb2', hint: 'Place with throw · stay 10s to heal' },
  magnet: { name: 'BALL MAGNET', icon: '∩', color: '#ce9aff', hint: 'Pull loose balls · up to 3 armor · 20s' },
  bomb: { name: 'BOMB BALL', icon: '✹', color: '#ffad73', hint: 'First bounce starts a 2s fuse · hits everyone' },
  shock: { name: 'SHOCKWAVE', icon: '◎', color: '#8ef1ff', hint: 'Sticks where it lands · flings players & balls · ×2' },
  stun: { name: 'STUN', icon: '✦', color: '#fff29a', hint: 'Sticks where it lands · dazes everyone near it · ×2' }
};
const kinds = Object.keys(ITEMS) as PowerupKind[];

const MAP_EFFECTS: Record<MapEffectKind, { name: string; warning: string; color: string; icon: string }> = {
  moon: { name: 'MOON GRAVITY', warning: 'Gravity is about to drop', color: '#c9d6ff', icon: '☾' },
  lava: { name: "DON'T TOUCH THE LAVA", warning: 'Lava is rising — get to high ground!', color: '#ff6a2a', icon: '♨' },
  frenzy: { name: 'BALL FRENZY', warning: 'Triple balls · nothing dies on a bounce', color: '#ffd24a', icon: '※' }
};

function material(scene: Scene, name: string, hex: string, glow = 0.3): StandardMaterial {
  const existing = scene.getMaterialByName(name) as StandardMaterial | null;
  if (existing) return existing;
  const m = new StandardMaterial(name, scene);
  m.diffuseColor = Color3.FromHexString(hex); m.emissiveColor = m.diffuseColor.scale(glow);
  m.specularColor = new Color3(0.35, 0.4, 0.45); m.specularPower = 64;
  return m;
}
function attach(mesh: Mesh, parent: TransformNode, mat: StandardMaterial, position = Vector3.Zero()): Mesh {
  mesh.parent = parent; mesh.material = mat; mesh.position.copyFrom(position); mesh.isPickable = false;
  return mesh;
}
function device(scene: Scene, parent: TransformNode, size = 1): void {
  const green = material(scene, 'power_green', '#4deb9b', 0.65);
  const dark = material(scene, 'power_device_dark', '#142c2b', 0.03);
  attach(MeshBuilder.CreateCylinder('station_base', { diameter: 0.7 * size, height: 0.13 * size, tessellation: 12 }, scene), parent, dark, new Vector3(0, 0.08 * size, 0));
  attach(MeshBuilder.CreateBox('station_core', { width: 0.36 * size, height: 0.42 * size, depth: 0.36 * size }, scene), parent, dark, new Vector3(0, 0.32 * size, 0));
  for (const sign of [-1, 1]) {
    attach(MeshBuilder.CreateBox('station_cross_h', { width: 0.26 * size, height: 0.065 * size, depth: 0.018 * size }, scene), parent, green, new Vector3(0, 0.34 * size, sign * 0.189 * size));
    attach(MeshBuilder.CreateBox('station_cross_v', { width: 0.065 * size, height: 0.26 * size, depth: 0.018 * size }, scene), parent, green, new Vector3(0, 0.34 * size, sign * 0.189 * size));
  }
  attach(MeshBuilder.CreateTorus('station_halo', { diameter: 0.45 * size, thickness: 0.04 * size, tessellation: 24 }, scene), parent, green, new Vector3(0, 0.57 * size, 0));
}

/** Mesh-native models share materials and travel with the existing interpolated ball/hand anchors. */
export function updateSpecialBall(mesh: Mesh, ball: BallState, time: number): void {
  if (!ball.kind || ball.kind === 'normal') return;
  const scene = mesh.getScene();
  const key = `power_model_${ball.kind}`;
  if (!mesh.metadata?.[key]) {
    mesh.metadata = { ...mesh.metadata, [key]: true };
    if (ball.kind === 'heal') {
      device(scene, mesh, 0.85);
    } else if (ball.kind === 'shock') {
      // Shockwave: a squat cyan puck with a glowing rim — reads as "device", not "ball".
      const puck = attach(MeshBuilder.CreateCylinder('shock_puck', { diameter: C.ball.radius * 2.3, height: C.ball.radius * 0.9, tessellation: 24 }, scene), mesh, material(scene, 'power_shock_body', '#20344a', 0.08));
      puck.position.y = 0;
      attach(MeshBuilder.CreateTorus('shock_rim', { diameter: C.ball.radius * 2.35, thickness: 0.035, tessellation: 32 }, scene), mesh, material(scene, 'power_shock_glow', '#8ef1ff', 1.1));
      const core = attach(MeshBuilder.CreateSphere('shock_core', { diameter: C.ball.radius * 0.7, segments: 10 }, scene), mesh, material(scene, 'power_shock_glow', '#8ef1ff', 1.1));
      mesh.metadata.powerCore = core;
    } else if (ball.kind === 'stun') {
      // Stun: an upright grey canister with a yellow band and a pin — the flashbang silhouette.
      const can = attach(MeshBuilder.CreateCylinder('stun_can', { diameter: C.ball.radius * 1.35, height: C.ball.radius * 2.6, tessellation: 16 }, scene), mesh, material(scene, 'power_stun_body', '#6d7480', 0.05));
      can.position.y = 0;
      attach(MeshBuilder.CreateCylinder('stun_band', { diameter: C.ball.radius * 1.42, height: C.ball.radius * 0.5, tessellation: 16 }, scene), mesh, material(scene, 'power_stun_glow', '#fff29a', 0.9));
      const pin = attach(MeshBuilder.CreateTorus('stun_pin', { diameter: C.ball.radius * 0.7, thickness: 0.02, tessellation: 12 }, scene), mesh, material(scene, 'power_steel', '#637083', 0.08), new Vector3(0, C.ball.radius * 1.45, 0));
      pin.rotation.x = Math.PI / 2;
      mesh.metadata.powerCore = pin;
    } else {
      const band = MeshBuilder.CreateTorus('power_ball_band', { diameter: C.ball.radius * 2 * 0.97, thickness: 0.018, tessellation: 32 }, scene);
      attach(band, mesh, material(scene, 'power_steel', '#637083', 0.08)); band.rotation.x = Math.PI / 2;
      if (ball.kind === 'bomb') {
        const fuse = attach(MeshBuilder.CreateCylinder('bomb_fuse', { height: 0.18, diameter: 0.035, tessellation: 8 }, scene), mesh, material(scene, 'power_fuse', '#c8a76c'), new Vector3(0.025, 0.27, 0));
        fuse.rotation.z = -0.35;
        const ember = attach(MeshBuilder.CreateSphere('bomb_ember', { diameter: 0.055, segments: 8 }, scene), mesh, material(scene, 'power_ember', '#ff843d', 1), new Vector3(0.055, 0.355, 0));
        mesh.metadata.powerEmber = ember;
      }
    }
  }
  mesh.material = material(scene, ball.kind === 'heal' ? 'power_green' : 'power_ball_black', ball.kind === 'heal' ? '#4deb9b' : '#151b27', ball.kind === 'heal' ? 0.65 : 0.015);
  const size = ball.kind === 'cannon' ? (ball.phase === 'held' ? C.powerup.cannonHeldScale : C.powerup.cannonFlightScale) : 1;
  mesh.scaling.scaleInPlace(size);
  if (ball.kind === 'heal' || isGrenadeKind(ball.kind)) mesh.visibility = 0; // children form the model; sphere is only its anchor
  if (isGrenadeKind(ball.kind)) {
    // A stuck grenade blinks faster as the fuse runs out; in flight/hand it just glows.
    const stuck = ball.phase === 'stuck';
    const fuse = ball.fuseSeconds ?? C.powerup.grenadeFuseSeconds;
    const blink = stuck ? (Math.sin(time * (18 + 30 * (1 - fuse / C.powerup.grenadeFuseSeconds))) > 0 ? 1 : 0.15) : 1;
    for (const child of mesh.getChildMeshes()) {
      child.renderOverlay = stuck;
      if (stuck) {
        child.overlayColor.copyFromFloats(...(ball.kind === 'shock' ? [0.55, 0.95, 1] : [1, 0.95, 0.6]) as [number, number, number]);
        child.overlayAlpha = 0.6 * blink;
      }
    }
    if (!stuck) mesh.rotation.y = time * 2.2;
  }
  const ember = mesh.metadata?.powerEmber as Mesh | undefined;
  if (ember) {
    const armed = ball.armedAtMs !== undefined;
    ember.setEnabled(armed);
    const pulse = armed ? 1 + Math.sin(time * (16 + 10 * (1 - (ball.fuseSeconds ?? 2) / 2))) * 0.5 : 1;
    ember.scaling.setAll(pulse);
    ember.position.y = 0.27 + Math.max(0, (ball.fuseSeconds ?? 2) / 2) * 0.085;
    // Red flash on each beep. The server beeps at fuse = 2.0, 1.33, 0.67 s remaining, so the flash is
    // derived from the replicated fuse clock (no event plumbing, identical for every viewer).
    const flash = armed ? bombBeepFlash(ball.fuseSeconds ?? C.powerup.bombFuseSeconds) : 0;
    mesh.renderOverlay = flash > 0.01;
    if (mesh.renderOverlay) { mesh.overlayColor.set(1, 0.16, 0.1); mesh.overlayAlpha = 0.85 * flash; }
    for (const child of mesh.getChildMeshes()) {
      child.renderOverlay = mesh.renderOverlay;
      if (mesh.renderOverlay) { child.overlayColor.copyFrom(mesh.overlayColor); child.overlayAlpha = mesh.overlayAlpha; }
    }
  }
}

/** 0..1 flash intensity for a bomb with `fuseSeconds` left: 1 at each beep, decaying over ~0.18 s. */
export function bombBeepFlash(fuseSeconds: number): number {
  const interval = C.powerup.bombFuseSeconds / 3;
  const elapsed = Math.max(0, C.powerup.bombFuseSeconds - fuseSeconds);
  const sinceBeep = elapsed - Math.floor(elapsed / interval) * interval;
  return Math.max(0, 1 - sinceBeep / 0.18);
}

interface SpawnNode { root: TransformNode; box: TransformNode; ring: Mesh[]; waitEstimate: number; lastWait: number }

export class PowerupPresentation {
  private spawnNodes: SpawnNode[] = [];
  private stations = new Map<string, TransformNode>();
  private markers = new Map<string, Mesh>();
  private trails: { mesh: Mesh; life: number }[] = [];
  private bursts: { mesh: Mesh; life: number; duration: number; radius: number }[] = [];
  private hud: Hud | null = null;
  private neutral = document.createElement('div');
  private screenFx = document.createElement('div');
  private heldKind: PowerupKind | null = null;
  private rouletteUntil = 0;
  private nudgeUntil = 0;
  private lastPrivate: PowerupPrivateMessage | null = null;
  private lastSerial = -1;
  private lastRound = -1;
  private time = 0;
  private trailTick = 0;
  private healTicked = 0;
  private lastHealing = 0;
  private healFlashUntil = 0;
  private lastFxKey = '';
  private mapBanner = document.createElement('div');
  private stunFx = document.createElement('div');
  private lastBannerHtml = '';
  private lava: Mesh | null = null;
  private effectCapsule: TransformNode | null = null;
  private effectCapsuleCore: Mesh | null = null;
  private stunFlashUntil = 0;
  private wasStunned = false;
  /** Mouse-look multiplier for the local player (1 = normal; dropped while stunned). */
  localLookScale = 1;

  constructor(private scene: Scene, private sound: SoundManager) {
    this.neutral.className = 'neutral-zone-label'; this.neutral.textContent = 'NEUTRAL';
    this.screenFx.className = 'powerup-screen-fx'; this.screenFx.setAttribute('aria-hidden', 'true');
    this.mapBanner.className = 'map-effect-banner'; this.mapBanner.hidden = true;
    this.stunFx.className = 'stun-fx'; this.stunFx.setAttribute('aria-hidden', 'true');
    document.body.append(this.neutral, this.screenFx, this.stunFx, this.mapBanner);
  }

  /** One mystery capsule + 60-segment respawn clock per spawn point (1 in 1v1, 2 in 2v2). */
  private createSpawnNode(index: number): SpawnNode {
    const scene = this.scene;
    const root = new TransformNode(`powerup_spawn_${index}`, scene);
    const box = new TransformNode('mystery_capsule', scene); box.parent = root;
    const gold = material(scene, 'power_gold', '#ffcc62', 0.55);
    const dark = material(scene, 'power_box_dark', '#182c46', 0.1);
    const shell = attach(MeshBuilder.CreateBox('mystery_shell', { size: 0.62 }, scene), box, dark);
    shell.enableEdgesRendering(); shell.edgesWidth = 2; shell.edgesColor.set(1, 0.8, 0.35, 1);
    for (const y of [-0.31, 0.31]) attach(MeshBuilder.CreateBox('mystery_trim', { width: 0.68, height: 0.045, depth: 0.68 }, scene), box, gold, new Vector3(0, y, 0));
    const faceMat = material(scene, 'power_question', '#ffffff', 0.8);
    if (!faceMat.diffuseTexture) {
      const tex = new DynamicTexture('mystery_question', { width: 128, height: 128 }, scene, false);
      tex.drawText('?', null, 102, 'bold 110px sans-serif', '#ffdc87', '#182c46', true);
      faceMat.diffuseTexture = tex; faceMat.emissiveTexture = tex;
    }
    for (let i = 0; i < 4; i++) {
      const face = attach(MeshBuilder.CreatePlane('mystery_face', { size: 0.48 }, scene), box, faceMat);
      face.position.set(Math.sin(i * Math.PI / 2) * 0.315, 0, Math.cos(i * Math.PI / 2) * 0.315);
      face.rotation.y = i * Math.PI / 2 + Math.PI;
    }
    const grey = material(scene, 'power_ring_wait', '#566171', 0.1);
    const ring: Mesh[] = [];
    for (let i = 0; i < 60; i++) {
      const angle = i / 60 * Math.PI * 2;
      const segment = attach(MeshBuilder.CreateBox('powerup_clock_segment', { width: 0.075, height: 0.025, depth: 0.18 }, scene), root, grey, new Vector3(Math.sin(angle) * 0.84, 0.025, Math.cos(angle) * 0.84));
      segment.rotation.y = angle; ring.push(segment);
    }
    root.setEnabled(false);
    return { root, box, ring, waitEstimate: C.powerup.respawnSeconds, lastWait: -1 };
  }

  update(room: RoomState | null, localId: string, localPosition: Vec3, privateMessage: PowerupPrivateMessage | null, events: PowerupEvent[], dt: number): void {
    this.time += dt;
    const active = !!room?.powerups && room.settings.powerupsEnabled !== false;
    if (!active) { this.hud?.setPowerupSlot(null); this.setScreenFx(null, 0); this.setStun(0); this.setBanner(''); }
    this.neutral.hidden = Math.abs(localPosition.z) > C.match.neutralZoneHalfDepth || Math.abs(localPosition.x) > C.map.halfWidth;
    if (room && (this.lastSerial !== room.resetVote.resetSerial || this.lastRound !== room.match.currentRound)) {
      this.clearDynamic(); this.heldKind = null; this.lastPrivate = null;
      for (const node of this.spawnNodes) node.lastWait = -1;
      this.lastSerial = room.resetVote.resetSerial; this.lastRound = room.match.currentRound;
    }
    if (!room) {
      this.hud?.setPowerupSlot(null); this.setScreenFx(null, 0); this.setStun(0); this.setBanner(''); this.clearDynamic();
      this.lava?.setEnabled(false); this.effectCapsule?.setEnabled(false);
      for (const node of this.spawnNodes) node.root.setEnabled(false);
      this.heldKind = null; this.lastPrivate = null; this.lastSerial = -1; return;
    }
    const local = room.players[localId];
    if (privateMessage && privateMessage !== this.lastPrivate && privateMessage.resetSerial === room.resetVote.resetSerial) {
      if (privateMessage.kind && privateMessage.kind !== this.heldKind) this.rouletteUntil = this.time + 1;
      this.heldKind = privateMessage.kind; this.lastPrivate = privateMessage;
      if (privateMessage.reason) { this.nudgeUntil = this.time + 2.5; this.sound.powerup('refuse'); }
    }
    if (local?.combatState === 'eliminated') this.heldKind = null;
    for (const event of events) {
      if (event.resetSerial !== room.resetVote.resetSerial) continue;
      // Map-effect cues are court-wide announcements, not positional.
      const spatial = !event.effect.startsWith('map-');
      this.sound.powerup(event.effect, spatial ? event.position : undefined, spatial ? localPosition : undefined, local?.movement.facing, event.stage ?? 0);
      if (event.effect === 'heal' && event.playerId === localId) this.healFlashUntil = this.time + 0.45;
      if (event.effect === 'explode' || event.effect === 'heal' || event.effect === 'pickup' || event.effect === 'thud' || event.effect === 'armor' || event.effect === 'activate' || event.effect === 'shock' || event.effect === 'stun') this.burst(event);
      if (event.effect === 'stun' && local && Math.hypot(local.movement.position.x - event.position.x, local.movement.position.z - event.position.z) <= C.powerup.stunRadius + 1) this.stunFlashUntil = this.time + 0.35;
    }
    const world = room.powerups;
    if (world && active) {
      // The world lane arrives at ~24 Hz; between updates run each spawn's clock locally so the ring
      // and HUD countdown stay smooth, re-anchoring whenever the server value changes.
      world.spawns.forEach((spawn, i) => {
        const node = this.spawnNodes[i] ??= this.createSpawnNode(i);
        node.root.setEnabled(true);
        node.root.position.set(spawn.x, 0, spawn.z);
        if (spawn.waitSeconds !== node.lastWait) { node.waitEstimate = spawn.waitSeconds; node.lastWait = spawn.waitSeconds; }
        else if ((room.match.status === 'playing' || room.match.status === 'warmup') && !spawn.spawned) node.waitEstimate = Math.max(0, node.waitEstimate - dt);
        node.box.setEnabled(spawn.spawned);
        node.box.position.y = 1.05 + (settings.reducedEffects ? 0 : Math.sin(this.time * 2.7) * 0.1);
        node.box.rotation.set(0.09, this.time * 0.65, settings.reducedEffects ? 0 : Math.sin(this.time * 1.8) * 0.06);
        const filled = spawn.spawned ? 60 : Math.floor((1 - node.waitEstimate / C.powerup.respawnSeconds) * 60);
        node.ring.forEach((m, j) => { m.material = material(this.scene, j < filled ? 'power_gold' : 'power_ring_wait', j < filled ? '#ffcc62' : '#566171', j < filled ? 0.55 : 0.1); });
      });
      for (let i = world.spawns.length; i < this.spawnNodes.length; i++) this.spawnNodes[i].root.setEnabled(false);
      this.updateStations(room);
      this.updateMapEffect(room);
    } else {
      for (const node of this.spawnNodes) node.root.setEnabled(false);
      this.lava?.setEnabled(false); this.effectCapsule?.setEnabled(false); this.setBanner('');
    }
    this.updatePlayers(room, localId, dt);
    if (active) { this.updateHud(local, room); this.updateLocalFeedback(local, room, dt); }
    for (const fx of this.bursts) {
      fx.life -= dt; const t = 1 - Math.max(0, fx.life) / fx.duration;
      fx.mesh.scaling.setAll(0.1 + fx.radius * (1 - Math.pow(1 - t, 3)));
      fx.mesh.visibility = (1 - t) * 0.7;
      if (fx.life <= 0) fx.mesh.dispose();
    }
    this.bursts = this.bursts.filter(f => f.life > 0);
  }
  /** Give the presentation the gameplay HUD so it can drive the ability bar's power-up slot. */
  attachHud(hud: Hud): void { this.hud = hud; }

  /**
   * One card + two text lines, in priority order: a refusal nudge, then the held item (what G does),
   * then a running effect, then the spawn state. The ring shows whichever timer matters right now.
   */
  private updateHud(local: PlayerState | undefined, room: RoomState): void {
    if (!this.hud) return;
    const rolling = !!this.heldKind && this.time < this.rouletteUntil && !settings.reducedEffects;
    const kind = rolling ? kinds[Math.floor(this.time * 16) % kinds.length] : this.heldKind;
    const item = kind ? ITEMS[kind] : null;
    const buffs = local?.movementInternal.buffs;
    const healing = Math.max(0, ...(room.powerups?.stations ?? []).map(s => s.progress[local?.id ?? ''] ?? 0));
    const armor = local?.armorBallIds?.length ?? 0;
    const effects: { kind: PowerupKind; label: string; seconds: number; max: number; color: string }[] = [];
    if ((buffs?.speedSeconds ?? 0) > 0) effects.push({ kind: 'speed', label: 'Speed', seconds: buffs!.speedSeconds, max: C.powerup.buffSeconds, color: ITEMS.speed.color });
    if ((buffs?.adrenalineSeconds ?? 0) > 0) effects.push({ kind: 'adrenaline', label: 'Adrenaline', seconds: buffs!.adrenalineSeconds, max: C.powerup.buffSeconds, color: ITEMS.adrenaline.color });
    if ((buffs?.magnetSeconds ?? 0) > 0) effects.push({ kind: 'magnet', label: 'Magnet', seconds: buffs!.magnetSeconds, max: C.powerup.magnetSeconds, color: ITEMS.magnet.color });
    const effectText = effects.map(e => `${e.label} ${Math.ceil(e.seconds)}s`)
      .concat(armor ? [`Armor ${'●'.repeat(armor)}`] : [], buffs?.cannonLocked ? ['Stamina locked'] : [])
      .join(' · ');
    const world = room.powerups;
    const heldGrenade = local
      ? (['left', 'right'] as const).map(h => room.balls[local.hands[h].heldBallId ?? '']).find(b => b && isGrenadeKind(b.kind))
      : undefined;

    let view: PowerupSlotView;
    if (item) {
      view = { glyph: item.icon, color: item.color, name: rolling ? 'Rolling…' : item.name, hint: item.hint, progress: 1, state: 'held', rolling };
    } else if (heldGrenade) {
      const item = ITEMS[heldGrenade.kind as PowerupKind];
      const left = 1 + (local?.pendingGrenades ?? 0);
      view = { glyph: item.icon, color: item.color, name: item.name, hint: `${left} left · sticks where it lands`, progress: left / C.powerup.grenadeCharges, state: 'held' };
    } else if (local?.hasPowerup) {
      view = { glyph: '?', color: ITEMS.adrenaline.color, name: 'Mystery item', hint: 'Revealing…', progress: 1, state: 'held' };
    } else if (effects.length > 0 || armor > 0 || buffs?.cannonLocked) {
      const lead = effects[0];
      view = { glyph: lead ? ITEMS[lead.kind].icon : armor ? ITEMS.magnet.icon : ITEMS.cannon.icon, color: lead?.color ?? (armor ? ITEMS.magnet.color : ITEMS.cannon.color), name: 'Active', hint: effectText, progress: lead ? lead.seconds / lead.max : 1, state: 'active' };
    } else if (healing > 0) {
      view = { glyph: ITEMS.heal.icon, color: ITEMS.heal.color, name: 'Healing', hint: `Stay put · ${Math.min(C.powerup.healSeconds, Math.floor(healing))}/${C.powerup.healSeconds}s`, progress: healing / C.powerup.healSeconds, state: 'active' };
    } else if (world?.spawns.some(s => s.spawned)) {
      view = { glyph: '?', color: ITEMS.adrenaline.color, name: 'Power-up', hint: 'Up for grabs at center', progress: 1, state: 'empty' };
    } else {
      const soonest = Math.min(C.powerup.respawnSeconds, ...this.spawnNodes.filter((n, i) => world?.spawns[i]).map(n => n.waitEstimate));
      view = { glyph: '?', color: ITEMS.adrenaline.color, name: 'Power-up', hint: `Next at center in ${Math.ceil(soonest)}s`, progress: 1 - soonest / C.powerup.respawnSeconds, state: 'waiting' };
    }
    // A refusal ("free a hand") overrides the hint line briefly.
    if (this.nudgeUntil > this.time && this.lastPrivate?.reason) view = { ...view, hint: this.lastPrivate.reason };
    // Keep the running effect visible in the hint even while an item is held (it's the shorter-lived info).
    else if (item && effectText) view = { ...view, hint: effectText };
    this.hud.setPowerupSlot(view);
  }
  /**
   * Local-only feedback: a soft tick for each second of heal dwell, and a faint edge tint in the
   * running effect's color (fades out over the last 1.5 s so you feel it ending). One tint at a
   * time, low opacity, no flashing — polish, not noise. Heal completion gets a short brighter pulse.
   */
  private updateLocalFeedback(local: PlayerState | undefined, room: RoomState, dt: number): void {
    void dt;
    const buffs = local?.movementInternal.buffs;
    const healing = local ? Math.max(0, ...(room.powerups?.stations ?? []).map(s => s.progress[local.id] ?? 0)) : 0;
    if (healing <= 0 || healing < this.lastHealing - 0.5) this.healTicked = 0;
    const whole = Math.floor(healing);
    if (whole >= 1 && whole < C.powerup.healSeconds && whole > this.healTicked) {
      this.healTicked = whole;
      this.sound.powerup('healtick', undefined, undefined, undefined, whole);
    }
    this.lastHealing = healing;

    const fade = (seconds: number) => Math.min(1, seconds / 1.5);
    let kind: PowerupKind | null = null;
    let strength = 0;
    if (this.time < this.healFlashUntil) { kind = 'heal'; strength = 1.8 * ((this.healFlashUntil - this.time) / 0.45); }
    else if (healing > 0) { kind = 'heal'; strength = 0.5 + 0.5 * (healing / C.powerup.healSeconds); }
    else if ((buffs?.speedSeconds ?? 0) > 0) { kind = 'speed'; strength = fade(buffs!.speedSeconds); }
    else if ((buffs?.adrenalineSeconds ?? 0) > 0) { kind = 'adrenaline'; strength = fade(buffs!.adrenalineSeconds); }
    else if ((buffs?.magnetSeconds ?? 0) > 0) { kind = 'magnet'; strength = fade(buffs!.magnetSeconds); }

    // Map effects tint at lower priority than a personal effect — except being IN the lava, which
    // is a danger cue and always wins.
    const effect = room.mapEffect;
    const lavaLevel = effect?.kind === 'lava' ? effect.lavaLevel : 0;
    const inLava = !!local && lavaLevel > 0.05 && local.movement.position.y < lavaLevel - 0.05 && local.combatState === 'alive';
    if (inLava) this.setScreenFx('lava-danger', 1.4 + 0.5 * Math.sin(this.time * 9), '#ff3b1a');
    else if (kind) this.setScreenFx(kind, strength, ITEMS[kind].color);
    else if (effect?.phase === 'active' && effect.kind === 'moon') this.setScreenFx('moon', 0.7, MAP_EFFECTS.moon.color);
    else if (effect?.phase === 'active' && effect.kind === 'lava') this.setScreenFx('lava', 0.5, MAP_EFFECTS.lava.color);
    else this.setScreenFx(null, 0);

    // Stun: blur + slowed look for the local player while their stun timer runs.
    const stun = buffs?.stunSeconds ?? 0;
    const stunned = stun > 0 && local?.combatState === 'alive';
    if (stunned && !this.wasStunned) this.stunFlashUntil = Math.max(this.stunFlashUntil, this.time + 0.35);
    this.wasStunned = stunned;
    const flash = Math.max(0, (this.stunFlashUntil - this.time) / 0.35);
    this.setStun(stunned ? Math.max(0.35, Math.min(1, stun / C.powerup.stunSeconds)) + flash : flash);
    // Ease the look speed back over the last 0.4 s so the recovery isn't a hard snap.
    this.localLookScale = stunned ? C.powerup.stunLookMultiplier + (1 - C.powerup.stunLookMultiplier) * Math.max(0, 1 - stun / 0.4) : 1;
  }

  private setStun(level: number): void {
    const value = settings.reducedEffects ? Math.min(level, 0.5) : Math.max(0, Math.min(2, level));
    this.stunFx.style.setProperty('--stun-level', value.toFixed(2));
    this.stunFx.hidden = value <= 0.01;
  }

  private setBanner(html: string, color = ''): void {
    if (html === this.lastBannerHtml) return;
    this.lastBannerHtml = html;
    this.mapBanner.hidden = html === '';
    this.mapBanner.innerHTML = html;
    if (color) this.mapBanner.style.setProperty('--banner-color', color);
  }

  /** Banner + effect capsule during the warning, lava sheet while it runs. */
  private updateMapEffect(room: RoomState): void {
    const effect = room.mapEffect;
    const spawns = room.powerups?.spawns ?? [];
    if (!effect) {
      this.setBanner('');
      this.effectCapsule?.setEnabled(false);
      this.lava?.setEnabled(false);
      return;
    }
    const info = MAP_EFFECTS[effect.kind];
    const secs = Math.max(0, Math.ceil(effect.remainingSeconds));
    if (effect.phase === 'warning') {
      this.setBanner(`<b>${info.icon} ${info.name}</b><span>${info.warning}</span><i>${secs}</i>`, info.color);
      // Show the capsule at the spawn that rolled it, in the effect's color, spinning up.
      const spawn = spawns[effect.spawnIndex] ?? spawns[0];
      if (!this.effectCapsule) {
        this.effectCapsule = new TransformNode('map_effect_capsule', this.scene);
        this.effectCapsuleCore = attach(MeshBuilder.CreateSphere('map_effect_core', { diameter: 0.7, segments: 16 }, this.scene), this.effectCapsule, material(this.scene, 'map_effect_core', '#ffffff', 0.9));
        const ring = attach(MeshBuilder.CreateTorus('map_effect_ring', { diameter: 1.25, thickness: 0.05, tessellation: 40 }, this.scene), this.effectCapsule, material(this.scene, 'map_effect_ring', '#ffffff', 0.9));
        ring.rotation.x = Math.PI / 2;
      }
      const c = Color3.FromHexString(info.color);
      for (const child of this.effectCapsule.getChildMeshes()) {
        const m = child.material as StandardMaterial | null;
        if (m) { m.diffuseColor = c; m.emissiveColor = c.scale(0.9); }
      }
      this.effectCapsule.setEnabled(true);
      this.effectCapsule.position.set(spawn?.x ?? 0, 1.05 + Math.sin(this.time * 3) * 0.08, spawn?.z ?? 0);
      this.effectCapsule.rotation.y = this.time * (2 + 4 * (1 - effect.remainingSeconds / C.mapEffect.warningSeconds));
      this.effectCapsule.scaling.setAll(1 + 0.12 * Math.sin(this.time * 10));
    } else {
      this.effectCapsule?.setEnabled(false);
      this.setBanner(`<b>${info.icon} ${info.name}</b><i>${effect.phase === 'ending' ? 'clearing' : secs}</i>`, info.color);
    }

    // Lava sheet.
    if (effect.kind === 'lava') {
      if (!this.lava) {
        this.lava = MeshBuilder.CreateGround('lava_sheet', { width: C.map.halfWidth * 2, height: C.map.halfLength * 2, subdivisions: 1 }, this.scene);
        const mat = material(this.scene, 'map_lava', '#ff5a1f', 0.9);
        mat.alpha = 0.9; mat.specularColor = new Color3(0.9, 0.5, 0.2); mat.specularPower = 24;
        this.lava.material = mat; this.lava.isPickable = false;
      }
      const level = Math.min(effect.lavaLevel, lavaMaxHeight());
      this.lava.setEnabled(level > 0.01);
      this.lava.position.y = level + 0.01;
      const mat = this.lava.material as StandardMaterial;
      const glow = 0.75 + 0.25 * Math.sin(this.time * 2.4);
      mat.emissiveColor.copyFromFloats(1.0 * glow, 0.36 * glow, 0.1 * glow);
    } else {
      this.lava?.setEnabled(false);
    }
  }

  private setScreenFx(key: string | null, strength: number, color = ''): void {
    const level = settings.reducedEffects || !key ? 0 : Math.max(0, Math.min(2, strength));
    const fxKey = `${key ?? ''}|${level.toFixed(2)}`;
    if (fxKey === this.lastFxKey) return;
    this.lastFxKey = fxKey;
    if (key) { this.screenFx.dataset.kind = key; if (color) this.screenFx.style.setProperty('--fx-color', color); }
    else delete this.screenFx.dataset.kind;
    this.screenFx.style.setProperty('--fx-strength', level.toFixed(2));
  }

  private updateStations(room: RoomState): void {
    const seen = new Set<string>();
    for (const station of room.powerups?.stations ?? []) {
      seen.add(station.id);
      let root = this.stations.get(station.id);
      if (!root) {
        root = new TransformNode(station.id, this.scene); device(this.scene, root);
        const disc = attach(MeshBuilder.CreateDisc('heal_disc', { radius: C.powerup.healRadius, tessellation: 48, sideOrientation: Mesh.DOUBLESIDE }, this.scene), root, material(this.scene, 'power_heal_disc', '#36c57e', 0.35), new Vector3(0, 0.016, 0));
        disc.rotation.x = Math.PI / 2; disc.visibility = 0.12;
        attach(MeshBuilder.CreateTorus('heal_boundary', { diameter: C.powerup.healRadius * 2, thickness: 0.028, tessellation: 48 }, this.scene), root, material(this.scene, 'power_green', '#4deb9b', 0.65), new Vector3(0, 0.025, 0));
        for (let i = 0; i < 40; i++) {
          const angle = i / 40 * Math.PI * 2;
          const tick = attach(MeshBuilder.CreateBox('heal_progress_tick', { width: 0.1, height: 0.025, depth: 0.07 }, this.scene), root, material(this.scene, 'power_green', '#4deb9b', 0.65), new Vector3(Math.sin(angle) * C.powerup.healRadius * 0.9, 0.027, Math.cos(angle) * C.powerup.healRadius * 0.9));
          tick.rotation.y = angle; tick.metadata = { healProgressIndex: i };
        }
        this.stations.set(station.id, root);
      }
      root.position.copyFromFloats(station.position.x, 0, station.position.z);
      const progress = Math.max(0, ...Object.values(station.progress)) / C.powerup.healSeconds;
      for (const child of root.getChildMeshes()) {
        if (child.metadata?.healProgressIndex !== undefined) child.visibility = child.metadata.healProgressIndex / 40 < progress ? 1 : 0.12;
      }
      root.scaling.y = station.remainingSeconds < 3 ? 0.97 + Math.sin(this.time * 12) * 0.03 : 1;
    }
    for (const [id, root] of this.stations) if (!seen.has(id)) { root.dispose(); this.stations.delete(id); }
  }
  private updatePlayers(room: RoomState, localId: string, dt: number): void {
    this.trailTick -= dt;
    for (const player of Object.values(room.players)) {
      if (player.id === localId) continue;
      let marker = this.markers.get(player.id);
      if (player.hasPowerup && !marker) {
        marker = MeshBuilder.CreatePolyhedron('powerup_holder_marker', { type: 1, size: 0.11 }, this.scene);
        marker.material = material(this.scene, 'power_gold', '#ffcc62', 0.55); marker.isPickable = false; this.markers.set(player.id, marker);
      }
      if (marker) { marker.setEnabled(!!player.hasPowerup && player.combatState === 'alive'); marker.position.set(player.movement.position.x, player.movement.position.y + 2.2, player.movement.position.z); marker.rotation.y = this.time; }
      if (!settings.reducedEffects && this.trailTick <= 0 && (player.movementInternal.buffs?.speedSeconds ?? 0) > 0 && player.movement.speed > 1 && this.trails.length < 36) {
        const trail = MeshBuilder.CreateBox('speed_streak', { width: 0.022, height: 0.022, depth: 0.7 }, this.scene);
        trail.position.set(player.movement.position.x, player.movement.position.y + 0.4 + Math.random() * 0.8, player.movement.position.z);
        trail.rotation.y = Math.atan2(player.movement.velocity.x, player.movement.velocity.z);
        trail.material = material(this.scene, 'power_speed', '#75e6ff', 0.75); trail.isPickable = false; this.trails.push({ mesh: trail, life: 0.3 });
      }
    }
    if (this.trailTick <= 0) this.trailTick = 0.065;
    for (const trail of this.trails) { trail.life -= dt; trail.mesh.visibility = Math.max(0, trail.life / 0.3); if (trail.life <= 0) trail.mesh.dispose(); }
    this.trails = this.trails.filter(t => t.life > 0);
    for (const [id, mesh] of this.markers) if (!room.players[id]) { mesh.dispose(); this.markers.delete(id); }
  }
  private burst(event: PowerupEvent): void {
    if (this.bursts.length >= 16) return;
    const explosion = event.effect === 'explode';
    const shock = event.effect === 'shock';
    const stun = event.effect === 'stun';
    const mesh = MeshBuilder.CreateTorus('powerup_pulse', { diameter: 2, thickness: explosion || shock ? 0.07 : 0.03, tessellation: 40 }, this.scene);
    mesh.position.set(event.position.x, Math.max(0.04, event.position.y), event.position.z);
    mesh.material = material(this.scene,
      explosion ? 'power_explosion' : shock ? 'power_shock_glow' : stun ? 'power_stun_glow' : 'power_green',
      explosion ? '#ffb06b' : shock ? '#8ef1ff' : stun ? '#fff29a' : '#4deb9b', 0.65);
    mesh.isPickable = false;
    const radius = explosion ? C.powerup.blastRadius : shock ? C.powerup.shockRadius : stun ? C.powerup.stunRadius : 1;
    const duration = explosion ? 0.55 : shock ? 0.45 : stun ? 0.3 : 0.4;
    this.bursts.push({ mesh, duration, life: duration, radius });
    if (shock && !settings.reducedEffects) {
      // Second, taller ring so the wave reads in 3D, not just on the floor.
      const dome = MeshBuilder.CreateTorus('shock_wave_2', { diameter: 2, thickness: 0.05, tessellation: 40 }, this.scene);
      dome.position.copyFrom(mesh.position); dome.position.y += 0.9; dome.material = mesh.material; dome.isPickable = false;
      this.bursts.push({ mesh: dome, duration: 0.4, life: 0.4, radius: radius * 0.85 });
    }
    if (stun && !settings.reducedEffects) {
      const flash = MeshBuilder.CreateSphere('stun_flash', { diameter: 2, segments: 12 }, this.scene);
      flash.position.copyFrom(mesh.position); flash.material = material(this.scene, 'power_stun_glow', '#fff29a', 0.9); flash.isPickable = false;
      this.bursts.push({ mesh: flash, duration: 0.22, life: 0.22, radius: radius * 0.6 });
    }
    if (explosion && !settings.reducedEffects) {
      const flash = MeshBuilder.CreateSphere('bomb_fireball', { diameter: 2, segments: 12 }, this.scene);
      flash.position.copyFrom(mesh.position); flash.material = material(this.scene, 'power_explosion', '#ffb06b', 0.65); flash.isPickable = false;
      this.bursts.push({ mesh: flash, duration: 0.26, life: 0.26, radius: C.powerup.blastRadius * 0.8 });
    }
  }
  private clearDynamic(): void {
    for (const root of this.stations.values()) root.dispose(); this.stations.clear();
    for (const mesh of this.markers.values()) mesh.dispose(); this.markers.clear();
    for (const { mesh } of [...this.trails, ...this.bursts]) mesh.dispose(); this.trails = []; this.bursts = [];
  }
  dispose(): void {
    this.clearDynamic(); this.hud?.setPowerupSlot(null); this.neutral.remove(); this.screenFx.remove(); this.stunFx.remove(); this.mapBanner.remove();
    for (const node of this.spawnNodes) node.root.dispose(); this.spawnNodes = [];
    this.lava?.dispose(); this.lava = null; this.effectCapsule?.dispose(); this.effectCapsule = null;
  }
}

