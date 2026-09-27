import { GAME_CONSTANTS as C } from '../../../shared/constants';
import type { PlayerState, PowerupKind } from '../../../shared/types';
import type { PowerupSelectionView, PowerupSlotView } from '../ui/Hud';
import type { PowerupPresentationRoom } from './PowerupPresentation';

export const POWERUP_ITEMS: Record<PowerupKind, { name: string; icon: PowerupKind; color: string; hint: string }> = {
  adrenaline: { name: 'ADRENALINE', icon: 'adrenaline', color: '#ffce65', hint: '6 dash charges · faster recharge · 15s' },
  speed: { name: 'SPEED', icon: 'speed', color: '#75e6ff', hint: '+30% speed · higher jumps · 15s' },
  cannon: { name: 'CANNONBALL', icon: 'cannon', color: '#b9c5d8', hint: 'Hold to full charge for range · weak if released early' },
  heal: { name: 'HEAL STATION', icon: 'heal', color: '#7fffb2', hint: 'Place with throw · stay 10s to heal' },
  magnet: { name: 'BALL MAGNET', icon: 'magnet', color: '#ce9aff', hint: 'Pull loose balls · up to 3 armor · 20s' },
  bomb: { name: 'BOMB BALL', icon: 'bomb', color: '#ffad73', hint: 'First bounce starts a 2s fuse · hits everyone' },
  shock: { name: 'SHOCKWAVE', icon: 'shock', color: '#8ef1ff', hint: `Sticks where it lands · launches players & balls · ×${C.powerup.grenadeCharges}` },
  stun: { name: 'STUN', icon: 'stun', color: '#fff29a', hint: `Sticks where it lands · dazes everyone near it · ×${C.powerup.grenadeCharges}` },
  coachGlasses: { name: 'COACH’S GLASSES', icon: 'coachGlasses', color: '#9aeaff', hint: 'Full-charge court trajectory · 15s' }
};

const PICKUP_BLUE = '#62bdff';
type HandItem = { kind: PowerupKind; hand: 'left' | 'right'; remaining?: number };

interface PowerupHudInput {
  room: PowerupPresentationRoom;
  local?: PlayerState;
  heldKind: PowerupKind | null;
  rolling: boolean;
  rollKind: PowerupKind;
  waitSeconds: number;
  refusal?: string;
}

