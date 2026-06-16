export enum BallState {
  Loose = 'loose',
  Held = 'held',
  Live = 'live',
  Dead = 'dead'
}

export type BallOwner = 'player' | 'launcher' | 'dummy' | null;
export type HandSide = 'left' | 'right';
