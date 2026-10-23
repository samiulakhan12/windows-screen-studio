//! ssw-capture: records one monitor with Windows.Graphics.Capture, cursor excluded,
//! to an H.264 MP4 through Media Foundation (hardware encoder when available).
//! Driven by the Electron main process; see src/main/nativeCapture.ts and README.md.

// The portable modules are unit-tested on any OS but only used by the Windows code.
#![cfg_attr(not(windows), allow(dead_code))]

mod cli;
mod output;
mod pacer;
mod protocol;
mod shapes;
mod sizing;
#[cfg(windows)]
mod win;

pub mod exit {
    pub const OK: i32 = 0;
    pub const RUNTIME: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const UNSUPPORTED: i32 = 3;
    pub const NO_MONITOR: i32 = 4;
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let message = format!("internal error: {info}");
        output::emit(&protocol::event_error(&message));
        output::log(&message);
    }));

    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match cli::parse(&args) {
        Ok(cli::Cli::Help) => {
            print!("{}", cli::USAGE);
            exit::OK
        }
        Ok(cli::Cli::Version) => {
            println!("ssw-capture {}", env!("CARGO_PKG_VERSION"));
            exit::OK
        }
        Ok(command) => run(command),
        Err(message) => {
            if matches!(args.first().map(String::as_str), Some("record" | "selftest")) {
                output::emit(&protocol::event_error(&message));
            }
            output::log(&message);
            eprint!("\n{}", cli::USAGE);
            exit::USAGE
        }
    };
    std::process::exit(code);
}

#[cfg(windows)]
fn run(command: cli::Cli) -> i32 {
    win::run(command)
}

#[cfg(not(windows))]
fn run(command: cli::Cli) -> i32 {
    let message = "ssw-capture only runs on Windows 10 2004 or later";
    match command {
        cli::Cli::Probe => {
            output::emit(
                &protocol::JsonObject::new()
                    .bool("supported", false)
                    .bool("cursorToggle", false)
                    .bool("borderToggle", false)
                    .str("reason", message)
                    .finish(),
            );
        }
        cli::Cli::Record(_) | cli::Cli::Selftest(_) => {
            output::emit(&protocol::event_error(message));
        }
        _ => {}
    }
    output::log(message);
    exit::UNSUPPORTED
}
