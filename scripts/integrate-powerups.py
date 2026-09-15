from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
p='server/src/simulation/ServerGameLoop.ts'
edit(p,"import { facingFromAngles, stepMovement }", "import { PowerupSystem } from './PowerupSystem';\nimport { facingFromAngles, stepMovement }")
edit(p,'  private stepNowMs = 0;','  private stepNowMs = 0;\n  private readonly powerupSystem = new PowerupSystem();\n  private applyingExplosion = false;\n  drainPowerupEvents() { return this.powerupSystem.drain(); }\n  powerupIdentity(playerId: string) { return this.powerupSystem.identity(this.state, playerId); }')
edit(p,'this.state = this.createFreshRoomState();','this.state = this.createFreshRoomState();\n    this.powerupSystem.reset(this.state);')
edit(p,'this.state = this.createFreshRoomState(players, this.state.tick);','this.state = this.createFreshRoomState(players, this.state.tick);\n    this.powerupSystem.reset(this.state);')
edit(p,'  private startRoundWorld(): void {','  private startRoundWorld(): void {\n    this.powerupSystem.reset(this.state);')
edit(p,'    const preVelocity = player.movement.velocity;\n    const preGrounded', '    this.powerupSystem.syncLock(this.state, player);\n    const preVelocity = player.movement.velocity;\n    const preGrounded')
edit(p,'    this.handleInputThrows(player.id, input);','    if (input.activatePowerupPressed) this.powerupSystem.activate(this.state, player.id);\n    this.handleInputThrows(player.id, input);')
edit(p,'    this.updateBalls(fixedDt, active);','''    if (active) this.powerupSystem.beforeBalls(this.state, fixedDt, this.matchSettings.livesPerPlayer);
    this.updateBalls(fixedDt, active);
    if (active) {
      this.applyingExplosion = true;
      this.powerupSystem.afterBalls(this.state, fixedDt, (ball, target) => {
        if (this.powerupSystem.absorb(this.state, target)) return;
        const throwerId = ball.bombThrowerId ?? ball.lastTouchedByPlayerId ?? target.id;
        const scorer = this.state.players[throwerId];
        if (!scorer) return;
        this.applyPlayerHit(throwerId, target, { ...scorer.dash }, { direct: false, bounce: true, curve: false, backflip: false });
        this.pendingCombatEvents.push({ type: 'hit-event', ballId: ball.id, throwerId, targetId: target.id, serverTick: this.state.tick, serverTimeMs: this.stepNowMs });
      });
      this.applyingExplosion = false;
      this.resolveRoundOutcome();
    }''')
# defer victory until every explosion victim has been damaged; self-hits must mutate the live object
edit(p,'this.state.players[throwerId] = { ...scorer, dash: grantDashCharge(scorer.dash) };','scorer.dash = grantDashCharge(scorer.dash);')
edit(p,'    this.resolveRoundOutcome();\n\n    return {\n      kind:', '    if (!this.applyingExplosion) this.resolveRoundOutcome();\n\n    return {\n      kind:')
edit(p,'    // Charge is taken from the SERVER-tracked hand state', '''    if (ball.kind === 'heal') {
      return this.powerupSystem.place(this.state, player, request.hand, this.ballCollisionBoxes)
        ? { ok: true } : { ok: false, reason: 'invalid-placement' };
    }
    // Charge is taken from the SERVER-tracked hand state''')
# cannon bypass normal charge/double-throw modifiers
edit(p,"if (priorBall && priorBall.phase === 'live'", "if (priorBall && priorBall.kind !== 'cannon' && priorBall.phase === 'live'")
edit(p,'    const { velocity: rawVelocity, curveAccel, dropScale, isSuper } = throwCalc;','''    if (ball.kind === 'cannon') {
      throwCalc.velocity = scale(forward, GAME_CONSTANTS.ball.chargedThrowSpeed);
      throwCalc.curveAccel = vec3(); throwCalc.dropScale = 1; throwCalc.isSuper = false;
    }
    const { velocity: rawVelocity, curveAccel, dropScale, isSuper } = throwCalc;''')
