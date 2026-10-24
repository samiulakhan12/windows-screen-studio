//! Reports cursor shape changes (the cursor itself is not in the video; the app
//! draws it from its own position track and these shapes) and, for window recordings, the
//! window's rectangle, on one ~60 Hz polling thread.

use std::collections::HashMap;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, LoadCursorW, CURSORINFO, CURSOR_SHOWING};

use super::{clock, window};
use crate::output;
use crate::pacer::Timebase;
use crate::protocol;
use crate::shapes::{ShapeChanges, FALLBACK_SHAPE, SYSTEM_CURSORS};
use crate::window::{Change, WindowTracker};

const POLL_INTERVAL: Duration = Duration::from_millis(16);
/// Cursor handles change when the user switches cursor scheme or size.
const RELOAD_INTERVAL: Duration = Duration::from_secs(1);

/// The recorded window, followed on the cursor thread.
pub struct FollowWindow {
    /// The HWND value (HWND itself is a pointer and cannot cross threads).
    pub handle: i64,
    /// Holds the state already reported (the initial `window` event is sent by the recorder).
    pub tracker: WindowTracker,
    /// Set once the window no longer exists; the recorder then stops with reason "closed".
    pub gone: Arc<AtomicBool>,
}

pub struct CursorWatcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CursorWatcher {
    pub fn spawn(timebase: Timebase, follow: Option<FollowWindow>) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread =
            std::thread::Builder::new().name("cursor".into()).spawn(move || watch(timebase, follow, &flag)).ok();
        if thread.is_none() {
            output::log("could not start the cursor thread; cursor shapes and window moves are not reported");
        }
        Self { stop, thread }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for CursorWatcher {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

fn load_table() -> HashMap<isize, &'static str> {
    let mut table = HashMap::new();
    for &(id, shape) in SYSTEM_CURSORS {
        // MAKEINTRESOURCE(id): the id travels in the pointer value.
        if let Ok(handle) = unsafe { LoadCursorW(None, PCWSTR(id as usize as *const u16)) } {
            table.entry(handle.0 as isize).or_insert(shape);
        }
    }
    table
}

/// Reports a change of the followed window. False once stdout is gone.
fn follow_window(timebase: Timebase, follow: &mut FollowWindow) -> bool {
    match follow.tracker.update(window::observe(window::hwnd(follow.handle))) {
        Change::Changed(state) => {
            let at = timebase.epoch_ms_at(clock::now_ticks());
            output::emit(&protocol::event_window(at, &state))
        }
        Change::Closed => {
            follow.gone.store(true, Ordering::SeqCst);
            true
        }
        Change::Unchanged => true,
    }
}

fn watch(timebase: Timebase, mut follow: Option<FollowWindow>, stop: &AtomicBool) {
    let mut table = load_table();
    let mut loaded_at = Instant::now();
    let mut changes = ShapeChanges::default();
    while !stop.load(Ordering::SeqCst) {
        if let Some(follow) = follow.as_mut() {
            if !follow_window(timebase, follow) {
                return;
            }
        }
        let mut info = CURSORINFO { cbSize: size_of::<CURSORINFO>() as u32, ..Default::default() };
        if unsafe { GetCursorInfo(&mut info) }.is_ok() && info.flags.0 & CURSOR_SHOWING.0 != 0 {
            let key = info.hCursor.0 as isize;
            if !table.contains_key(&key) && loaded_at.elapsed() >= RELOAD_INTERVAL {
                table = load_table();
                loaded_at = Instant::now();
            }
            let shape = table.get(&key).copied().unwrap_or(FALLBACK_SHAPE);
            if let Some(shape) = changes.update(shape) {
                let at = timebase.epoch_ms_at(clock::now_ticks());
                if !output::emit(&protocol::event_cursor(at, shape)) {
                    return;
                }
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    }
}
