//! Precise waits for the ~60 Hz polling loops (`ticker.rs` decides how long).
//!
//! Waits that end on the system clock tick (15.625 ms unless something raised the timer
//! resolution, which since Windows 10 2004 no longer affects other processes) turn a 16 ms wait
//! into ~31 ms. A high-resolution waitable timer (`CREATE_WAITABLE_TIMER_HIGH_RESOLUTION`,
//! Windows 10 1803+) ends on time without touching the system's timer resolution. Before 1803,
//! `timeBeginPeriod(1)` is raised for as long as the sleeper lives (only while this helper
//! polls) and released when it is dropped.

use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::Threading::{
    CreateWaitableTimerExW, SetWaitableTimer, WaitForSingleObject, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE,
    TIMER_ALL_ACCESS,
};

/// TIMERR_NOERROR.
const TIMER_OK: u32 = 0;

/// Sleeps with ~1 ms precision. Lives on the thread that waits (the handle is not shared).
pub struct PreciseSleep {
    timer: Option<HANDLE>,
    raised_resolution: bool,
}

impl PreciseSleep {
    pub fn new() -> Self {
        let timer = unsafe {
            CreateWaitableTimerExW(None, PCWSTR::null(), CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, TIMER_ALL_ACCESS.0)
        };
        match timer {
            Ok(handle) => Self { timer: Some(handle), raised_resolution: false },
            // Windows 10 before 1803: no high-resolution timers; std::thread::sleep then ends on
            // the system tick unless the resolution is raised.
            Err(_) => Self { timer: None, raised_resolution: unsafe { timeBeginPeriod(1) } == TIMER_OK },
        }
    }

    pub fn sleep(&self, duration: Duration) {
        if duration.is_zero() {
            return;
        }
        if let Some(timer) = self.timer {
            // Negative: relative to now, in 100 ns units.
            let due = -(i64::try_from(duration.as_nanos() / 100).unwrap_or(i64::MAX).max(1));
            if unsafe { SetWaitableTimer(timer, &due, 0, None, None, false) }.is_ok()
                && unsafe { WaitForSingleObject(timer, INFINITE) } == WAIT_OBJECT_0
            {
                return;
            }
        }
        std::thread::sleep(duration);
    }
}

impl Drop for PreciseSleep {
    fn drop(&mut self) {
        if let Some(timer) = self.timer.take() {
            let _ = unsafe { CloseHandle(timer) };
        }
        if self.raised_resolution {
            unsafe { timeEndPeriod(1) };
        }
    }
}
