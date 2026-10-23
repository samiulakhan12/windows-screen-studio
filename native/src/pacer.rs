//! Output timeline: decides which constant-rate frame slots to encode and when.
//!
//! Windows.Graphics.Capture only delivers a frame when the screen changes, so a
//! static screen would produce no samples at all. Instead, the recorder writes
//! one sample per slot of a fixed `fps` grid, each showing the newest captured
//! frame. Paused wall time is removed from the grid, so the video has no frozen
//! gap. All times are in 100 ns ticks of a monotonic clock (QPC on Windows).

use std::ops::Range;

pub const TICKS_PER_SECOND: i64 = 10_000_000;

/// When the loop wakes up late, at most this many overdue slots are written
/// (duplicating the newest frame); older missed slots are skipped and counted
/// as dropped, so a stalled encoder never causes an ever-growing backlog.
pub const MAX_CATCH_UP: u64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Slot {
    pub index: u64,
    /// Presentation time in the output video (ticks since the first frame, pauses excluded).
    pub time: i64,
    pub duration: i64,
}

#[derive(Debug)]
pub struct Pacer {
    fps: u32,
    /// Wall time of the first captured frame (video time 0).
    start: i64,
    paused_total: i64,
    paused_since: Option<i64>,
    /// Pause/resume/stop instants are never placed before the previous one.
    floor: i64,
    next: u64,
    last_written: Option<u64>,
    written: u64,
    dropped: u64,
    finished: bool,
}

impl Pacer {
    pub fn new(fps: u32, start: i64) -> Self {
        assert!(fps > 0, "fps must be positive");
        Self {
            fps,
            start,
            paused_total: 0,
            paused_since: None,
            floor: start,
            next: 0,
            last_written: None,
            written: 0,
            dropped: 0,
            finished: false,
        }
    }

    pub fn slot_time(&self, index: u64) -> i64 {
        (index as i128 * TICKS_PER_SECOND as i128 / self.fps as i128) as i64
    }

    pub fn slot(&self, index: u64) -> Slot {
        let time = self.slot_time(index);
        Slot { index, time, duration: self.slot_time(index + 1) - time }
    }

    #[cfg(test)]
    pub fn is_paused(&self) -> bool {
        self.paused_since.is_some()
    }

    #[cfg(test)]
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// Recorded (non-paused) time at wall time `t`.
    pub fn active_at(&self, t: i64) -> i64 {
        let t = match self.paused_since {
            Some(p) => t.min(p),
            None => t,
        };
        (t - self.start - self.paused_total).max(0)
    }

    fn clamp_instant(&self, at: i64, now: i64) -> i64 {
        at.min(now).max(self.floor)
    }

    /// Pauses at wall time `at` (clamped between the previous state change and `now`).
    /// Returns the effective instant, or None when already paused or finished.
    pub fn pause(&mut self, at: i64, now: i64) -> Option<i64> {
        if self.paused_since.is_some() || self.finished {
            return None;
        }
        let at = self.clamp_instant(at, now);
        self.paused_since = Some(at);
        self.floor = at;
        Some(at)
    }

    /// Resumes at wall time `at`; the paused span is removed from the video timeline.
    pub fn resume(&mut self, at: i64, now: i64) -> Option<i64> {
        let since = self.paused_since?;
        if self.finished {
            return None;
        }
        let at = self.clamp_instant(at, now);
        self.paused_total += at - since;
        self.paused_since = None;
        self.floor = at;
        Some(at)
    }

    /// Slots whose time has come at wall time `now`. Must be followed by `wrote`
    /// or `missed` for every index in the returned range.
    pub fn due(&mut self, now: i64) -> Range<u64> {
        if self.finished || self.paused_since.is_some() {
            return self.next..self.next;
        }
        let active = self.active_at(now);
        let mut last = (active as i128 * self.fps as i128 / TICKS_PER_SECOND as i128) as u64;
        while self.slot_time(last + 1) <= active {
            last += 1;
        }
        self.take_until(last + 1)
    }

    /// Wall time at which the next slot becomes due; None while paused or finished.
    pub fn next_due(&self) -> Option<i64> {
        if self.finished || self.paused_since.is_some() {
            return None;
        }
        Some(self.start + self.paused_total + self.slot_time(self.next))
    }

    /// Stops at wall time `at` and returns the remaining slots needed for the video
    /// to last until then. Afterwards nothing is due.
    pub fn finish(&mut self, at: i64, now: i64) -> Range<u64> {
        if self.finished {
            return self.next..self.next;
        }
        let stop = match self.paused_since {
            Some(p) => p,
            None => self.clamp_instant(at, now),
        };
        let active = self.active_at(stop);
        // Slots that start before the stop instant; slot 0 always exists.
        let mut end = (active as i128 * self.fps as i128 / TICKS_PER_SECOND as i128) as u64;
        while self.slot_time(end) < active {
            end += 1;
        }
        let range = self.take_until(end.max(1));
        self.finished = true;
        range
    }

