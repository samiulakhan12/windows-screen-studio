//! Line-oriented stdout shared by the recorder threads.

use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

static STDOUT_LOCK: Mutex<()> = Mutex::new(());
static STDOUT_BROKEN: AtomicBool = AtomicBool::new(false);

/// Writes one line and flushes it, so the app sees events immediately even
/// through a pipe. Returns false once stdout is gone (the app died): the
/// recorder treats that like a stop request.
pub fn emit(line: &str) -> bool {
    let _guard = STDOUT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if STDOUT_BROKEN.load(Ordering::Relaxed) {
        return false;
    }
    let mut out = io::stdout().lock();
    let ok = out.write_all(line.as_bytes()).and_then(|_| out.write_all(b"\n")).and_then(|_| out.flush()).is_ok();
    if !ok {
        STDOUT_BROKEN.store(true, Ordering::Relaxed);
    }
    ok
}

pub fn stdout_broken() -> bool {
    STDOUT_BROKEN.load(Ordering::Relaxed)
}

/// Diagnostics for humans; never part of the protocol.
pub fn log(message: &str) {
    let _ = writeln!(io::stderr().lock(), "ssw-capture: {message}");
}
