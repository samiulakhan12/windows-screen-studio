//! Windows implementation: probe, list, record and watch-window.

mod capture;
mod clock;
mod cursor;
mod d3d;
mod encoder;
mod monitors;
mod processor;
mod record;
mod selftest;
mod session_end;
mod support;
mod window;

use std::fmt;
use std::path::{Path, PathBuf};

use windows::Win32::Media::MediaFoundation::{MFShutdown, MFStartup, MFSTARTUP_FULL, MF_VERSION};
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};
use windows::Win32::UI::HiDpi::{SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use windows::Win32::UI::WindowsAndMessaging::SetProcessDPIAware;

use crate::cli::Cli;
use crate::exit;
use crate::output;
use crate::protocol::{self, json_array};

/// An error with the exit code it should end the process with.
#[derive(Debug)]
pub struct Failure {
    pub code: i32,
    pub message: String,
}

impl Failure {
    pub fn new(code: i32, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }

    pub fn runtime(message: impl Into<String>) -> Self {
        Self::new(exit::RUNTIME, message)
    }
}

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

pub type Result<T> = std::result::Result<T, Failure>;

/// Adds what was being attempted to a Windows error.
pub trait Context<T> {
    fn context(self, what: &str) -> Result<T>;
}

impl<T> Context<T> for windows::core::Result<T> {
    fn context(self, what: &str) -> Result<T> {
        self.map_err(|e| Failure::runtime(describe(what, &e)))
    }
}

pub fn describe(what: &str, e: &windows::core::Error) -> String {
    let message = e.message();
    let message = message.trim();
    if message.is_empty() {
        format!("{what} failed (HRESULT 0x{:08X})", e.code().0 as u32)
    } else {
        format!("{what} failed: {message} (HRESULT 0x{:08X})", e.code().0 as u32)
    }
}

/// Monitor rectangles and capture sizes must be in physical pixels.
fn set_dpi_awareness() {
    unsafe {
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_err() {
            let _ = SetProcessDPIAware();
        }
    }
}

fn init_winrt() -> Result<()> {
    // S_FALSE (already initialised) is success; RPC_E_CHANGED_MODE cannot happen in a fresh process.
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.context("Initialising Windows Runtime")
}

pub fn run(command: Cli) -> i32 {
    set_dpi_awareness();
    match command {
        Cli::Probe => run_probe(),
        Cli::List => run_list(),
        Cli::Record(args) => record::run(&args),
        Cli::WatchWindow(handle) => window::run_watch(handle),
        Cli::Selftest(args) => selftest::run(&args),
        Cli::Help | Cli::Version => exit::OK,
    }
}

fn run_probe() -> i32 {
    let report = match init_winrt() {
        Ok(()) => support::probe(),
        Err(e) => support::Report::failed(&e.message),
    };
    output::emit(&report.to_json());
    if report.supported {
        exit::OK
    } else {
        if let Some(reason) = &report.reason {
            output::log(reason);
        }
        exit::UNSUPPORTED
    }
}

fn run_list() -> i32 {
    match monitors::enumerate() {
        Ok(list) => {
            let items: Vec<String> = list.iter().map(monitors::MonitorInfo::to_json).collect();
            output::emit(&json_array(&items));
            exit::OK
        }
        Err(e) => {
            output::emit(&protocol::event_error(&e.message));
            output::log(&e.message);
            e.code
        }
    }
}

/// Media Foundation started for the lifetime of the value.
pub struct MediaFoundation;

impl MediaFoundation {
    pub fn start() -> Result<Self> {
        unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) }.context("Starting Media Foundation")?;
        Ok(Self)
    }
}

impl Drop for MediaFoundation {
    fn drop(&mut self) {
        let _ = unsafe { MFShutdown() };
    }
}

pub fn output_path(out: &str) -> Result<PathBuf> {
    let path =
        std::path::absolute(out).map_err(|e| Failure::new(exit::USAGE, format!("Invalid output path '{out}': {e}")))?;
    match path.parent() {
        Some(dir) if dir.is_dir() => Ok(path),
        _ => Err(Failure::new(exit::USAGE, format!("The output folder for '{}' does not exist", path.display()))),
    }
}

/// Deletes the output file unless it was finished into something worth keeping.
#[derive(Default)]
pub struct PartialFile {
    path: Option<PathBuf>,
}

impl PartialFile {
    pub fn arm(&mut self, path: &Path) {
        self.path = Some(path.to_path_buf());
    }

    pub fn keep(&mut self) {
        self.path = None;
    }
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}
