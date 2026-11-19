/**
 * Bounded blocking sleep for TIME-BASED blind injection labs (the equivalent of
 * MySQL SLEEP()). Each call is capped, and the whole instance has a total
 * sleep budget, so a learner can never turn it into an unbounded resource sink.
 * It blocks only this lab's own process.
 */
const PER_CALL_CAP_MS = 2000;
const TOTAL_BUDGET_MS = 600_000;
let slept = 0;

export function boundedSleepMs(ms: number): number {
  const n = Math.max(0, Math.min(PER_CALL_CAP_MS, Math.floor(Number.isFinite(ms) ? ms : 0)));
  if (n === 0) return 0;
  if (slept + n > TOTAL_BUDGET_MS) throw new Error("sleep budget for this instance is exhausted — reset the lab");
  slept += n;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, n);
  return n;
}
