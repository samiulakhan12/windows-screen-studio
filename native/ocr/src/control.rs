//! What the stdin dispatcher tells the workers between commands (docs/design/auto-blur.md §5.5,
//! §5.11): `pause` and `resume` (while Flown records, the workers stop at the next tile or frame
//! and the ffmpeg pipes are not read, so ffmpeg blocks), and `cancel` of a command a worker has
//! already taken.

use crate::protocol::Failure;
use std::collections::BTreeSet;
use std::sync::{Condvar, Mutex};

static PAUSED: Mutex<bool> = Mutex::new(false);
static RESUMED: Condvar = Condvar::new();
/// Commands taken by a worker and not answered yet, and those of them main cancelled.
static ACTIVE: Mutex<(BTreeSet<u64>, BTreeSet<u64>)> = Mutex::new((BTreeSet::new(), BTreeSet::new()));

pub fn pause(on: bool) {
    let mut p = PAUSED.lock().unwrap_or_else(|e| e.into_inner());
    *p = on;
    if !on {
        RESUMED.notify_all();
    }
}

/// Blocks while paused.
pub fn wait_if_paused() {
    let mut p = PAUSED.lock().unwrap_or_else(|e| e.into_inner());
    while *p {
        p = RESUMED.wait(p).unwrap_or_else(|e| e.into_inner());
    }
}

/// A worker takes command `id`.
pub fn begin(id: u64) {
    let mut a = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    a.0.insert(id);
}

/// Command `id` is answered.
pub fn end(id: u64) {
    let mut a = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    a.0.remove(&id);
    a.1.remove(&id);
}

/// Marks `id` cancelled when a worker holds it; false when no worker does.
pub fn cancel(id: u64) -> bool {
    let mut a = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if a.0.contains(&id) {
        a.1.insert(id);
        true
    } else {
        false
    }
}

/// Between tiles, lines and frames: waits while paused; Err when `id` was cancelled.
pub fn checkpoint(id: u64) -> Result<(), Failure> {
    wait_if_paused();
    let a = ACTIVE.lock().unwrap_or_else(|e| e.into_inner());
    if a.1.contains(&id) {
        Err(Failure::Cancelled)
    } else {
        Ok(())
    }
}
