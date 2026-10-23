//! Monotonic time in 100 ns ticks on the QPC timebase, the same timebase as
//! Direct3D11CaptureFrame.SystemRelativeTime, and wall-clock epoch milliseconds.

use std::sync::OnceLock;

use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows::Win32::System::SystemInformation::GetSystemTimePreciseAsFileTime;

use crate::pacer::{Timebase, TICKS_PER_SECOND};

fn frequency() -> i64 {
    static FREQ: OnceLock<i64> = OnceLock::new();
    *FREQ.get_or_init(|| {
        let mut f = 0i64;
        // Cannot fail on Windows XP and later.
        let _ = unsafe { QueryPerformanceFrequency(&mut f) };
        f.max(1)
    })
}

/// Now, in 100 ns ticks.
pub fn now_ticks() -> i64 {
    let mut c = 0i64;
    let _ = unsafe { QueryPerformanceCounter(&mut c) };
    (c as i128 * TICKS_PER_SECOND as i128 / frequency() as i128) as i64
}

/// Milliseconds since 1970-01-01 UTC, like JavaScript's Date.now() but sub-millisecond.
pub fn now_epoch_ms() -> f64 {
    let ft = unsafe { GetSystemTimePreciseAsFileTime() };
    let since_1601 = ((ft.dwHighDateTime as u64) << 32) | ft.dwLowDateTime as u64;
    // 100 ns intervals between 1601-01-01 and 1970-01-01.
    const UNIX_EPOCH: u64 = 116_444_736_000_000_000;
    since_1601.saturating_sub(UNIX_EPOCH) as f64 / 10_000.0
}

pub fn timebase() -> Timebase {
    // Sample the two clocks back to back; take the tightest of a few tries.
    let mut best: Option<(i64, Timebase)> = None;
    for _ in 0..5 {
        let a = now_ticks();
        let ms = now_epoch_ms();
        let b = now_ticks();
        let width = b - a;
        if best.as_ref().is_none_or(|(w, _)| width < *w) {
            best = Some((width, Timebase::new(a + width / 2, ms)));
        }
    }
    best.map(|(_, tb)| tb).unwrap_or_else(|| Timebase::new(now_ticks(), now_epoch_ms()))
}
