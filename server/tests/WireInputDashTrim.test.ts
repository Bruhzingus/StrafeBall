import { describe, expect, it } from 'vitest';
import { toWireInput, type WireInput } from '../../shared/protocol';
import type { PlayerInput, Vec3 } from '../../shared/types';
import { ServerGameLoop } from '../src/simulation/ServerGameLoop';

/**
 * Tests for the input-packet bloat trim: the client omits `dashDirection` from the wire when it is
 * a zero vector (every non-dash tick, plus a dash with no movement keys). These tests prove the
 * trim is gameplay-neutral end-to-end — encode via toWireInput, feed the trimmed object through the
 * real server input path (handleInput → normalizeInput → advance → stepMovement), and assert the
 * authoritative result is IDENTICAL to sending the full input. The dangerous case is a stale dash
 * direction leaking from an earlier dash into a later trimmed dash tick; that has its own test.
 */

function fullInput(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    sequence: 0,
    clientTimeMs: 0,
    moveX: 0,
    moveZ: 0,
    dashDirection: { x: 0, y: 0, z: 0 },
    lookYawRadians: 0,
    lookPitchRadians: 0,
    jumpPressed: false,
    jumpHeld: false,
    dashPressed: false,
    crouchPressed: false,
    crouchHeld: false,
    slidePressed: false,
    slideHeld: false,
    backflipPressed: false,
    pickupPressed: false,
    dropPressed: false,
    fakeThrowPressed: false,
    fakeThrowHeld: false,
    leftHandPressed: false,
    leftHandHeld: false,
    rightHandPressed: false,
    rightHandHeld: false,
    leftHandReleased: false,
    rightHandReleased: false,
    leftCatchAttemptId: 0,
    rightCatchAttemptId: 0,
    backflipThrowTier: 0,
    resetSerial: 0,
    interactHeld: false,
    ...overrides
  };
}

/** The horizontal (x,z) velocity a player has after submitting `input` for one advanced tick. */
function velocityAfterInput(input: PlayerInput | WireInput, seq: number): Vec3 {
  const loop = new ServerGameLoop('room');
  loop.addPlayer('a', 'A');
  loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
  loop.state.players.a.movement.position = { x: 0, y: 0, z: 0 };
  loop.state.players.a.movement.velocity = { x: 0, y: 0, z: 0 };
  loop.handleInput('a', input as Partial<PlayerInput>, seq);
  loop.advance();
  return { ...loop.state.players.a.movement.velocity };
}

function horizontalDir(v: Vec3): { x: number; z: number } {
  const len = Math.hypot(v.x, v.z);
  if (len < 1e-6) return { x: 0, z: 0 };
  return { x: v.x / len, z: v.z / len };
}

