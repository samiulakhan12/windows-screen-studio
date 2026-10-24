//! Finishing the MP4 when the recording ends from outside the protocol.
//!
//! - Ctrl+C / Ctrl+Break in a console: the handler only records the request; the process runs
//!   on and the recording loop stops normally.
//! - Closing the console window: Windows ends the process as soon as the handler returns, so
//!   the handler waits (bounded) until the recording has settled its output file.
//! - Sign-out and shutdown: a process that loaded user32 (this one does) gets no console
//!   notification for them, and the app starts the helper without a console at all. A hidden
//!   top-level window receives WM_ENDSESSION instead and holds the session end the same way.
//!
//! Waiting is bounded by `interrupt::GRACE`; Windows ends the process about then anyway. A
//! fragmented MP4 (encoder.rs) keeps everything up to its last complete fragment even then.

use windows::core::{w, BOOL};
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Console::SetConsoleCtrlHandler;
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW, MSG, WINDOW_EX_STYLE,
    WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW, WS_OVERLAPPED,
};

use crate::interrupt::{self, Interrupt, Latch, Source};

/// Set by the handlers below; polled by the recording loop.
pub static INTERRUPT: Interrupt = Interrupt::new();
/// Set once `record` has finalised, kept or removed its output file (and on every early return).
pub static SETTLED: Latch = Latch::new();

/// The stop reason when an interrupt was requested.
pub fn requested() -> Option<&'static str> {
    INTERRUPT.requested().map(Source::reason)
}

unsafe extern "system" fn on_console_ctrl(kind: u32) -> BOOL {
    let (source, wait) = interrupt::console_event(kind);
    INTERRUPT.request(source);
    if wait {
        SETTLED.wait(interrupt::GRACE);
    }
    BOOL(1)
}

unsafe extern "system" fn session_window(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        // Never veto: another app may still cancel, so only act on WM_ENDSESSION.
        WM_QUERYENDSESSION => LRESULT(1),
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                INTERRUPT.request(Source::SessionEnd);
                SETTLED.wait(interrupt::GRACE);
            }
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// Installs the console handler and the session-end window. Best effort: without them the
/// recording still stops on a stop command or stdin closing.
pub fn watch() {
    let _ = unsafe { SetConsoleCtrlHandler(Some(on_console_ctrl), true) };
    let spawned = std::thread::Builder::new().name("session-end".into()).spawn(|| unsafe {
        let Ok(module) = GetModuleHandleW(None) else { return };
        let instance = HINSTANCE(module.0);
        let class = w!("ssw-capture-session-end");
        let wc = WNDCLASSW {
            lpfnWndProc: Some(session_window),
            hInstance: instance,
            lpszClassName: class,
            ..Default::default()
        };
        if RegisterClassW(&wc) == 0 {
            return;
        }
        // Hidden (no WS_VISIBLE) and top-level: message-only windows get no WM_ENDSESSION.
        if CreateWindowExW(
            WINDOW_EX_STYLE(0),
            class,
            w!(""),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(instance),
            None,
        )
        .is_err()
        {
            return;
        }
        let mut msg = MSG::default();
        // 0: WM_QUIT, -1: error.
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            DispatchMessageW(&msg);
        }
    });
    if spawned.is_err() {
        crate::output::log("could not watch for sign-out/shutdown; the recording may be cut off then");
    }
}
