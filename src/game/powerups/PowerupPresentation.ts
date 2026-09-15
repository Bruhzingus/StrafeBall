import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, TransformNode, Vector3 } from '@babylonjs/core';
import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { BallState, PlayerState, PowerupKind, RoomState, Vec3 } from '../../../shared/types';
import type { PowerupEvent, PowerupPrivateMessage } from '../../../shared/protocol';
import { SoundManager } from '../audio/SoundManager';
import { settings } from '../config/Settings';

const ITEMS: Record<PowerupKind, { name: string; icon: string; color: string; hint: string }> = {
  adrenaline: { name: 'ADRENALINE', icon: 'ϟ', color: '#ffce65', hint: '6 dash charges · faster recharge · 15s' },
  speed: { name: 'SPEED', icon: '»', color: '#75e6ff', hint: '+30% speed · higher jumps · 15s' },
  cannon: { name: 'CANNONBALL', icon: '●', color: '#b9c5d8', hint: 'Unblockable · pierces players · locks stamina' },
  heal: { name: 'HEAL STATION', icon: '+', color: '#7fffb2', hint: 'Place with throw · stay 10s to heal' },
  magnet: { name: 'BALL MAGNET', icon: '∩', color: '#ce9aff', hint: 'Pull loose balls · up to 3 armor · 20s' },
  bomb: { name: 'BOMB BALL', icon: '✹', color: '#ffad73', hint: 'First bounce starts a 2s fuse · hits everyone' }
};
const kinds = Object.keys(ITEMS) as PowerupKind[];

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
  if (ball.kind === 'heal') mesh.visibility = 0; // children form the deployable; sphere is only its anchor
  const ember = mesh.metadata?.powerEmber as Mesh | undefined;
  if (ember) {
    const armed = ball.armedAtMs !== undefined;
    ember.setEnabled(armed);
    const pulse = armed ? 1 + Math.sin(time * (16 + 10 * (1 - (ball.fuseSeconds ?? 2) / 2))) * 0.5 : 1;
    ember.scaling.setAll(pulse);
    ember.position.y = 0.27 + Math.max(0, (ball.fuseSeconds ?? 2) / 2) * 0.085;
  }
}

export class PowerupPresentation {
  private root: TransformNode;
  private box: TransformNode;
  private ring: Mesh[] = [];
  private stations = new Map<string, TransformNode>();
  private markers = new Map<string, Mesh>();
  private trails: { mesh: Mesh; life: number }[] = [];
  private bursts: { mesh: Mesh; life: number; duration: number; radius: number }[] = [];
  private hud = document.createElement('div');
  private neutral = document.createElement('div');
  private heldKind: PowerupKind | null = null;
  private rouletteUntil = 0;
  private nudgeUntil = 0;
  private lastPrivate: PowerupPrivateMessage | null = null;
  private lastSerial = -1;
  private lastRound = -1;
  private time = 0;
  private trailTick = 0;
  private lastHtml = '';
  private waitEstimate = C.powerup.respawnSeconds as number;
  private lastWait = -1;

