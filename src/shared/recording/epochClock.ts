/**
 * One wall clock for every epoch time the recorder shares with other processes: the
 * main process stamps cursor samples and pauses with Date.now(), and the native helper
 * stamps frames with the system time.
 *
 * Not performance.timeOrigin + performance.now(): timeOrigin is fixed when the page
 * loads while the wall clock keeps being corrected (time sync, resume from sleep), so
 * after hours the two drift apart. Instead performance.now() (precise, monotonic) is
 * offset to Date.now(), re-aligned whenever a recording starts.
 */
let anchor = Date.now() - performance.now()

/**
 * Re-aligns epochNow() with Date.now(). Date.now() only has whole milliseconds, so a
 * single reading is up to 1 ms low; sampling for a little over 1 ms and keeping the
 * largest offset catches a reading taken just after a millisecond tick.
 */
export function syncEpoch(): void {
  const until = performance.now() + 1.2
  let best = Date.now() - performance.now()
  // Bounded, in case a (test) clock does not advance.
  for (let i = 0; i < 100_000 && performance.now() < until; i++) best = Math.max(best, Date.now() - performance.now())
  anchor = best
}

/** Epoch milliseconds with sub-millisecond precision, on the same clock as Date.now() (see syncEpoch). */
export const epochNow = (): number => anchor + performance.now()
