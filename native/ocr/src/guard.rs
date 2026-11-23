//! What the helper sets up before anything else (docs/design/auto-blur.md §10.4, §10.5):
//! - a panic hook that prints a fixed code and the panic's source location only, never its
//!   payload (Rust's own hook prints the message, which can quote the text being read);
//! - on Windows, `SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX)` so no crash dialog
//!   appears, `WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP)` so a report Windows makes leaves out
//!   the heap (frames, crops and lines live there), and `SetUnhandledExceptionFilter` with a filter
//!   that ends the process with `TerminateProcess` and no report. All three are kernel32's; none
//!   writes the registry or loads wer.dll;
//! - below-normal priority.

use std::sync::atomic::{AtomicBool, Ordering};

static EXITING: AtomicBool = AtomicBool::new(false);

/// The panic hook: `ssw-ocr: panic at read.rs:212`, nothing else.
pub fn panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let place = info.location().map(|l| {
            let file = l.file().rsplit(['/', '\\']).next().unwrap_or("?");
            format!("{file}:{}", l.line())
        });
        eprintln!("ssw-ocr: panic at {}", place.as_deref().unwrap_or("?"));
    }));
}

/// Ends the helper now: every ffmpeg it started is killed first (on Windows the job object would
/// do it as well).
pub fn exit_now(code: i32) -> ! {
    if !EXITING.swap(true, Ordering::SeqCst) {
        crate::ffmpeg::kill_all();
    }
    std::process::exit(code)
}

#[cfg(windows)]
mod os {
    use windows_sys::Win32::System::Diagnostics::Debug::{SetErrorMode, EXCEPTION_POINTERS, SetUnhandledExceptionFilter, SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX};
    use windows_sys::Win32::System::ErrorReporting::{WerSetFlags, WER_FAULT_REPORTING_FLAG_NOHEAP};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, SetPriorityClass, TerminateProcess, BELOW_NORMAL_PRIORITY_CLASS};

    /// Ends the process without a report (Windows Error Reporting never sees the exception).
    unsafe extern "system" fn end_quietly(_info: *const EXCEPTION_POINTERS) -> i32 {
        unsafe { TerminateProcess(GetCurrentProcess(), 0xC0DE_0CC0) };
        // Not reached; EXCEPTION_EXECUTE_HANDLER otherwise.
        1
    }

    pub fn crash_reports() {
        unsafe {
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
            WerSetFlags(WER_FAULT_REPORTING_FLAG_NOHEAP);
            SetUnhandledExceptionFilter(Some(end_quietly));
        }
    }

    pub fn lower_priority() {
        unsafe { SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS) };
    }
}

#[cfg(unix)]
mod os {
    use std::ffi::c_int;
    extern "C" {
        fn setpriority(which: c_int, who: u32, prio: c_int) -> c_int;
    }

    pub fn crash_reports() {}

    pub fn lower_priority() {
        // Before any other thread exists: threads inherit the nice value.
        unsafe { setpriority(0 /* PRIO_PROCESS */, 0, 10) };
    }
}

pub fn crash_reports() {
    os::crash_reports()
}

pub fn lower_priority() {
    os::lower_priority()
}
