export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface PracticeState {
  opponentEnabled: boolean;
  botDifficulty: BotDifficulty;
  /** Practice lobby only: shorten future power-up respawns to two seconds. */
  fastPowerupRespawnEnabled: boolean;
  practiceScore: number;
  spawnedExtraBalls: number;
  maxPracticeBalls: number;
  // Per-button cooldown timers (seconds remaining)
  buttonCooldowns: Record<string, number>;
}

export function createPracticeState(): PracticeState {
  return {
    // The opponent replaces the default practice dummies, so it starts visible.
    opponentEnabled: true,
    botDifficulty: 'normal',
    fastPowerupRespawnEnabled: false,
    practiceScore: 0,
    spawnedExtraBalls: 0,
    maxPracticeBalls: 8,
    buttonCooldowns: {}
  };
}