describe('toWireInput', () => {
  it('omits dashDirection when it is a zero vector', () => {
    const wire = toWireInput(fullInput({ moveX: 1 }));
    expect('dashDirection' in wire).toBe(false);
  });

  it('keeps dashDirection when it is non-zero', () => {
    const dir = { x: 1, y: 0, z: 0 };
    const wire = toWireInput(fullInput({ dashPressed: true, dashDirection: dir }));
    expect(wire.dashDirection).toEqual(dir);
  });

  it('omits a sub-EPS dashDirection (treated as zero)', () => {
    const wire = toWireInput(fullInput({ dashDirection: { x: 0.0005, y: 0, z: 0.0005 } }));
    expect('dashDirection' in wire).toBe(false);
  });

  it('leaves gameplay fields untouched in conservative mode', () => {
    const input = fullInput({ moveX: 1, moveZ: -1, jumpPressed: true, sequence: 7, clientTimeMs: 123, lookYawRadians: 1.2 });
    const wire = toWireInput(input);
    const { dashDirection: _dash, sequence: _seq, clientTimeMs: _time, ...rest } = input;
    expect(wire).toEqual(rest);
  });

  it('omits unchanged fields when encoded against the previous input', () => {
    const previous = fullInput({
      moveX: 1,
      leftHandHeld: true,
      lookYawRadians: 0.5,
      lookPitchRadians: -0.1,
      sequence: 10,
      clientTimeMs: 1000
    });
    const current = fullInput({
      moveX: 1,
      leftHandHeld: false,
      lookYawRadians: 0.5,
      lookPitchRadians: -0.1,
      sequence: 11,
      clientTimeMs: 1010
    });
    expect(toWireInput(current, previous)).toEqual({
      lookYawRadians: 0.5,
      lookPitchRadians: -0.1,
      leftHandHeld: false
    });
  });

  it('keeps latched catch ids even when unchanged so they resend until acked', () => {
    const previous = fullInput({ leftCatchAttemptId: 3, lookYawRadians: 0.1 });
    const current = fullInput({ leftCatchAttemptId: 3, lookYawRadians: 0.1 });
    expect(toWireInput(current, previous)).toEqual({
      lookYawRadians: 0.1,
      lookPitchRadians: 0,
      leftCatchAttemptId: 3
    });
  });

  it('shrinks the serialized packet on the common (non-dash) tick', () => {
    // The dominant outbound packet is a moving, non-dashing tick (one per fixed step at up to 180Hz).
    // Trimming the 3-number dashDirection object must measurably shrink the JSON the SDK sends.
    const movingInput = fullInput({ moveX: 1, moveZ: 1, lookYawRadians: 0.7, lookPitchRadians: -0.2, sequence: 1234, clientTimeMs: 1_700_000_000_000 });
    const fullBytes = JSON.stringify(movingInput).length;
    const trimmedBytes = JSON.stringify(toWireInput(movingInput)).length;
    expect(trimmedBytes).toBeLessThan(fullBytes);
    // dashDirection serializes as `,"dashDirection":{"x":0,"y":0,"z":0}` — ~37 bytes. Assert a real
    // saving (not just one byte) so a regression that stops trimming is caught.
    expect(fullBytes - trimmedBytes).toBeGreaterThanOrEqual(60);
  });

  it('delta encoding materially shrinks the common unchanged input packet', () => {
    const previous = fullInput({ moveX: 1, lookYawRadians: 0.7, lookPitchRadians: -0.2, sequence: 1234, clientTimeMs: 1_700_000_000_000 });
    const current = fullInput({ moveX: 1, lookYawRadians: 0.7, lookPitchRadians: -0.2, sequence: 1235, clientTimeMs: 1_700_000_000_008 });
    const conservativeBytes = JSON.stringify(toWireInput(current)).length;
    const deltaBytes = JSON.stringify(toWireInput(current, previous)).length;
    expect(deltaBytes).toBeLessThan(conservativeBytes / 3);
  });
});

describe('dashDirection wire trim is gameplay-neutral', () => {
  it('a non-dash tick produces identical movement whether dashDirection is sent or trimmed', () => {
    const input = fullInput({ moveX: 1, moveZ: 1, sequence: 1 }); // strafing, not dashing
    const full = velocityAfterInput(input, 1);
    const trimmed = velocityAfterInput(toWireInput(input), 1);
    expect(trimmed).toEqual(full);
  });

  it('a dash WITH movement keys lands in the same direction trimmed as full', () => {
    // Client computes dashDirection from move keys + yaw. The server derives the SAME normalized
    // wish direction when the field is absent, so the dash impulse must match.
    const input = fullInput({
      dashPressed: true,
      moveX: 1,
      moveZ: 0,
      // What buildNetworkInput would compute for moveX=1,moveZ=0,yaw=0: { x: cos0, z: -sin0 } = {1,0}.
      dashDirection: { x: 1, y: 0, z: 0 },
      sequence: 1
    });
    const fullDir = horizontalDir(velocityAfterInput(input, 1));
    const trimmedDir = horizontalDir(velocityAfterInput(toWireInput(input), 1));
    expect(trimmedDir.x).toBeCloseTo(fullDir.x, 6);
    expect(trimmedDir.z).toBeCloseTo(fullDir.z, 6);
    // Sanity: the dash actually happened (non-zero horizontal velocity, pointing +X).
    expect(Math.hypot(fullDir.x, fullDir.z)).toBeGreaterThan(0.5);
    expect(fullDir.x).toBeGreaterThan(0.9);
  });

  it('a dash with NO movement keys (zero dir, trimmed) dashes toward facing, same as full', () => {
    // No move keys → client sends dashDirection {0,0,0} (trimmed). Sim must fall through to facing
    // (yaw 0 → forward +Z). Both full-zero and trimmed must dash +Z.
    const input = fullInput({ dashPressed: true, moveX: 0, moveZ: 0, sequence: 1 });
    const fullDir = horizontalDir(velocityAfterInput(input, 1));
    const trimmedDir = horizontalDir(velocityAfterInput(toWireInput(input), 1));
    expect(trimmedDir).toEqual(fullDir);
    // Facing dash is +Z for a negativeZ-spawn player at yaw 0.
    expect(fullDir.z).toBeGreaterThan(0.9);
    expect(Math.abs(fullDir.x)).toBeLessThan(0.05);
  });
});

