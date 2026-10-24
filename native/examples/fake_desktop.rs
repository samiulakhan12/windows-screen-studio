//! Test fixture: a stand-in for Explorer's desktop windows (`Progman` > `SHELLDLL_DefView` >
//! `SysListView32` "FolderView"), so `ssw-capture desktop-icons` can be checked end to end
//! where Explorer is not the shell (wine). `--worker-w` puts the view in a top-level `WorkerW`
//! instead, as Explorer does after a wallpaper slideshow. Prints `ready` once the windows exist
//! and runs until `seconds` (default 30) have passed or stdin closes. Never shipped.
//!
//!   cargo build --release --example fake_desktop --target x86_64-pc-windows-gnu

#[cfg(not(windows))]
fn main() {
    eprintln!("fake_desktop only runs on Windows (or wine)");
}

#[cfg(windows)]
fn main() {
    use std::io::Read;
    use windows::core::{w, PCWSTR};
    use windows::Win32::Foundation::{HINSTANCE, HWND};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostQuitMessage, RegisterClassW, SetTimer,
        TranslateMessage, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WM_TIMER, WNDCLASSW, WS_CHILD, WS_POPUP, WS_VISIBLE,
    };

    unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: windows::Win32::Foundation::WPARAM, lparam: windows::Win32::Foundation::LPARAM) -> windows::Win32::Foundation::LRESULT {
        if msg == WM_TIMER {
            unsafe { PostQuitMessage(0) };
        }
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    let args: Vec<String> = std::env::args().skip(1).collect();
    let worker_w = args.iter().any(|a| a == "--worker-w");
    let seconds: u32 = args.iter().find_map(|a| a.parse().ok()).unwrap_or(30);

    unsafe {
        let instance = HINSTANCE(GetModuleHandleW(None).expect("module").0);
        for class in [w!("Progman"), w!("WorkerW"), w!("SHELLDLL_DefView"), w!("SysListView32")] {
            let wc = WNDCLASSW { lpfnWndProc: Some(proc_), hInstance: instance, lpszClassName: class, ..Default::default() };
            assert!(RegisterClassW(&wc) != 0, "RegisterClassW failed");
        }
        let create = |class: PCWSTR, title: PCWSTR, style: WINDOW_STYLE, parent: Option<HWND>| {
            CreateWindowExW(WINDOW_EX_STYLE(0), class, title, style, 0, 0, 400, 300, parent, None, Some(instance), None)
                .expect("CreateWindowExW")
        };
        let progman = create(w!("Progman"), w!("Program Manager"), WS_POPUP | WS_VISIBLE, None);
        let host = if worker_w {
            create(w!("WorkerW"), w!(""), WS_POPUP | WS_VISIBLE, None);
            create(w!("WorkerW"), w!(""), WS_POPUP | WS_VISIBLE, None)
        } else {
            progman
        };
        let def_view = create(w!("SHELLDLL_DefView"), w!(""), WS_CHILD | WS_VISIBLE, Some(host));
        create(w!("SysListView32"), w!("FolderView"), WS_CHILD | WS_VISIBLE, Some(def_view));
        SetTimer(Some(progman), 1, seconds * 1000, None);
        // Ends early when the test closes stdin.
        std::thread::spawn(|| {
            let mut sink = [0u8; 64];
            while matches!(std::io::stdin().read(&mut sink), Ok(n) if n > 0) {}
            std::process::exit(0);
        });
        println!("ready");
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
