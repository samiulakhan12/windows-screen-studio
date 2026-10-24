//! The recorded or watched window: whether it exists, its screen rectangle and whether it is on
//! screen. Which observations become `window` events is decided by `crate::window`.

use std::ffi::c_void;
use std::mem::size_of;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsIconic, IsWindow, IsWindowVisible};

use super::clock;
use super::{Failure, Result};
use crate::exit;
use crate::input::{self, Input};
use crate::output;
use crate::protocol::{self, Command};
use crate::window::{Change, Observation, WindowRect, WindowTracker};

/// How often `watch-window` looks at the window (the recorder polls on its cursor thread).
pub const POLL_INTERVAL: Duration = Duration::from_millis(16);

/// The handle as Electron prints it (`window:<HWND>:<n>`); window handles are 32-bit values
/// sign-extended to pointer size, so any i64 the CLI accepted converts losslessly.
pub fn hwnd(handle: i64) -> HWND {
    HWND(handle as isize as *mut c_void)
}

/// The window behind `handle`, or "not found" (exit code 4).
pub fn find(handle: i64) -> Result<HWND> {
    let window = hwnd(handle);
    if unsafe { IsWindow(Some(window)) }.as_bool() {
        Ok(window)
    } else {
        Err(Failure::new(exit::NOT_FOUND, format!("Window {handle} not found (it may have been closed)")))
    }
}

/// The monitor showing most of the window (for picking the GPU).
pub fn monitor(window: HWND) -> HMONITOR {
    unsafe { MonitorFromWindow(window, MONITOR_DEFAULTTONEAREST) }
}

/// Minimised: Windows.Graphics.Capture delivers no frames until it is restored.
pub fn is_minimized(window: HWND) -> bool {
    unsafe { IsIconic(window) }.as_bool()
}

/// Cloaked windows (on another virtual desktop, or suspended UWP apps) are not on screen.
fn is_cloaked(window: HWND) -> bool {
    let mut cloaked = 0u32;
    let ok = unsafe {
        DwmGetWindowAttribute(window, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, size_of::<u32>() as u32)
    };
    ok.is_ok() && cloaked != 0
}

/// The visible bounds (`DWMWA_EXTENDED_FRAME_BOUNDS`: without the invisible resize border that
/// GetWindowRect includes on Windows 10/11), in physical pixels since the process is
/// per-monitor DPI aware. GetWindowRect only when DWM cannot answer.
fn bounds(window: HWND) -> Option<WindowRect> {
    let mut r = RECT::default();
    let dwm = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS,
            &mut r as *mut RECT as *mut c_void,
            size_of::<RECT>() as u32,
        )
    };
    if dwm.is_err() && unsafe { GetWindowRect(window, &mut r) }.is_err() {
        return None;
    }
    Some(WindowRect::from_edges(r.left, r.top, r.right, r.bottom))
}

/// One look at the window: a handful of cheap user32/DWM queries, fine at 60 Hz.
pub fn observe(window: HWND) -> Observation {
    if !unsafe { IsWindow(Some(window)) }.as_bool() {
        return Observation::Gone;
    }
    let rect = bounds(window);
    let hidden = is_minimized(window) || !unsafe { IsWindowVisible(window) }.as_bool() || is_cloaked(window);
    match rect {
        Some(r) if !hidden && r.width > 0 && r.height > 0 => Observation::Shown(r),
        _ => Observation::Hidden(rect),
    }
}

/// `watch-window`: reports the window's rectangle until `stop`, the end of stdin, or the window
/// closing. Captures nothing, so it needs neither Windows.Graphics.Capture nor an encoder.
pub fn run_watch(handle: i64) -> i32 {
    let window = match find(handle) {
        Ok(w) => w,
        Err(failure) => {
            output::emit(&protocol::event_error(&failure.message));
            output::log(&failure.message);
            return failure.code;
        }
    };
    let timebase = clock::timebase();
    let inputs = input::spawn_stdin_reader();
    if !output::emit(&protocol::event_ready()) {
        return exit::OK;
    }
    let mut tracker = WindowTracker::new();
    loop {
        match tracker.update(observe(window)) {
            Change::Changed(state) => {
                let at = timebase.epoch_ms_at(clock::now_ticks());
                if !output::emit(&protocol::event_window(at, &state)) {
                    // The app is gone; nobody is listening.
                    return exit::OK;
                }
            }
            Change::Closed => {
                output::emit(&protocol::event_watch_stopped("closed"));
                return exit::OK;
            }
            Change::Unchanged => {}
        }
        match inputs.recv_timeout(POLL_INTERVAL) {
            Ok(Input::Command(Command::Stop(_))) | Ok(Input::Eof) | Err(RecvTimeoutError::Disconnected) => {
                output::emit(&protocol::event_watch_stopped("stop"));
                return exit::OK;
            }
            // pause/resume mean nothing here: the app maps every rectangle with its own clock.
            Ok(Input::Command(_)) | Err(RecvTimeoutError::Timeout) => {}
            Ok(Input::Invalid(e)) => {
                output::emit(&protocol::event_warning(&e));
            }
        }
    }
}
