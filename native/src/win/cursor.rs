//! Reports cursor shape changes (the cursor itself is not in the video; the app
//! draws it from its own position track and these shapes).

use std::collections::HashMap;
use std::mem::size_of;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::PCWSTR;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorInfo, LoadCursorW, CURSORINFO, CURSOR_SHOWING};

use super::clock;
use crate::output;
use crate::pacer::Timebase;
use crate::protocol;
use crate::shapes::{ShapeChanges, FALLBACK_SHAPE, SYSTEM_CURSORS};

const POLL_INTERVAL: Duration = Duration::from_millis(16);
/// Cursor handles change when the user switches cursor scheme or size.
const RELOAD_INTERVAL: Duration = Duration::from_secs(1);

pub struct CursorWatcher {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CursorWatcher {
    pub fn spawn(timebase: Timebase) -> Self {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let thread = std::thread::Builder::new().name("cursor".into()).spawn(move || watch(timebase, &flag)).ok();
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

fn watch(timebase: Timebase, stop: &AtomicBool) {
    let mut table = load_table();
    let mut loaded_at = Instant::now();
    let mut changes = ShapeChanges::default();
    while !stop.load(Ordering::SeqCst) {
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