  constructor(private scene: Scene, private sound: SoundManager) {
    this.root = new TransformNode('powerup_center', scene);
    this.box = new TransformNode('mystery_capsule', scene); this.box.parent = this.root;
    const gold = material(scene, 'power_gold', '#ffcc62', 0.55);
    const dark = material(scene, 'power_box_dark', '#182c46', 0.1);
    const shell = attach(MeshBuilder.CreateBox('mystery_shell', { size: 0.62 }, scene), this.box, dark);
    shell.enableEdgesRendering(); shell.edgesWidth = 2; shell.edgesColor.set(1, 0.8, 0.35, 1);
    for (const y of [-0.31, 0.31]) attach(MeshBuilder.CreateBox('mystery_trim', { width: 0.68, height: 0.045, depth: 0.68 }, scene), this.box, gold, new Vector3(0, y, 0));
    const tex = new DynamicTexture('mystery_question', { width: 128, height: 128 }, scene, false);
    tex.drawText('?', null, 102, 'bold 110px sans-serif', '#ffdc87', '#182c46', true);
    const faceMat = material(scene, 'power_question', '#ffffff', 0.8); faceMat.diffuseTexture = tex; faceMat.emissiveTexture = tex;
    for (let i = 0; i < 4; i++) {
      const face = attach(MeshBuilder.CreatePlane('mystery_face', { size: 0.48 }, scene), this.box, faceMat);
      face.position.set(Math.sin(i * Math.PI / 2) * 0.315, 0, Math.cos(i * Math.PI / 2) * 0.315);
      face.rotation.y = i * Math.PI / 2 + Math.PI;
    }
    const grey = material(scene, 'power_ring_wait', '#566171', 0.1);
    for (let i = 0; i < 60; i++) {
      const angle = i / 60 * Math.PI * 2;
      const segment = attach(MeshBuilder.CreateBox('powerup_clock_segment', { width: 0.075, height: 0.025, depth: 0.18 }, scene), this.root, grey, new Vector3(Math.sin(angle) * 0.84, 0.025, Math.cos(angle) * 0.84));
      segment.rotation.y = angle; this.ring.push(segment);
    }
    this.hud.className = 'powerup-hud'; this.neutral.className = 'neutral-zone-label'; this.neutral.textContent = 'NEUTRAL';
    document.body.append(this.hud, this.neutral); this.root.setEnabled(false);
  }