/** Inventory selection and already active equipment are independent, including throughout a roll. */
export function buildPowerupHudView({ room, local, heldKind, rolling, rollKind, waitSeconds, refusal }: PowerupHudInput): PowerupSlotView | null {
  if (!room.powerups || room.settings.powerupsEnabled === false || local?.combatState === 'eliminated') return null;

  const awaitingIdentity = !!local?.hasPowerup && !heldKind;
  const isRolling = rolling || awaitingIdentity;
  let selection: PowerupSelectionView | undefined;
  if (heldKind || awaitingIdentity) {
    const item = POWERUP_ITEMS[isRolling ? rollKind : heldKind!];
    selection = {
      icon: awaitingIdentity ? 'mystery' : item.icon,
      color: awaitingIdentity ? PICKUP_BLUE : item.color,
      name: isRolling ? 'Power-up' : item.name,
      state: isRolling ? 'rolling' : 'held',
      keybind: isRolling ? '' : 'G'
    };
  }

  const buffs = local?.movementInternal.buffs ?? room.practiceBuffs;
  const armor = local?.armorBallIds?.length ?? room.practiceArmorCount ?? 0;
  const effects: { kind: PowerupKind; label: string; seconds: number; max: number }[] = [];
  if ((buffs?.speedSeconds ?? 0) > 0) effects.push({ kind: 'speed', label: 'Speed', seconds: buffs!.speedSeconds, max: C.powerup.buffSeconds });
  if ((buffs?.adrenalineSeconds ?? 0) > 0) effects.push({ kind: 'adrenaline', label: 'Adrenaline', seconds: buffs!.adrenalineSeconds, max: C.powerup.buffSeconds });
  if ((buffs?.magnetSeconds ?? 0) > 0) effects.push({ kind: 'magnet', label: 'Magnet', seconds: buffs!.magnetSeconds, max: C.powerup.magnetSeconds });
  if ((buffs?.coachGlassesSeconds ?? 0) > 0) effects.unshift({ kind: 'coachGlasses', label: 'Glasses', seconds: buffs!.coachGlassesSeconds!, max: C.powerup.buffSeconds });
  const effectText = effects.map(effect => `${effect.label} ${Math.ceil(effect.seconds)}s`)
    .concat(armor > 0 ? [`Armor ${armor}/${C.powerup.armorCap}`] : [])
    .join(' · ');
  const handItems: HandItem[] = local
    ? (['left', 'right'] as const).flatMap(hand => {
      const ball = room.balls[local.hands[hand].heldBallId ?? ''];
      if (!ball?.kind || ball.kind === 'normal') return [];
      return [{ kind: ball.kind, hand, remaining: ball.kind === 'shock' || ball.kind === 'stun' ? 1 + (local.pendingGrenades ?? 0) : undefined }];
    })
    : room.practiceHandItems ?? (room.practiceGrenade ? [room.practiceGrenade] : []);
  const handItem = handItems[0];
  const progressPlayerId = local?.id ?? room.practicePlayerId ?? '';
  const healing = Math.max(0, ...room.powerups.stations.map(station => station.progress[progressPlayerId] ?? 0));
  let view: PowerupSlotView;

  if (handItem) {
    const item = POWERUP_ITEMS[handItem.kind];
    const grenades = handItem.kind === 'shock' || handItem.kind === 'stun';
    const remaining = Math.max(1, handItem.remaining ?? 1);
    const extraHandText = handItems.slice(1).map(other => `${POWERUP_ITEMS[other.kind].name} ${other.hand === 'left' ? 'M1' : 'M2'}`).join(' · ');
    view = {
      glyph: '', icon: item.icon, color: item.color, name: item.name,
      hint: [grenades ? `${remaining} throw${remaining === 1 ? '' : 's'} left` : item.hint, extraHandText, effectText].filter(Boolean).join(' · '),
      progress: grenades ? remaining / C.powerup.grenadeCharges : 1,
      state: 'held', keybind: handItem.hand === 'left' ? 'M1' : 'M2'
    };
  } else if (effects.length > 0 || armor > 0 || buffs?.cannonLocked) {
    const lead = effects[0];
    const item = POWERUP_ITEMS[lead?.kind ?? (armor > 0 ? 'magnet' : 'cannon')];
    view = {
      glyph: '', icon: lead ? item.icon : armor > 0 ? 'armor' : item.icon,
      color: item.color, name: lead ? item.name : armor > 0 ? 'ARMOR' : item.name,
      hint: effectText || 'Stamina locked', progress: lead ? lead.seconds / lead.max : 1,
      state: 'active', expiring: effects.some(effect => effect.seconds <= 3), keybind: ''
    };
  } else if (healing > 0) {
    const item = POWERUP_ITEMS.heal;
    view = {
      glyph: '', icon: item.icon, color: item.color, name: 'Healing',
      hint: `Stay put · ${Math.min(C.powerup.healSeconds, Math.floor(healing))}/${C.powerup.healSeconds}s`,
      progress: healing / C.powerup.healSeconds, state: 'active', keybind: ''
    };
  } else if (selection) {
    view = {
      glyph: '', icon: selection.icon, hideMainIcon: true, color: selection.color, name: selection.name,
      hint: isRolling ? '' : POWERUP_ITEMS[heldKind!].hint, progress: 1,
      state: selection.state, keybind: ''
    };
  } else if (room.powerups.spawns.some(spawn => spawn.spawned)) {
    const available = room.powerups.spawns.find(spawn => spawn.spawned);
    const fixed = available?.kind ? POWERUP_ITEMS[available.kind] : null;
    view = {
      glyph: '', icon: fixed?.icon ?? 'mystery', color: fixed?.color ?? PICKUP_BLUE,
      name: fixed?.name ?? 'Center court', hint: 'Power-up available', progress: 1,
      state: 'empty', keybind: ''
    };
  } else {
    if (waitSeconds > 10) return null;
    view = { glyph: '', icon: 'mystery', color: PICKUP_BLUE, name: 'Center court', hint: `Power-up in ${Math.ceil(waitSeconds)}s`, progress: 1 - waitSeconds / C.powerup.respawnSeconds, state: 'waiting', keybind: '' };
  }

  if (selection) view.selection = selection;
  if (isRolling) view.rolling = true;
  if (!isRolling && refusal) view.hint = refusal;
  return view;
}
