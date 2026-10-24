//! `desktop-icons`: hides or shows the desktop's icon view (see `crate::desktop`).

use std::time::{Duration, Instant};

use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{FindWindowExW, IsWindowVisible, ShowWindowAsync, SW_HIDE, SW_SHOWNA};

use crate::desktop::{find_icon_view, plan, result_json, wait_for_eof, DesktopWindows, IconsAction};
use crate::exit;
use crate::output;
use crate::protocol;

/// How long to wait for Explorer to apply the change before reporting the visibility.
const SETTLE: Duration = Duration::from_millis(1000);

struct User32;

impl DesktopWindows for User32 {
    type Handle = HWND;

    fn top_level(&self, class: &str) -> Option<HWND> {
        unsafe { FindWindowExW(None, None, &HSTRING::from(class), PCWSTR::null()) }.ok()
    }

    fn top_levels(&self, class: &str) -> Vec<HWND> {
        let class = HSTRING::from(class);
        let mut out = Vec::new();
        let mut after: Option<HWND> = None;
        // A bound against a changing window list: there are only ever a few WorkerW windows.
        while out.len() < 64 {
            match unsafe { FindWindowExW(None, after, &class, PCWSTR::null()) } {
                Ok(w) => {
                    out.push(w);
                    after = Some(w);
                }
                Err(_) => break,
            }
        }
        out
    }

    fn child(&self, parent: HWND, class: &str) -> Option<HWND> {
        unsafe { FindWindowExW(Some(parent), None, &HSTRING::from(class), PCWSTR::null()) }.ok()
    }
}

fn visible(view: HWND) -> bool {
    unsafe { IsWindowVisible(view) }.as_bool()
}

pub fn run(action: IconsAction) -> i32 {
    let Some(view) = find_icon_view(&User32) else {
        let message = "The desktop icons were not found (Explorer is not the shell, or not running)";
        output::emit(&protocol::event_error(message));
        output::log(message);
        return exit::NOT_FOUND;
    };
    let (target, changed) = plan(action, visible(view));
    if let Some(show) = target {
        set_visible(view, show);
    }
    // `changed`: this call asked for a change (the app restores only icons it hid itself).
    output::emit(&result_json(visible(view), changed));
    if action == IconsAction::Hold {
        // The app closes stdin to release the icons; so does Windows when the app dies.
        wait_for_eof(std::io::stdin().lock());
        if changed {
            // Found again: Explorer may have restarted meanwhile (its icons are visible then anyway).
            if let Some(view) = find_icon_view(&User32) {
                set_visible(view, true);
                output::emit(&result_json(visible(view), true));
            }
        }
    }
    exit::OK
}

fn set_visible(view: HWND, show: bool) {
    // Asynchronous: a busy or hung Explorer never blocks the helper (or the app's recording).
    // SW_SHOWNA shows without activating, so the desktop never takes focus.
    let _ = unsafe { ShowWindowAsync(view, if show { SW_SHOWNA } else { SW_HIDE }) };
    let deadline = Instant::now() + SETTLE;
    while visible(view) != show && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(15));
    }
}