  update(room: RoomState | null, localId: string, localPosition: Vec3, privateMessage: PowerupPrivateMessage | null, events: PowerupEvent[], dt: number): void {
    this.time += dt;
    const active = !!room?.powerups && room.settings.powerupsEnabled !== false;
    this.root.setEnabled(active);
    this.hud.hidden = !active;
    this.neutral.hidden = Math.abs(localPosition.z) > C.match.neutralZoneHalfDepth || Math.abs(localPosition.x) > C.map.halfWidth;
    if (room && (this.lastSerial !== room.resetVote.resetSerial || this.lastRound !== room.match.currentRound)) {
      this.clearDynamic(); this.heldKind = null; this.lastPrivate = null; this.lastWait = -1;
      this.lastSerial = room.resetVote.resetSerial; this.lastRound = room.match.currentRound;
    }
    if (!room) { this.clearDynamic(); this.heldKind = null; this.lastPrivate = null; this.lastSerial = -1; return; }
    const local = room.players[localId];
    if (privateMessage && privateMessage !== this.lastPrivate && privateMessage.resetSerial === room.resetVote.resetSerial) {
      if (privateMessage.kind && privateMessage.kind !== this.heldKind) this.rouletteUntil = this.time + 1;
      this.heldKind = privateMessage.kind; this.lastPrivate = privateMessage;
      if (privateMessage.reason) { this.nudgeUntil = this.time + 2.5; this.sound.powerup('refuse'); }
    }
    if (local?.combatState === 'eliminated') this.heldKind = null;
    for (const event of events) {
      if (event.resetSerial !== room.resetVote.resetSerial) continue;
      this.sound.powerup(event.effect, event.position, localPosition, local?.movement.facing, event.stage ?? 0);
      if (event.effect === 'explode' || event.effect === 'heal' || event.effect === 'pickup' || event.effect === 'thud' || event.effect === 'armor' || event.effect === 'activate') this.burst(event);
    }
    const world = room.powerups;
    if (world) {
      if (world.waitSeconds !== this.lastWait) { this.waitEstimate = world.waitSeconds; this.lastWait = world.waitSeconds; }
      else if (room.match.status === 'playing') this.waitEstimate = Math.max(0, this.waitEstimate - dt);
      this.box.setEnabled(world.spawned);
      this.box.position.y = 1.05 + (settings.reducedEffects ? 0 : Math.sin(this.time * 2.7) * 0.1);
      this.box.rotation.set(0.09, this.time * 0.65, settings.reducedEffects ? 0 : Math.sin(this.time * 1.8) * 0.06);
      const filled = world.spawned ? 60 : Math.floor((1 - this.waitEstimate / C.powerup.respawnSeconds) * 60);
      this.ring.forEach((m, i) => { m.material = material(this.scene, i < filled ? 'power_gold' : 'power_ring_wait', i < filled ? '#ffcc62' : '#566171', i < filled ? 0.55 : 0.1); });
      this.updateStations(room);
    }
    this.updatePlayers(room, localId, dt);
    this.updateHud(local, room);
    for (const fx of this.bursts) {
      fx.life -= dt; const t = 1 - Math.max(0, fx.life) / fx.duration;
      fx.mesh.scaling.setAll(0.1 + fx.radius * (1 - Math.pow(1 - t, 3)));
      fx.mesh.visibility = (1 - t) * 0.7;
      if (fx.life <= 0) fx.mesh.dispose();
    }
    this.bursts = this.bursts.filter(f => f.life > 0);
  }
  private updateHud(local: PlayerState | undefined, room: RoomState): void {
    const rolling = this.heldKind && this.time < this.rouletteUntil && !settings.reducedEffects;
    const kind = rolling ? kinds[Math.floor(this.time * 16) % kinds.length] : this.heldKind;
    const item = kind ? ITEMS[kind] : null;
    const buffs = local?.movementInternal.buffs;
    const labels = [['SPEED', buffs?.speedSeconds], ['ADRENALINE', buffs?.adrenalineSeconds], ['MAGNET', buffs?.magnetSeconds]] as const;
    const healing = Math.max(0, ...(room.powerups?.stations ?? []).map(s => s.progress[local?.id ?? ''] ?? 0));
    const armor = local?.armorBallIds?.length ?? 0;
    const hint = this.nudgeUntil > this.time ? this.lastPrivate?.reason : item?.hint;
    const html = `<div class="powerup-card ${rolling ? 'rolling' : ''}" style="--power-color:${item?.color ?? '#7c91aa'}"><div class="powerup-icon">${item?.icon ?? '?'}</div><div><b>${item?.name ?? (local?.hasPowerup ? 'MYSTERY ITEM' : 'CONTEST THE CENTER')}</b><small>${escapeHtml(hint ?? 'A mystery power-up spawns every 20s')}</small></div><kbd>G</kbd></div>` +
      `<div class="powerup-buffs">${labels.filter(([, seconds]) => (seconds ?? 0) > 0).map(([label, seconds]) => `<span>${label} <b>${Math.ceil(seconds!)}s</b></span>`).join('')}${armor ? `<span>ARMOR <b>${'●'.repeat(armor)}</b></span>` : ''}${buffs?.cannonLocked ? '<span>STAMINA LOCKED</span>' : ''}</div>` +
      (healing > 0 ? `<div class="heal-progress"><span>HEALING ${Math.min(10, Math.floor(healing))}/10s</span><i style="width:${Math.min(100, healing / C.powerup.healSeconds * 100)}%"></i></div>` : '');
    if (html !== this.lastHtml) { this.hud.innerHTML = html; this.lastHtml = html; }
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
          const tick = attach(MeshBuilder.CreateBox('heal_progress_tick', { width: 0.1, height: 0.025, depth: 0.07 }, this.scene), root, material(this.scene, 'power_green', '#4deb9b', 0.65), new Vector3(Math.sin(angle) * 1.36, 0.027, Math.cos(angle) * 1.36));
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
    const mesh = MeshBuilder.CreateTorus('powerup_pulse', { diameter: 2, thickness: explosion ? 0.07 : 0.03, tessellation: 40 }, this.scene);
    mesh.position.set(event.position.x, Math.max(0.04, event.position.y), event.position.z);
    mesh.material = material(this.scene, explosion ? 'power_explosion' : 'power_green', explosion ? '#ffb06b' : '#4deb9b', 0.65);
    mesh.isPickable = false;
    this.bursts.push({ mesh, duration: explosion ? 0.55 : 0.4, life: explosion ? 0.55 : 0.4, radius: explosion ? C.powerup.blastRadius : 1 });
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
  dispose(): void { this.clearDynamic(); this.root.dispose(); this.hud.remove(); this.neutral.remove(); }
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