    fn take_until(&mut self, end: u64) -> Range<u64> {
        if end <= self.next {
            return self.next..self.next;
        }
        let first = self.next.max(end.saturating_sub(MAX_CATCH_UP));
        self.dropped += first - self.next;
        self.next = end;
        first..end
    }

    pub fn wrote(&mut self, index: u64) {
        self.written += 1;
        self.last_written = Some(self.last_written.map_or(index, |w| w.max(index)));
    }

    pub fn missed(&mut self, _index: u64) {
        self.dropped += 1;
    }

    pub fn written(&self) -> u64 {
        self.written
    }

    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Length of the written video in ticks (end of the last written slot).
    pub fn duration(&self) -> i64 {
        self.last_written.map_or(0, |i| self.slot_time(i + 1))
    }
}

/// Maps between the monotonic clock (100 ns ticks) and epoch milliseconds, fixed at
/// one instant so later wall-clock adjustments do not skew the recording.
#[derive(Debug, Clone, Copy)]
pub struct Timebase {
    ticks: i64,
    epoch_ms: f64,
}

impl Timebase {
    pub fn new(ticks: i64, epoch_ms: f64) -> Self {
        Self { ticks, epoch_ms }
    }

    pub fn epoch_ms_at(&self, ticks: i64) -> f64 {
        self.epoch_ms + (ticks - self.ticks) as f64 / 10_000.0
    }

