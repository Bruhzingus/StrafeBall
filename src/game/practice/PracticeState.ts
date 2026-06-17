export type BotDifficulty = 'easy' | 'normal' | 'hard';

export interface PracticeState {
  quickThrowBotEnabled: boolean;
  chargeThrowBotEnabled: boolean;
  botDifficulty: BotDifficulty;
  practiceScore: number;
  spawnedExtraBalls: number;
  maxPracticeBalls: number;
  // Per-button cooldown timers (seconds remaining)
  buttonCooldowns: Record<string, number>;
}

export function createPracticeState(): PracticeState {
  return {
    quickThrowBotEnabled: false,
    chargeThrowBotEnabled: false,
    botDifficulty: 'normal',
    practiceScore: 0,
    spawnedExtraBalls: 0,
    maxPracticeBalls: 8,
    buttonCooldowns: {}
  };
}

export const BOT_DIFFICULTY_CONFIG = {
  easy: { intervalSeconds: 3.5, throwSpeed: 13, windupSeconds: 0.8, chargeThrowSpeed: 17, arc: 0.22, aimSpread: 0.28 },
  normal: { intervalSeconds: 2.0, throwSpeed: 17, windupSeconds: 0.55, chargeThrowSpeed: 24, arc: 0.14, aimSpread: 0.14 },
  hard: { intervalSeconds: 1.1, throwSpeed: 21, windupSeconds: 0.32, chargeThrowSpeed: 30, arc: 0.06, aimSpread: 0.04 }
} as const;
