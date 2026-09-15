from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
edit('shared/constants.ts','halfCourtLineZ: 0.25,','neutralZoneHalfDepth: 3,\n    halfCourtLineZ: 3, // Legacy alias for rules consumers.')
edit('shared/constants.ts','halfWidth: 13,','halfWidth: 14.5,')
edit('shared/constants.ts','halfLength: 18,','halfLength: 20,')
edit('shared/constants.ts','  map: {','  powerup: {\n    respawnSeconds: 20, pickupRadius: 1.2, buffSeconds: 15,\n    speedMultiplier: 1.3, jumpHeightMultiplier: 1.25,\n    adrenalineMaxCharges: 6, adrenalineRechargeSeconds: 2,\n    cannonHeldScale: 2, cannonFlightScale: 5,\n    bombFuseSeconds: 2, blastRadius: 3,\n    magnetSeconds: 20, magnetRadius: 10, magnetAcceleration: 28, magnetSpeed: 7,\n    distantMagnetAcceleration: 5, distantMagnetSpeed: 2, stationarySeconds: 3, armorCap: 3,\n    healRadius: 1.5, healSeconds: 10, stationLifetimeSeconds: 45, placementDistance: 1.5\n  },\n\n  map: {')
edit('shared/simulation/RuleSim.ts','constants.match.halfCourtLineZ','constants.match.neutralZoneHalfDepth')
p='shared/simulation/MapGeometry.ts'
for n in ['-4.5','4.5']: edit(p,'x: '+n+',','x: '+n+' / 13 * GAME_CONSTANTS.map.halfWidth,')
for n in ['-5.5','5.5']: edit(p,'z: '+n+',','z: '+n+' / 18 * GAME_CONSTANTS.map.halfLength,')
p='server/src/simulation/ServerGameLoop.ts'
edit(p,'vec3(0, 0, -12)','vec3(0, 0, -12 / 18 * GAME_CONSTANTS.map.halfLength)')
edit(p,'vec3(0, 0, 12)','vec3(0, 0, 12 / 18 * GAME_CONSTANTS.map.halfLength)')
p='shared/types.ts'
edit(p,"export type BallPhase =", "export type PowerupKind = 'adrenaline' | 'speed' | 'cannon' | 'heal' | 'magnet' | 'bomb';\nexport interface PowerupBuffs { speedSeconds: number; adrenalineSeconds: number; magnetSeconds: number; cannonLocked: boolean }\nexport interface HealStationState { id: string; placerId: string; teamId: string; position: Vec3; remainingSeconds: number; progress: Record<string, number> }\nexport interface PowerupWorldState { spawned: boolean; waitSeconds: number; stations: HealStationState[] }\n\nexport type BallPhase =")
edit(p,"'loose' | 'held' | 'live' | 'dead' | 'deflected'","'loose' | 'held' | 'live' | 'dead' | 'deflected' | 'armor'")
edit(p,'export interface MovementInternalState {','export interface MovementInternalState {\n  buffs?: PowerupBuffs;')
edit(p,'export interface PlayerState {','export interface PlayerState {\n  hasPowerup?: boolean;\n  armorBallIds?: string[];')
edit(p,'export interface BallState {',"export interface BallState {\n  kind?: 'normal' | 'cannon' | 'bomb' | 'heal';\n  armedAtMs?: number;\n  fuseSeconds?: number;\n  bombThrowerId?: string;\n  settledSeconds?: number;\n  armorPlayerId?: string;")
edit(p,'export interface PlayerInput {','export interface PlayerInput {\n  activatePowerupPressed?: boolean;')
edit(p,'export interface RoomState {','export interface RoomState {\n  powerups?: PowerupWorldState;')
p='shared/protocol.ts'
edit(p,"  copyEdgeInputField(wire, input, previous, 'jumpPressed');","  copyEdgeInputField(wire, input, previous, 'activatePowerupPressed');\n  copyEdgeInputField(wire, input, previous, 'jumpPressed');")
s=Path(p).read_text(); s += '''\n/** Identity is sent on a targeted message, never in RoomState. */
export interface PowerupPrivateMessage { kind: import('./types').PowerupKind | null; resetSerial: number; reason?: string }
export interface PowerupEvent { type: 'powerup-event'; effect: 'spawn' | 'pickup' | 'activate' | 'cannon' | 'thud' | 'beep' | 'explode' | 'heal' | 'armor' | 'place'; position: Vec3; playerId?: string; kind?: import('./types').PowerupKind; stage?: number; resetSerial: number }
''';Path(p).write_text(s)
p='shared/simulation/MovementSim.ts'
edit(p,'  let vx = movementIn.velocity.x;', '''  const buffs = internalIn.buffs;
  const speedBuff = (buffs?.speedSeconds ?? 0) > 0 ? c.powerup.speedMultiplier : 1;
  const staminaLocked = buffs?.cannonLocked ?? false;
  if ((buffs?.adrenalineSeconds ?? 0) > 0) c = { ...c, dash: { ...c.dash, maxCharges: c.powerup.adrenalineMaxCharges, rechargeSeconds: c.powerup.adrenalineRechargeSeconds } } as GameConstants;
  let vx = movementIn.velocity.x;''')