edit(p,'const velocity = isDoubleThrow ? scale(rawVelocity','const velocity = isDoubleThrow && ball.kind !== \'cannon\' ? scale(rawVelocity')
edit(p,'    this.state.balls[ball.id] = result.ball;\n\n    // Attach backflip','    this.state.balls[ball.id] = result.ball;\n    this.powerupSystem.thrown(this.state, result.ball, playerId);\n\n    // Attach backflip')
edit(p,'    const tier = input.backflipThrowTier;','''    for (const hand of ['left', 'right'] as const) {
      const ball = this.state.balls[this.state.players[playerId]?.hands[hand].heldBallId ?? ''];
      if ((ball?.kind === 'cannon' || ball?.kind === 'heal') && (hand === 'left' ? input.leftHandPressed : input.rightHandPressed)) this.handleThrow(playerId, { hand });
    }
    const tier = input.backflipThrowTier;''')
edit(p,"      if (ball.phase === 'loose') continue;","      if (ball.phase === 'loose' || ball.phase === 'armor') continue;")
edit(p,'        if (combatActive && isBallCatchableInFlight(resolved)) {','''        if (combatActive && resolved.kind === 'cannon') {
          this.tryHit(resolved, prevPos, resolved.position);
        } else if (combatActive && isBallCatchableInFlight(resolved)) {''')
edit(p,'        current = settleBallIfSlow(collided);','''        if (collided.bounceCount > current.bounceCount) this.powerupSystem.contact(this.state, collided, this.stepNowMs);
        current = settleBallIfSlow(collided);
        if (current.kind === 'cannon' && current.bounceCount > 0) { current = markBallDead(current); combatDone = true; }''')
# radius only inside tryHit
start=Path(p).read_text(); idx=start.index('  private tryHit('); end=start.index('  private tryFriendlyDeflect',idx)
a=start[idx:end];b=a.replace('const radius = playerBallHitRadius();',"const radius = playerBallHitRadius() + (ball.kind === 'cannon' ? GAME_CONSTANTS.ball.radius * (GAME_CONSTANTS.powerup.cannonFlightScale - 1) : 0);")
b=b.replace("      const backflipTier =", "      if (ball.kind === 'cannon' && !this.powerupSystem.cannonCanHit(ball, target.id)) continue;\n      if (this.powerupSystem.absorb(this.state, target)) { this.powerupSystem.contact(this.state, ball, this.stepNowMs); return markBallDead(ball, scale(ball.velocity, -0.35)); }\n      const backflipTier =")
b=b.replace('      const dead = markBallDead(ball);',"      const dead = markBallDead(ball);\n      this.powerupSystem.contact(this.state, dead, this.stepNowMs);")
b=b.replace('      if (recentHit) {',"      if (recentHit && ball.kind !== 'cannon') {")
b=b.replace('      return dead;',"      if (ball.kind !== 'cannon') return dead;")
edit(p,a,b)
edit(p,"  private tryAutoParry(ball: BallState, segPrev: Vec3, segCurr: Vec3, _dt: number, tickStartMs: number): BallState | null {", "  private tryAutoParry(ball: BallState, segPrev: Vec3, segCurr: Vec3, _dt: number, tickStartMs: number): BallState | null {\n    if (ball.kind === 'cannon' || ball.armedAtMs !== undefined) return null;")
edit(p,"  private tryFriendlyDeflect(ball: BallState, segPrev: Vec3, segCurr: Vec3): BallState | null {", "  private tryFriendlyDeflect(ball: BallState, segPrev: Vec3, segCurr: Vec3): BallState | null {\n    if (ball.kind === 'cannon') return null;")
edit(p,'      const deflected = deflectBall(ball, target.id, away, GAME_CONSTANTS, this.throwCounter);','      const deflected = deflectBall(ball, target.id, away, GAME_CONSTANTS, this.throwCounter);\n      this.powerupSystem.contact(this.state, deflected, this.stepNowMs);')
edit(p,'    const caught = catchBall(present, defenderId, hand);', '''    const caught = catchBall(present, defenderId, hand);
    if (reclaim && caught.kind === 'bomb') { delete caught.armedAtMs; delete caught.fuseSeconds; }''')
