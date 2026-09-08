import { describe, expect, it } from 'vitest';
import { toWireInput } from '../../shared/protocol';
import type { PlayerInput } from '../../shared/types';
import { canonicalizeRoomSettings, recommendedRoomSettings } from '../../shared/roomSettings';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

function baseInput(): PlayerInput {
  return {
    sequence: 0, clientTimeMs: 0, moveX: 0, moveZ: 0,
    dashDirection: { x: 0, y: 0, z: 0 },
    lookYawRadians: 0, lookPitchRadians: 0,
    jumpPressed: false, jumpHeld: false, dashPressed: false,
    crouchPressed: false, crouchHeld: false, slidePressed: false, slideHeld: false,
    backflipPressed: false, pickupPressed: false, dropPressed: false,
    fakeThrowPressed: false, fakeThrowHeld: false,
    leftHandPressed: false, leftHandHeld: false, rightHandPressed: false, rightHandHeld: false,
    leftHandReleased: false, rightHandReleased: false,
    leftCatchAttemptId: 0, rightCatchAttemptId: 0, backflipThrowTier: 0,
    resetSerial: 0, interactHeld: false
  };
}

/**
 * Models the real client's input stream: DELTA-encoded wire packets (toWireInput), a sequence that
 * restarts at 0 whenever the observed resetSerial changes (ArenaScene.detectServerReset →
 * resetPrediction), and one-way latency in both directions so pre-reset packets are still in flight
 * when the reset lands.
 */
class FakeClient {
  seq = 0;
  private seenResetSerial = -1;
  private lastSent: PlayerInput | undefined;
  private uplink: { arriveTick: number; seq: number; wire: Partial<PlayerInput> }[] = [];
  private downlink: { arriveTick: number; resetSerial: number }[] = [];

  constructor(
    readonly id: string,
    readonly loop: ServerGameLoop,
    readonly latencyTicks: number,
    /** A pre-resetSerial client never puts the field on the wire at all. */
    readonly sendsResetSerial = true
  ) {}

  observe(tick: number): void {
    this.downlink.push({ arriveTick: tick + this.latencyTicks, resetSerial: this.loop.state.resetVote.resetSerial });
    while (this.downlink.length > 0 && this.downlink[0].arriveTick <= tick) {
      const { resetSerial } = this.downlink.shift()!;
      if (this.seenResetSerial < 0) { this.seenResetSerial = resetSerial; continue; }
      if (resetSerial === this.seenResetSerial) continue;
      this.seenResetSerial = resetSerial;
      this.seq = 0;              // resetPrediction restarts the sequence...
      this.lastSent = undefined; // ...and rebases the delta encoder on a neutral input
    }
  }

  /** One-shot edge (dash / backflip) to fold into the next packet, as the client's latches do. */
  private pendingEdge: 'dash' | 'backflip' | null = null;
  press(edge: 'dash' | 'backflip'): void { this.pendingEdge = edge; }

  send(tick: number, moveZ: number): void {
    this.seq += 1;
    const edge = this.pendingEdge;
    this.pendingEdge = null;
    const input: PlayerInput = {
      ...baseInput(), sequence: this.seq, clientTimeMs: tick, moveZ,
      dashPressed: edge === 'dash',
      dashDirection: edge === 'dash' ? { x: 0, y: 0, z: 1 } : { x: 0, y: 0, z: 0 },
      backflipPressed: edge === 'backflip',
      resetSerial: Math.max(0, this.seenResetSerial)
    };
    const wire = toWireInput(input, this.lastSent ?? baseInput()) as Partial<PlayerInput>;
    this.lastSent = input;
    if (!this.sendsResetSerial) delete wire.resetSerial;
    this.uplink.push({ arriveTick: tick + this.latencyTicks, seq: this.seq, wire });
  }

  deliver(tick: number): void {
    while (this.uplink.length > 0 && this.uplink[0].arriveTick <= tick) {
      const packet = this.uplink.shift()!;
      this.loop.handleInput(this.id, packet.wire, packet.seq);
    }
  }
}

function playRoundThenReset(
  sendsResetSerial: boolean,
  format: '1v1' | '2v2' = '1v1'
): { movedZ: number; clientSeq: number; ack: number; dashSpent: boolean; backflipFired: boolean } {
  const loop = new ServerGameLoop('room', {
    settings: canonicalizeRoomSettings(recommendedRoomSettings(format))
  });
  const ids = format === '2v2' ? ['a', 'b', 'c', 'd'] : ['a', 'b'];
  for (const id of ids) loop.addPlayer(id, id.toUpperCase());
  const clients = ids.map((id) => new FakeClient(id, loop, 8, sendsResetSerial));
  let tick = 0;
  const run = (frames: number, moveZ = 1) => {
    for (let i = 0; i < frames; i += 1) {
      for (const c of clients) { c.observe(tick); c.send(tick, moveZ); c.deliver(tick); }
      loop.step();
      tick += 1;
    }
  };

  for (const id of ids) loop.handleStartVote(id);
  run(1400, 0); // countdown + a live round spent idle, so the sequence climbs well past zero
  expect(loop.state.match.status).toBe('playing');

  for (const id of ids) loop.handleReset(id);
  expect(loop.state.match.status).toBe('countdown');

  run(700, 0); // drain the pre-round countdown
  expect(loop.state.match.status).toBe('playing');

  const before = { ...loop.state.players.a.movement.position };
  run(128); // one second of holding forward
  const movedZ = Math.abs(loop.state.players.a.movement.position.z - before.z);

  // The two symptoms that ride the same input stream: dash charges ("stamina") and backflips.
  const chargesBefore = loop.state.players.a.dash.charges;
  clients[0].press('dash');
  run(24, 0); // must exceed the 8-tick one-way latency before the edge lands
  const dashSpent = loop.state.players.a.dash.charges < chargesBefore;

  clients[0].press('backflip');
  let backflipFired = false;
  for (let i = 0; i < 24 && !backflipFired; i += 1) {
    run(1, 0);
    backflipFired ||= loop.state.players.a.movementInternal.backflipActive;
  }

  return {
    movedZ,
    clientSeq: clients[0].seq,
    ack: loop.state.players.a.lastProcessedInputSeq,
    dashSpent,
    backflipFired
  };
}

describe('input stream across a room reset', () => {
  // Regression: resetSerial is delta-compressed, so the pre-reset packets still in flight when a
  // reset lands carry NO resetSerial and used to slip past the stale-timeline gate. They pushed the
  // server's sequence cursor to a stale-high value, after which every fresh post-reset input was
  // dropped as a "duplicate" while the server kept acking the stale seq — so the client's reconcile
  // discarded all pending inputs and snapped it back to spawn on every snapshot. Players were stuck
  // (no movement, no backflip, no stamina drain) until their counter climbed past the stale value.
  it.each(['1v1', '2v2'] as const)('players can move again once the post-reset countdown ends (%s)', (format) => {
    const { movedZ, clientSeq, ack, dashSpent, backflipFired } = playRoundThenReset(true, format);
    expect(movedZ).toBeGreaterThan(1);
    expect(ack).toBeLessThanOrEqual(clientSeq);
    // Reported alongside the freeze: stamina (dash charges) and backflips were dead too, because
    // the server was discarding the whole input stream rather than just the movement in it.
    expect(dashSpent).toBe(true);
    expect(backflipFired).toBe(true);
  });

  it('recovers even from a client that never puts resetSerial on the wire', () => {
    const { movedZ, clientSeq, ack } = playRoundThenReset(false);
    expect(movedZ).toBeGreaterThan(1);
    expect(ack).toBeLessThanOrEqual(clientSeq);
  });
});
