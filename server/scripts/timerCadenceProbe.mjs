import { release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';

// Run in a plain Node process so build tools and gameplay traffic do not wake its event loop.
// This measures timer delivery on this machine, not a running room or internet latency.
const { values } = parseArgs({
  options: {
    'duration-ms': { type: 'string', default: '5000' },
    'wake-ms': { type: 'string', default: '5' },
    help: { type: 'boolean', short: 'h' }
  }
});

if (values.help) {
  console.log('Usage: npm --prefix server run diagnose:timing -- [--duration-ms 5000] [--wake-ms 5]');
  console.log('Measures an otherwise idle Node timer. Does not change OS settings or the game server.');
  process.exit(0);
}

function boundedNumber(name, value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`--${name} must be a finite number between ${min} and ${max}`);
  }
  return number;
}

const durationMs = boundedNumber('duration-ms', values['duration-ms'], 1000, 60000);
const requestedWakeMs = boundedNumber('wake-ms', values['wake-ms'], 1, 1000);
// Node truncates fractional timer delays; report what it actually requests from the runtime.
const scheduledWakeMs = Math.trunc(requestedWakeMs);
const gaps = [];
const round = (value) => Number(value.toFixed(3));

console.log(`Measuring ${scheduledWakeMs}ms Node timer delivery for ${durationMs}ms...`);
const initialCpu = process.cpuUsage();
const startedAt = performance.now();
let previousWakeAt = startedAt;
const timer = setInterval(() => {
  const now = performance.now();
  gaps.push(now - previousWakeAt);
  previousWakeAt = now;
  const elapsedMs = now - startedAt;
  if (elapsedMs < durationMs) return;

  clearInterval(timer);
  const cpu = process.cpuUsage(initialCpu);
  gaps.sort((a, b) => a - b);
  const percentile = (fraction) => gaps[Math.max(0, Math.ceil(gaps.length * fraction) - 1)];
  const cpuMs = (cpu.user + cpu.system) / 1000;
  console.log(JSON.stringify({
    scope: 'idle-process-timer-only',
    runtime: { node: process.versions.node, libuv: process.versions.uv, platform: process.platform, arch: process.arch, osRelease: release() },
    requestedWakeMs,
    scheduledWakeMs,
    requestedWakeHz: round(1000 / scheduledWakeMs),
    observedWakeHz: round(gaps.length * 1000 / elapsedMs),
    elapsedMs: round(elapsedMs),
    callbacks: gaps.length,
    gapMs: {
      min: round(gaps[0]),
      mean: round(elapsedMs / gaps.length),
      p50: round(percentile(0.5)),
      p95: round(percentile(0.95)),
      p99: round(percentile(0.99)),
      max: round(gaps.at(-1))
    },
    cpuMs: round(cpuMs),
    cpuPercentOfOneCore: round(cpuMs / elapsedMs * 100)
  }, null, 2));
  console.log('Game traffic can wake the server more often. Compare live room wake/snapshot rates before attributing a match problem to timer granularity.');
  console.log('CPU time is OS-accounted; short, mostly idle runs can report 0ms due to accounting granularity.');
}, scheduledWakeMs);
