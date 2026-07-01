export const CONTROL_KEYS = {
  forward: 'KeyW',
  backward: 'KeyS',
  left: 'KeyA',
  right: 'KeyD',
  jump: 'Space',
  dash: 'ShiftLeft',
  crouch: 'ControlLeft',
  crouchAlt: 'ControlRight',
  slide: 'KeyC',
  backflip: 'KeyQ',
  fakeThrow: 'KeyF',
  drop: 'KeyR',
  interact: 'KeyE',
  reset: 'KeyK',
  resetBalls: 'KeyJ',
  resetMatch: 'KeyU',
  debugBallLauncher: 'KeyL',
  toggleDebug: 'Tab',
  // Offline testing toggle: removes cooldowns/costs from catches, stamina (dash), backflip, parry.
  toggleNoCooldown: 'KeyO'
} as const;

export const MOUSE_BUTTON = {
  leftHand: 0,
  rightHand: 2
} as const;
