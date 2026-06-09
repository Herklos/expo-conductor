/**
 * Task handler registration — intentionally at MODULE (global) scope, imported from
 * `index.ts` before the app mounts. This mirrors `expo-task-manager`'s requirement: when
 * the OS relaunches the app headlessly to run a background/alarm/push task, no React
 * components mount, so handlers must already be registered here.
 *
 * Lab archetypes — 5 JS implementations exercising different resource profiles.
 * Companion native (Kotlin/Swift) and Rust handlers are registered at app startup
 * by the config plugin-injected native code (Phase 6 / Tier C).
 */
import Conductor, { TaskResult } from 'expo-conductor';

// ---------------------------------------------------------------------------
// Legacy demo handlers
// ---------------------------------------------------------------------------

Conductor.defineTask('sync', () => TaskResult.NEW_DATA);

Conductor.defineTask('flaky', (ctx) =>
  ctx.attempt < 2 ? TaskResult.FAILED : TaskResult.SUCCESS,
);

Conductor.defineTask('heavy', () => TaskResult.SUCCESS);

// ---------------------------------------------------------------------------
// Lab archetype — JS handlers
// These are the JS legs of the 5-archetype × 4-language cross-language lab.
// Native (Kotlin / Swift) and Rust handlers share the same handler-name
// convention but are registered natively at app init (Tier C, config plugin).
// ---------------------------------------------------------------------------

/**
 * lab-calc: lightweight CPU — recursive Fibonacci(35).
 * Demonstrates a simple computation with negligible memory and no I/O.
 */
Conductor.defineTask('lab-calc', () => {
  function fib(n: number): number {
    return n <= 1 ? n : fib(n - 1) + fib(n - 2);
  }
  fib(35);
  return TaskResult.SUCCESS;
});

/**
 * lab-cpu: high CPU — Sieve of Eratosthenes up to 500 000.
 * Keeps the CPU thread busy for ~50–200 ms depending on device.
 */
Conductor.defineTask('lab-cpu', () => {
  const limit = 500_000;
  const sieve = new Uint8Array(limit + 1).fill(1);
  sieve[0] = 0;
  sieve[1] = 0;
  for (let i = 2; i * i <= limit; i++) {
    if (sieve[i]) {
      for (let j = i * i; j <= limit; j += i) sieve[j] = 0;
    }
  }
  return TaskResult.SUCCESS;
});

/**
 * lab-ram: high RAM — allocates a 16 MB Float64Array and scatters writes.
 * Exercises the GC and memory allocator.
 */
Conductor.defineTask('lab-ram', () => {
  const arr = new Float64Array(2_000_000); // ~16 MB
  for (let i = 0; i < arr.length; i += 64) arr[i] = i * 1.0001;
  return TaskResult.SUCCESS;
});

/**
 * lab-net: high network — fetches the public Cloudflare trace endpoint (~800 B).
 * Tests network admission constraint and actual I/O latency.
 */
Conductor.defineTask('lab-net', async () => {
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
    await res.text();
    return TaskResult.NEW_DATA;
  } catch {
    return TaskResult.FAILED;
  }
});

/**
 * lab-all: all resources heavy — CPU sieve + RAM alloc + network fetch.
 * The "worst case" task that should exercise every budget dimension.
 */
Conductor.defineTask('lab-all', async () => {
  // CPU
  const limit = 200_000;
  const sieve = new Uint8Array(limit + 1).fill(1);
  for (let i = 2; i * i <= limit; i++) {
    if (sieve[i]) for (let j = i * i; j <= limit; j += i) sieve[j] = 0;
  }
  // RAM
  const arr = new Float64Array(1_000_000); // ~8 MB
  for (let i = 0; i < arr.length; i += 64) arr[i] = i;
  // Network
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace');
    await res.text();
  } catch {
    // best-effort
  }
  return TaskResult.SUCCESS;
});