    pub fn ticks_at(&self, ms: f64) -> i64 {
        self.ticks + ((ms - self.epoch_ms) * 10_000.0).round() as i64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: i64 = 10_000;

    /// Writes every slot due at `now`.
    fn step(p: &mut Pacer, now: i64) -> Vec<u64> {
        let r = p.due(now);
        write_all(p, r)
    }

    fn write_all(p: &mut Pacer, r: Range<u64>) -> Vec<u64> {
        let v: Vec<u64> = r.collect();
        for &i in &v {
            p.wrote(i);
        }
        v
    }

    #[test]
    fn slots_follow_the_frame_grid() {
        let p = Pacer::new(60, 0);
        assert_eq!(p.slot(0), Slot { index: 0, time: 0, duration: 166_666 });
        assert_eq!(p.slot_time(60), TICKS_PER_SECOND);
        let total: i64 = (0..600).map(|i| p.slot(i).duration).sum();
        assert_eq!(total, 10 * TICKS_PER_SECOND);
        let p = Pacer::new(30, 0);
        assert_eq!(p.slot(1).time, 333_333);
    }

    #[test]
    fn first_slot_is_due_immediately_and_then_one_per_period() {
        let start = 5_000 * MS;
        let mut p = Pacer::new(30, start);
        assert_eq!(step(&mut p, start), vec![0]);
        assert_eq!(p.next_due(), Some(start + 333_333));
        assert!(p.due(start + 333_332).is_empty());
        assert_eq!(step(&mut p, start + 333_333), vec![1]);
        assert_eq!(step(&mut p, start + 700_000), vec![2]);
        assert_eq!(p.dropped(), 0);
    }

    #[test]
    fn a_static_screen_still_gets_one_frame_per_slot() {
        // The recorder writes the newest frame for every slot whether or not WGC delivered a new one.
        let mut p = Pacer::new(60, 0);
        let mut frames = 0;
        let mut t = 0;
        while t < 2 * TICKS_PER_SECOND {
            frames += step(&mut p, t).len();
            t += MS; // 1 ms polling
        }
        let tail = p.finish(2 * TICKS_PER_SECOND, 2 * TICKS_PER_SECOND);
        frames += write_all(&mut p, tail).len();
        assert_eq!(frames, 120);
        assert_eq!(p.duration(), 2 * TICKS_PER_SECOND);
        assert_eq!(p.dropped(), 0);
    }

    #[test]
    fn late_wakeups_catch_up_a_few_slots_and_drop_the_rest() {
        let mut p = Pacer::new(60, 0);
        step(&mut p, 0);
        // 50 ms late: slots 1..=3 are overdue and all written (within MAX_CATCH_UP).
        assert_eq!(step(&mut p, 50 * MS), vec![1, 2, 3]);
        // A 1 s stall: only the newest MAX_CATCH_UP slots are written.
        let r = p.due(1050 * MS);
        assert_eq!(r.end, 64);
        assert_eq!(r.end - r.start, MAX_CATCH_UP);
        write_all(&mut p, r);
        assert_eq!(p.dropped(), 64 - 4 - 4);
        assert_eq!(p.written() + p.dropped(), 64);
    }

    #[test]
    fn paused_time_is_removed_from_the_video() {
        let mut p = Pacer::new(30, 0);
        let mut written = vec![];
        let mut t = 0;
        // Record 1 s, pause for 5 s, record 1 s more.
        while t < TICKS_PER_SECOND {
            written.extend(step(&mut p, t));
            t += 5 * MS;
        }
        assert_eq!(p.pause(TICKS_PER_SECOND, t), Some(TICKS_PER_SECOND));
        assert!(p.is_paused());
        assert_eq!(p.next_due(), None);
        while t < 6 * TICKS_PER_SECOND {
            assert!(p.due(t).is_empty());
            t += 5 * MS;
        }
        assert_eq!(p.resume(6 * TICKS_PER_SECOND, t), Some(6 * TICKS_PER_SECOND));
        assert_eq!(p.active_at(6 * TICKS_PER_SECOND), TICKS_PER_SECOND);
        while t < 7 * TICKS_PER_SECOND {
            written.extend(step(&mut p, t));
            t += 5 * MS;
        }
        let tail = p.finish(7 * TICKS_PER_SECOND, t);
        written.extend(write_all(&mut p, tail));
        assert_eq!(written, (0..60).collect::<Vec<_>>());
        assert_eq!(p.duration(), 2 * TICKS_PER_SECOND);
        assert_eq!(p.dropped(), 0);
    }

    #[test]
    fn late_pause_commands_use_the_requested_instant() {
        let mut p = Pacer::new(60, 0);
        step(&mut p, 0);
        // The app paused at 100 ms but the command was read at 120 ms.
        assert_eq!(p.pause(100 * MS, 120 * MS), Some(100 * MS));
        assert_eq!(p.active_at(500 * MS), 100 * MS);
        // Instants in the future or before the previous change are clamped.
        assert_eq!(p.resume(10_000 * MS, 900 * MS), Some(900 * MS));
        assert_eq!(p.pause(50 * MS, 950 * MS), Some(900 * MS));
        assert_eq!(p.pause(960 * MS, 960 * MS), None, "already paused");
        assert_eq!(p.resume(1000 * MS, 1000 * MS), Some(1000 * MS));
        assert_eq!(p.resume(1000 * MS, 1000 * MS), None, "not paused");
        // 100 ms recorded before the first pause, nothing between 900 and 1000 ms (paused).
        assert_eq!(p.active_at(1000 * MS), 100 * MS);
    }

    #[test]
    fn finish_extends_the_video_to_the_stop_instant() {
        let mut p = Pacer::new(60, 0);
        step(&mut p, 0);
        step(&mut p, 20 * MS);
        // Stop requested at 40 ms (read at 45 ms): slots starting before 40 ms are 0, 1, 2.
        let tail = p.finish(40 * MS, 45 * MS);
        assert_eq!(write_all(&mut p, tail), vec![2]);
        assert!(p.is_finished());
        assert!(p.due(10_000 * MS).is_empty());
        assert_eq!(p.next_due(), None);
        assert_eq!(p.duration(), p.slot_time(3));
        assert!(p.finish(50 * MS, 50 * MS).is_empty());
    }

    #[test]
    fn finish_while_paused_ends_at_the_pause() {
        let mut p = Pacer::new(30, 0);
        let mut t = 0;
        while t <= 500 * MS {
            step(&mut p, t);
            t += 10 * MS;
        }
        p.pause(510 * MS, 510 * MS);
        let tail = p.finish(3000 * MS, 3000 * MS);
        write_all(&mut p, tail);
        // 510 ms of video at 30 fps -> slots 0..=15 (slot 15 starts at 500 ms).
        assert_eq!(p.written(), 16);
        assert_eq!(p.duration(), p.slot_time(16));
    }

    #[test]
    fn immediate_stop_still_writes_the_first_frame() {
        let mut p = Pacer::new(60, 100);
        let tail = p.finish(100, 100);
        assert_eq!(tail, 0..1);
    }

    #[test]
    fn missed_slots_are_counted_and_do_not_extend_the_duration() {
        let mut p = Pacer::new(60, 0);
        step(&mut p, 0);
        let r = p.due(17 * MS);
        assert_eq!(r, 1..2);
        p.missed(1);
        assert_eq!(p.dropped(), 1);
        assert_eq!(p.written(), 1);
        assert_eq!(p.duration(), p.slot_time(1));
    }

    #[test]
    fn timebase_round_trips() {
        let tb = Timebase::new(1_000_000_000, 1_700_000_000_000.0);
        assert_eq!(tb.epoch_ms_at(1_000_000_000 + 25 * MS), 1_700_000_000_025.0);
        assert_eq!(tb.ticks_at(1_700_000_000_025.0), 1_000_000_000 + 25 * MS);
        assert_eq!(tb.ticks_at(1_699_999_999_990.5), 1_000_000_000 - 95_000);
    }
}
