//! The recorded or watched window: whether it exists, its screen rectangle, whether it is on
//! screen and whether the cursor is over it. Which observations become `window` events is
//! decided by `crate::window`.

use std::ffi::c_void;
use std::mem::size_of;
use std::sync::mpsc::TryRecvError;
use std::time::Instant;

use windows::Win32::Foundation::{HWND, POINT, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use windows::Win32::Graphics::Gdi::{MonitorFromWindow, HMONITOR, MONITOR_DEFAULTTONEAREST};
use windows::Win32::UI::WindowsAndMessaging::{
    GetAncestor, GetCursorPos, GetWindowRect, IsIconic, IsWindow, IsWindowVisible, WindowFromPoint, GA_ROOTOWNER,
};

use super::clock;
use super::timer::PreciseSleep;
use super::{Failure, Result};
use crate::exit;
use crate::input::{self, Input};
use crate::output;
use crate::protocol::{self, Command};
use crate::ticker::{Ticker, POLL_INTERVAL};
use crate::window::{Change, Observation, WindowRect, WindowTracker};

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

/// The window at the root of `window`'s parent and owner chain (`GA_ROOTOWNER`): the app's main
/// window for its child windows, dialogs and other owned popups. `window` itself if it has none.
fn root_owner(window: HWND) -> HWND {
    let root = unsafe { GetAncestor(window, GA_ROOTOWNER) };
    if root.0.is_null() {
        window
    } else {
        root
    }
}

/// Whether the cursor is over the window itself: the window under it (`WindowFromPoint`, which
/// follows the Z order) has the same root owner. False while another app's window covers that
/// spot: a window capture does not show that window, so a click there is not on the recorded
/// content. Three cheap user32 calls; `WindowFromPoint` sends messages only to windows of the
/// calling thread, which has none, so it never waits on another app.
pub fn cursor_over(window: HWND) -> bool {
    let mut point = POINT::default();
    if unsafe { GetCursorPos(&mut point) }.is_err() {
        // No cursor position (e.g. the secure desktop is showing): not over the window.
        return false;
    }
    let under = unsafe { WindowFromPoint(point) };
    !under.0.is_null() && root_owner(under) == root_owner(window)
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

/// `watch-window`: reports the window's rectangle (and `cursorOver`) until `stop`, the end of
/// stdin, or the window closing. Captures nothing, so it needs neither Windows.Graphics.Capture
/// nor an encoder. Polls every `POLL_INTERVAL` on a precise timer (a channel wait would end on
/// the 15.6 ms system tick, halving the rate) and handles commands between polls.
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
    let sleeper = PreciseSleep::new();
    let mut ticker = Ticker::new(POLL_INTERVAL, Instant::now());
    loop {
        match tracker.update(observe(window), cursor_over(window)) {
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
        loop {
            match inputs.try_recv() {
                Ok(Input::Command(Command::Stop(_))) | Ok(Input::Eof) | Err(TryRecvError::Disconnected) => {
                    output::emit(&protocol::event_watch_stopped("stop"));
                    return exit::OK;
                }
                // pause/resume mean nothing here: the app maps every rectangle with its own clock.
                Ok(Input::Command(_)) => {}
                Ok(Input::Invalid(e)) => {
                    output::emit(&protocol::event_warning(&e));
                }
                Err(TryRecvError::Empty) => break,
            }
        }
        sleeper.sleep(ticker.wait(Instant::now()));
    }
}
