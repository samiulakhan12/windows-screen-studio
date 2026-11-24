//! Counters the tests read through the `stats` command of the fixture build (R1, R2, R9, R16,
//! R22, R26-R30): how many model files were read and parsed, how many plans were built, how many frames
//! each decode produced. They hold numbers only.

use std::sync::atomic::{AtomicU64, Ordering};

pub static FILE_READS: AtomicU64 = AtomicU64::new(0);
pub static PARSES: AtomicU64 = AtomicU64::new(0);
pub static PLAN_BUILDS: AtomicU64 = AtomicU64::new(0);
/// Frames ffmpeg decoded for reads (counted by the showinfo before the frame selection).
pub static READ_DECODED: AtomicU64 = AtomicU64::new(0);
/// Frames the last read's ffmpeg run decoded.
pub static LAST_READ_DECODED: AtomicU64 = AtomicU64::new(0);
/// Frames the follow sessions received.
pub static FOLLOW_FRAMES: AtomicU64 = AtomicU64::new(0);
/// Frames ffmpeg decoded for follow sessions (counted before the selection).
pub static FOLLOW_DECODED: AtomicU64 = AtomicU64::new(0);
/// ffmpeg runs of follow sessions (each backward piece, each forward stream).
pub static FOLLOW_RUNS: AtomicU64 = AtomicU64::new(0);
/// Frames of follow sessions whose gradient was worked out (only frames a track or match asked).
pub static FOLLOW_GRADIENTS: AtomicU64 = AtomicU64::new(0);
/// Template matches made (one part at one candidate in one frame).
pub static MATCHES: AtomicU64 = AtomicU64::new(0);
/// Nanoseconds spent matching.
pub static MATCH_NS: AtomicU64 = AtomicU64::new(0);
/// Nanoseconds spent analysing look frames, and how many.
pub static LOOK_NS: AtomicU64 = AtomicU64::new(0);
pub static LOOK_FRAMES: AtomicU64 = AtomicU64::new(0);
pub static PANICS: AtomicU64 = AtomicU64::new(0);
/// The last read's detector runs: (bucket index, areas in it).
pub static LAST_RUNS: std::sync::Mutex<Vec<(usize, usize)>> = std::sync::Mutex::new(Vec::new());

pub fn set_runs(runs: Vec<(usize, usize)>) {
    *LAST_RUNS.lock().unwrap_or_else(|e| e.into_inner()) = runs;
}

pub fn add(c: &AtomicU64, n: u64) {
    c.fetch_add(n, Ordering::Relaxed);
}

pub fn set(c: &AtomicU64, n: u64) {
    c.store(n, Ordering::Relaxed);
}

#[cfg_attr(not(any(test, feature = "fixture")), allow(dead_code))]
pub fn get(c: &AtomicU64) -> u64 {
    c.load(Ordering::Relaxed)
}

#[cfg(feature = "fixture")]
pub fn json() -> serde_json::Value {
    serde_json::json!({
        "fileReads": get(&FILE_READS),
        "parses": get(&PARSES),
        "planBuilds": get(&PLAN_BUILDS),
        "readDecoded": get(&READ_DECODED),
        "lastReadDecoded": get(&LAST_READ_DECODED),
        "followFrames": get(&FOLLOW_FRAMES),
        "followDecoded": get(&FOLLOW_DECODED),
        "followRuns": get(&FOLLOW_RUNS),
        "followGradients": get(&FOLLOW_GRADIENTS),
        "matches": get(&MATCHES),
        "matchNs": get(&MATCH_NS),
        "lookNs": get(&LOOK_NS),
        "lookFrames": get(&LOOK_FRAMES),
        "panics": get(&PANICS),
        "lastRuns": LAST_RUNS.lock().map(|r| r.clone()).unwrap_or_default(),
    })
}
