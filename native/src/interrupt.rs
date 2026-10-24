//! Ending a recording from outside the protocol: Ctrl+C, closing the console, logoff or
//! shutdown. The Windows handlers (win/session_end.rs) run on threads of their own: they
//! record the request here, and for the notifications after which Windows ends the process
//! (closing the console, logoff, shutdown) they wait, bounded, until the recording thread
//! has settled the output file, so the MP4 is finalised instead of cut off.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// Windows ends a process about 5 s after these notifications whatever the handler does;
/// waiting a little less lets the handler return on its own.
pub const GRACE: Duration = Duration::from_millis(4500);

/// Console control events (wincon.h). Ctrl+C (0) and Ctrl+Break (1) let the process run on
/// once the handler returns; these end it as soon as the handler returns.
pub const CTRL_CLOSE: u32 = 2;
pub const CTRL_LOGOFF: u32 = 5;
pub const CTRL_SHUTDOWN: u32 = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Ctrl+C, Ctrl+Break or closing the console window.
    Console,
    /// The user signs out or Windows shuts down or restarts.
    SessionEnd,
}

impl Source {
    /// The `reason` of the `stopped` event.
    pub fn reason(self) -> &'static str {
        match self {
            Source::Console => "interrupt",
            Source::SessionEnd => "shutdown",
        }
    }
}

/// What a console control event means: who asked, and whether the handler must hold the
/// process until the file is finalised.
pub fn console_event(kind: u32) -> (Source, bool) {
    match kind {
        CTRL_LOGOFF | CTRL_SHUTDOWN => (Source::SessionEnd, true),
        CTRL_CLOSE => (Source::Console, true),
        // CTRL_C, CTRL_BREAK and anything newer: the process keeps running.
        _ => (Source::Console, false),
    }
}

/// The first interrupt request; later ones keep the first reason.
pub struct Interrupt {
    source: AtomicU8,
}

impl Interrupt {
    pub const fn new() -> Self {
        Self { source: AtomicU8::new(0) }
    }

    pub fn request(&self, source: Source) {
        let code = match source {
            Source::Console => 1,
            Source::SessionEnd => 2,
        };
        let _ = self.source.compare_exchange(0, code, Ordering::SeqCst, Ordering::SeqCst);
    }

    pub fn requested(&self) -> Option<Source> {
        match self.source.load(Ordering::SeqCst) {
            0 => None,
            1 => Some(Source::Console),
            _ => Some(Source::SessionEnd),
        }
    }
}

impl Default for Interrupt {
    fn default() -> Self {
        Self::new()
    }
}

/// A one-way flag other threads can wait on, e.g. "the output file is settled".
pub struct Latch {
    done: Mutex<bool>,
    changed: Condvar,
}

impl Latch {
    pub const fn new() -> Self {
        Self { done: Mutex::new(false), changed: Condvar::new() }
    }

    pub fn set(&self) {
        let mut done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        *done = true;
        self.changed.notify_all();
    }

    /// Waits until the latch is set or `timeout` passed; returns whether it is set.
    pub fn wait(&self, timeout: Duration) -> bool {
        let done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        match self.changed.wait_timeout_while(done, timeout, |done| !*done) {
            Ok((done, _)) => *done,
            Err(e) => *e.into_inner().0,
        }
    }
}

impl Default for Latch {
    fn default() -> Self {
        Self::new()
    }
}

/// Sets the latch when dropped, so every way out of a function (including `?`) signals it.
pub struct SetOnDrop<'a>(pub &'a Latch);

impl Drop for SetOnDrop<'_> {
    fn drop(&mut self) {
        self.0.set();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn only_close_logoff_and_shutdown_hold_the_process() {
        assert_eq!(console_event(0), (Source::Console, false)); // Ctrl+C
        assert_eq!(console_event(1), (Source::Console, false)); // Ctrl+Break
        assert_eq!(console_event(CTRL_CLOSE), (Source::Console, true));
        assert_eq!(console_event(CTRL_LOGOFF), (Source::SessionEnd, true));
        assert_eq!(console_event(CTRL_SHUTDOWN), (Source::SessionEnd, true));
        assert_eq!(console_event(42), (Source::Console, false));
        assert_eq!(Source::Console.reason(), "interrupt");
        assert_eq!(Source::SessionEnd.reason(), "shutdown");
    }

    #[test]
    fn keeps_the_first_interrupt_reason() {
        let i = Interrupt::new();
        assert_eq!(i.requested(), None);
        i.request(Source::SessionEnd);
        i.request(Source::Console);
        assert_eq!(i.requested(), Some(Source::SessionEnd));
    }

    #[test]
    fn latch_times_out_while_unset_and_returns_at_once_when_set() {
        let latch = Latch::new();
        let t0 = Instant::now();
        assert!(!latch.wait(Duration::from_millis(30)));
        assert!(t0.elapsed() >= Duration::from_millis(30));
        latch.set();
        let t1 = Instant::now();
        assert!(latch.wait(Duration::from_secs(5)));
        assert!(t1.elapsed() < Duration::from_secs(1));
        assert!(latch.wait(Duration::ZERO));
    }

    #[test]
    fn latch_wakes_a_waiting_thread_when_the_guard_drops() {
        let latch = Arc::new(Latch::new());
        let waiter = {
            let latch = latch.clone();
            std::thread::spawn(move || {
                let t0 = Instant::now();
                (latch.wait(Duration::from_secs(10)), t0.elapsed())
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        {
            let _guard = SetOnDrop(&latch);
        }
        let (set, waited) = waiter.join().unwrap();
        assert!(set);
        assert!(waited < Duration::from_secs(5), "waited {waited:?}");
    }
}
