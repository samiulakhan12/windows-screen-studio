//! The fixed-rate schedule of the ~60 Hz polling loops (cursor shape and window rectangle in
//! `record`, the window rectangle in `watch-window`). A tick is due one interval after the
//! previous one was due, not one interval after the work finished, so the rate holds whatever
//! the work and the wake-up latency cost. win/timer.rs does the precise waiting.

use std::time::{Duration, Instant};

/// How often the cursor shape and the window are polled: ~60 Hz.
pub const POLL_INTERVAL: Duration = Duration::from_millis(16);

pub struct Ticker {
    interval: Duration,
    next: Instant,
}

impl Ticker {
    /// The first tick is due at `now`.
    pub fn new(interval: Duration, now: Instant) -> Self {
        Self { interval, next: now }
    }

    /// How long to wait from `now` for the next tick. When that tick is already due (the work
    /// or the wake-up took a whole interval: the thread was not scheduled, a write blocked), it
    /// is due at once and the grid restarts from `now` instead of ticking in a burst to catch up.
    pub fn wait(&mut self, now: Instant) -> Duration {
        self.next += self.interval;
        if self.next > now {
            self.next - now
        } else {
            self.next = now;
            Duration::ZERO
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    #[test]
    fn keeps_the_rate_whatever_the_work_and_wake_up_cost() {
        let t0 = Instant::now();
        let mut t = Ticker::new(16 * MS, t0);
        // Polling took 1 ms: wait the rest of the interval.
        assert_eq!(t.wait(t0 + MS), 15 * MS);
        // Woke up 0.5 ms late and worked 0.3 ms: the next tick is still at 32 ms.
        assert_eq!(t.wait(t0 + 16 * MS + 800 * Duration::from_micros(1)), 15 * MS + 200 * Duration::from_micros(1));
        assert_eq!(t.wait(t0 + 32 * MS), 16 * MS);
        // 62.5 polls per second: 1000 ticks span 16 s, not 1000 x (16 ms + work).
        let mut t = Ticker::new(16 * MS, t0);
        let mut now = t0;
        for _ in 0..1000 {
            now += Duration::from_micros(700); // the work
            now += t.wait(now);
        }
        assert_eq!(now - t0, 16_000 * MS);
    }

    #[test]
    fn restarts_after_a_stall_instead_of_catching_up() {
        let t0 = Instant::now();
        let mut t = Ticker::new(16 * MS, t0);
        // The tick due at 16 ms is noticed at 50 ms: poll at once...
        assert_eq!(t.wait(t0 + 50 * MS), Duration::ZERO);
        // ...then every interval from there, not three ticks in a row.
        assert_eq!(t.wait(t0 + 50 * MS), 16 * MS);
        assert_eq!(t.wait(t0 + 70 * MS), 12 * MS);
        // Exactly due counts as due.
        let mut t = Ticker::new(16 * MS, t0);
        assert_eq!(t.wait(t0 + 16 * MS), Duration::ZERO);
    }
}
