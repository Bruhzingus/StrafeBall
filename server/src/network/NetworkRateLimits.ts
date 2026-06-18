import { CLIENT_INPUT_RATE } from '../../../shared/netConfig';

export type InboundMessageType =
  | 'input'
  | 'throw'
  | 'pickup'
  | 'catch-parry'
  | 'drop'
  | 'reset'
  | 'start-vote'
  | 'switch-team'
  | 'ping';

export interface MessageRateLimit {
  capacity: number;
  refillPerSecond: number;
}

const INPUT_BURST_MULTIPLIER = 2;
const INPUT_REFILL_MULTIPLIER = 1.25;
const INPUT_HEADROOM_PER_SECOND = 32;
const PER_CLIENT_OVERHEAD_PER_SECOND = 30;
const MAX_MESSAGES_BURST_MULTIPLIER = 2.5;
const MIN_MAX_MESSAGES_PER_SECOND = 300;

export function expectedPerClientMessagesPerSecond(clientInputRate = CLIENT_INPUT_RATE): number {
  return clientInputRate + PER_CLIENT_OVERHEAD_PER_SECOND;
}

export function computeMaxMessagesPerSecondPerClient(clientInputRate = CLIENT_INPUT_RATE): number {
  return Math.max(
    MIN_MAX_MESSAGES_PER_SECOND,
    Math.ceil(expectedPerClientMessagesPerSecond(clientInputRate) * MAX_MESSAGES_BURST_MULTIPLIER)
  );
}

export function buildInboundRateLimits(clientInputRate = CLIENT_INPUT_RATE): Record<InboundMessageType, MessageRateLimit> {
  const inputCapacity = Math.max(
    Math.ceil(clientInputRate * INPUT_BURST_MULTIPLIER),
    Math.ceil(clientInputRate + INPUT_HEADROOM_PER_SECOND)
  );
  const inputRefillPerSecond = Math.max(
    Math.ceil(clientInputRate * INPUT_REFILL_MULTIPLIER),
    Math.ceil(clientInputRate + INPUT_HEADROOM_PER_SECOND)
  );
  const resetLike: MessageRateLimit = { capacity: 2, refillPerSecond: 0.5 };

  return {
    input: { capacity: inputCapacity, refillPerSecond: inputRefillPerSecond },
    throw: { capacity: 8, refillPerSecond: 8 },
    pickup: { capacity: 8, refillPerSecond: 8 },
    'catch-parry': { capacity: 10, refillPerSecond: 10 },
    drop: { capacity: 8, refillPerSecond: 8 },
    reset: resetLike,
    'start-vote': resetLike,
    'switch-team': resetLike,
    ping: { capacity: 4, refillPerSecond: 2 }
  };
}