# radii world collision
edit(p,'  const r = GAME_CONSTANTS.ball.radius;',"  const r = GAME_CONSTANTS.ball.radius * (ball.kind === 'cannon' && ball.phase !== 'held' ? GAME_CONSTANTS.powerup.cannonFlightScale : 1);")
edit(p,'    backflipPressed: Boolean(input.backflipPressed)', '    activatePowerupPressed: Boolean(input.activatePowerupPressed),\n    backflipPressed: Boolean(input.backflipPressed)')
# coalescing retains powerup edge
edit(p,'    backflipPressed: false,','    activatePowerupPressed: false,\n    backflipPressed: false,')
p='shared/simulation/HandSim.ts'
edit(p,"'phase' | 'isSuper' | 'ownerId'>","'phase' | 'isSuper' | 'ownerId' | 'kind' | 'armedAtMs'>")
edit(p,"'phase' | 'velocity' | 'bounceCount' | 'ownerId'>","'phase' | 'velocity' | 'bounceCount' | 'ownerId' | 'kind' | 'armedAtMs'>")
edit(p,"if (ball.phase !== 'live') return { ok: false, reason: 'not-live' };","if (ball.phase !== 'live' || ball.kind === 'cannon' || ball.armedAtMs !== undefined) return { ok: false, reason: 'not-live' };")
edit(p,"if (request.ball.phase !== 'live') return 'ball-not-live';","if (request.ball.phase !== 'live' || request.ball.kind === 'cannon' || request.ball.armedAtMs !== undefined) return 'ball-not-live';")
p='server/src/rooms/DuelRoom.ts'
edit(p,'    const throwEvents = this.game.drainThrowEvents();','''    const powerups = this.game.drainPowerupEvents();
    for (const event of powerups.events) this.broadcast('powerup-event', event);
    for (const { playerId, message } of powerups.privateMessages) this.clients.find(c => c.sessionId === playerId)?.send('powerup-private', message);
    const throwEvents = this.game.drainThrowEvents();''')
edit(p,'    this.sendBattleMusicSync(client);', "    this.sendBattleMusicSync(client);\n    client.send('powerup-private', this.game.powerupIdentity(client.sessionId));")
p='src/game/map/GymArena.ts'
s=Path(p).read_text(); a=s[s.index('    // Bold center stripe'):s.index('\n  /**',s.index('    // Bold center stripe'))]
b='''    const depth = GAME_CONSTANTS.match.neutralZoneHalfDepth;
    for (const sign of [-1, 1]) {
      const line = this.loader.createVisual('line', {
        name: `neutral_edge_${sign}`,
        size: { width: halfW * 2, height: 0.018, depth: 0.16 },
        position: new Vector3(0, lineY, sign * depth)
      });
      line.material = this.courtLineCenterMat;
    }
    const band = MeshBuilder.CreateGround('neutral_zone_band', { width: halfW * 2, height: depth * 2 }, this.scene);
    band.position.y = 0.006; band.isPickable = false;
    const mat = new StandardMaterial('neutral_band_mat', this.scene);
    mat.diffuseColor = new Color3(0.14, 0.65, 0.68); mat.emissiveColor = new Color3(0.015, 0.06, 0.065);
    mat.alpha = 0.16; mat.specularColor = Color3.Black(); band.material = mat;
  }
'''
edit(p,a,b)
if 'import { GAME_CONSTANTS }' not in s: edit(p,"import {", "import {",) # checked import below
edit(p,'const rowZ = 0.62;', 'const rowZ = GAME_CONSTANTS.match.neutralZoneHalfDepth + 0.25;')
edit(p,'const coneXs = [-11.2, -8.4, -5.6, -2.8, 0, 2.8, 5.6, 8.4, 11.2];','const coneXs = [-11.2, -8.4, -5.6, -2.8, 0, 2.8, 5.6, 8.4, 11.2].map(x => x / 13 * TUNING.map.halfWidth);')
p='src/game/map/GymVisualRevamp.ts'
edit(p,'for (const z of [-12, -4, 4, 12])', 'for (const z of [-12, -4, 4, 12].map(z => z / 18 * TUNING.map.halfLength))')