describe('stale dashDirection never leaks into a later trimmed dash tick', () => {
  it('dash-left then (later) dash-with-no-movement dashes toward facing, not left', () => {
    // This is the regression the ZERO-default guards. Sequence:
    //   tick 1: dash LEFT with movement → server stores this input as the per-player fallback.
    //   ticks 2..N: idle (trimmed, no dashDirection) → must not re-dash.
    //   tick N: dash with NO movement (trimmed dashDirection) → MUST dash toward facing (+Z),
    //           NOT reuse the stale LEFT direction from tick 1.
    const loop = new ServerGameLoop('room');
    loop.addPlayer('a', 'A');
    loop.state.match = { ...loop.state.match, status: 'playing', countdownSeconds: 0 };
    loop.state.players.a.movement.position = { x: 0, y: 0, z: 0 };
    loop.state.players.a.movement.velocity = { x: 0, y: 0, z: 0 };

    // tick 1: dash LEFT (moveX = -1 → wish/dash dir -X). Send the full input as the wire would.
    const dashLeft = fullInput({ dashPressed: true, moveX: -1, dashDirection: { x: -1, y: 0, z: 0 }, sequence: 1 });
    loop.handleInput('a', toWireInput(dashLeft) as Partial<PlayerInput>, 1);
    loop.advance();
    const afterLeft = horizontalDir(loop.state.players.a.movement.velocity);
    expect(afterLeft.x).toBeLessThan(-0.9); // confirmed dashed left

    // Let velocity settle and dash come off cooldown so a second dash can fire.
    loop.state.players.a.movement.velocity = { x: 0, y: 0, z: 0 };
    loop.state.players.a.dash = { ...loop.state.players.a.dash, charges: 5, cooldownSeconds: 0, rechargeTimerSeconds: 0 };

    // a few idle trimmed ticks (no dashDirection on the wire)
    let seq = 2;
    for (; seq <= 6; seq += 1) {
      loop.handleInput('a', toWireInput(fullInput({ sequence: seq })) as Partial<PlayerInput>, seq);
      loop.advance();
    }
    loop.state.players.a.movement.velocity = { x: 0, y: 0, z: 0 };
    loop.state.players.a.dash = { ...loop.state.players.a.dash, charges: 5, cooldownSeconds: 0, rechargeTimerSeconds: 0 };

    // tick 7: dash with NO movement keys → trimmed dashDirection. MUST go toward facing (+Z).
    const dashNoMove = fullInput({ dashPressed: true, moveX: 0, moveZ: 0, sequence: seq });
    loop.handleInput('a', toWireInput(dashNoMove) as Partial<PlayerInput>, seq);
    loop.advance();
    const afterNoMove = horizontalDir(loop.state.players.a.movement.velocity);

    // The bug (fallback to previous dashDirection) would dash -X again; the fix dashes +Z.
    expect(afterNoMove.z).toBeGreaterThan(0.9);
    expect(afterNoMove.x).toBeGreaterThan(-0.1);
  });
});