edit(p,'vy = c.player.jumpSpeed;','vy = c.player.jumpSpeed * (speedBuff > 1 ? Math.sqrt(c.powerup.jumpHeightMultiplier) : 1);')
edit(p,'} else if (doubleJumpAvailable) {','} else if (doubleJumpAvailable && !staminaLocked) {')
edit(p,'if (dashPressed) {','if (dashPressed && !staminaLocked) {')
edit(p,'if (backflipPressed && !backflipActive','if (backflipPressed && !staminaLocked && !backflipActive')
edit(p,'c.player.maxGroundSpeed * speedMultiplier * speedScale','c.player.maxGroundSpeed * speedMultiplier * speedScale * speedBuff')
edit(p,'groundWishSpeed, c.player.groundAcceleration, dt','groundWishSpeed, c.player.groundAcceleration * speedBuff, dt')
edit(p,'    internal: {','''    internal: {
      ...(buffs ? { buffs: { ...buffs, speedSeconds: Math.max(0, buffs.speedSeconds - dt), adrenalineSeconds: Math.max(0, buffs.adrenalineSeconds - dt), magnetSeconds: Math.max(0, buffs.magnetSeconds - dt) } } : {}),''')
p='shared/snapshotCodec.ts'
edit(p,'    player.lastProcessedInputSeq\n','    player.lastProcessedInputSeq,\n    [player.hasPowerup ?? false, player.armorBallIds ?? []]\n')
edit(p,'    lastProcessedInputSeq: packed[27] as number','    lastProcessedInputSeq: packed[27] as number,\n    ...unpackPowerupPlayer(packed[28])')
edit(p,'    lastProcessedInputSeq: packed[21] as number','    lastProcessedInputSeq: packed[21] as number,\n    ...unpackPowerupPlayer(packed[22])')
edit(p,'    pq3(movementInternal.backflipCooldown)\n','    pq3(movementInternal.backflipCooldown),\n    movementInternal.buffs ?? null\n')
edit(p,'    slideTimer: uq3(movementInternal[0]),','    ...(movementInternal[14] ? { buffs: movementInternal[14] as PlayerState[\'movementInternal\'][\'buffs\'] } : {}),\n    slideTimer: uq3(movementInternal[0]),')
edit(p,'    ball.throwId\n','    ball.throwId,\n    [ball.kind ?? "normal", ball.armedAtMs ?? null, ball.fuseSeconds ?? null, ball.armorPlayerId ?? null]\n')
edit(p,'    throwId: packed[13] as number','    throwId: packed[13] as number,\n    ...unpackSpecialBall(packed[14])')
s=Path(p).read_text();s+='''
function unpackPowerupPlayer(value: unknown): Partial<PlayerState> {
  if (!Array.isArray(value)) return {};
  return { hasPowerup: Boolean(value[0]), armorBallIds: value[1] as string[] };
}
function unpackSpecialBall(value: unknown): Partial<BallState> {
  if (!Array.isArray(value)) return {};
  return { kind: value[0] as BallState['kind'], ...(value[1] !== null ? {armedAtMs: value[1]} : {}), ...(value[2] !== null ? {fuseSeconds: value[2]} : {}), ...(value[3] !== null ? {armorPlayerId: value[3]} : {}) };
}
''';Path(p).write_text(s)
p='shared/simulation/BallSim.ts'
edit(p,"  ball: Pick<BallState, 'phase' | 'velocity'> | { phase: BallPhase | string; velocity: Vec3 },","  ball: Pick<BallState, 'phase' | 'velocity' | 'kind'> | { phase: BallPhase | string; velocity: Vec3; kind?: BallState['kind'] },")
edit(p,"  if (ball.phase === 'held') return false;","  if (ball.phase === 'held' || ball.phase === 'armor' || ball.kind === 'cannon' || ball.kind === 'heal') return false;")
edit(p,"Pick<BallState, 'phase' | 'velocity' | 'bounceCount'>","Pick<BallState, 'phase' | 'velocity' | 'bounceCount' | 'kind' | 'armedAtMs'>")
edit(p,"  if (ball.phase === 'live' || ball.phase === 'deflected') return true;","  if (ball.kind === 'cannon' || ball.kind === 'heal' || ball.armedAtMs !== undefined) return false;\n  if (ball.phase === 'live' || ball.phase === 'deflected') return true;")
edit(p,"Pick<BallState, 'phase' | 'position' | 'velocity'>","Pick<BallState, 'phase' | 'position' | 'velocity' | 'kind'>")
