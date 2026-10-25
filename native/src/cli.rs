//! Command-line parsing (no dependencies).

use crate::desktop::IconsAction;
use crate::sizing::BITRATE_RANGE;

pub const USAGE: &str = "\
ssw-capture: Windows.Graphics.Capture recorder for Flown

USAGE:
  ssw-capture probe
      Prints {\"supported\",\"windowCapture\",\"cursorToggle\",\"borderToggle\",...} as JSON.
      Exit code 0 when cursor-free capture and an H.264 encoder are available, 3 otherwise.
  ssw-capture list
      Prints the monitors as a JSON array (index, device, name, x, y, width, height, primary).
  ssw-capture record --monitor <device name | index> --out <file.mp4> --fps <30|60> [--bitrate <bps>]
  ssw-capture record --window <HWND> --out <file.mp4> --fps <30|60> [--bitrate <bps>]
      Records one monitor, or one window (decimal handle), without the mouse cursor.
      Newline-delimited JSON events on stdout (ready, started, window, cursor, paused, resumed,
      stopped, error); commands on stdin: pause [epochMs], resume [epochMs], stop [epochMs].
      Closing stdin also stops.
  ssw-capture watch-window --window <HWND>
      Captures nothing: reports the window's screen rectangle (ready, window, stopped) until
      `stop` or the end of stdin, or until the window closes.
  ssw-capture desktop-icons <hide|show|hold|status>
      Hides or shows the desktop icons (the icon view only, never the \"Show desktop icons\"
      setting) and prints {\"visible\",\"changed\"} as JSON. Exit code 4 when there is no desktop.
      `hold` hides them, then waits for the end of stdin (the app closed it, exited or died)
      and shows them again if it hid them.
  ssw-capture selftest --out <file.mp4> [--fps <30|60>] [--seconds <1-60>]
      Encodes a generated 1920x1080 colour sweep through the same GPU colour conversion and
      H.264 encoder as `record` (no screen capture) and prints the encoder and its speed.
  ssw-capture --version

EXIT CODES:
  0 success, 1 runtime error, 2 invalid arguments, 3 unsupported on this system,
  4 monitor or window not found
";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MonitorSelector {
    /// Zero-based position in the `list` output.
    Index(usize),
    /// GDI device name such as `\\.\DISPLAY1` (case-insensitive).
    Device(String),
}

/// What `record` captures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Monitor(MonitorSelector),
    /// A window handle (HWND), as in Electron's `window:<HWND>:<n>` source id.
    Window(i64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecordArgs {
    pub target: Target,
    pub out: String,
    pub fps: u32,
    pub bitrate: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelftestArgs {
    pub out: String,
    pub fps: u32,
    pub seconds: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cli {
    Probe,
    List,
    Record(RecordArgs),
    /// `watch-window --window <HWND>`.
    WatchWindow(i64),
    Selftest(SelftestArgs),
    /// `desktop-icons hide|show|hold|status`.
    DesktopIcons(IconsAction),
    Help,
    Version,
}

pub fn parse(args: &[String]) -> Result<Cli, String> {
    let Some(cmd) = args.first() else {
        return Err("missing command".into());
    };
    let rest = &args[1..];
    match cmd.as_str() {
        "probe" | "list" if !rest.is_empty() => Err(format!("'{cmd}' takes no arguments")),
        "probe" => Ok(Cli::Probe),
        "list" => Ok(Cli::List),
        "record" => parse_record(rest).map(Cli::Record),
        "watch-window" => parse_watch_window(rest).map(Cli::WatchWindow),
        "selftest" => parse_selftest(rest).map(Cli::Selftest),
        "desktop-icons" => match rest {
            [action] => IconsAction::parse(action).map(Cli::DesktopIcons),
            _ => Err("desktop-icons takes one argument: hide, show, hold or status".into()),
        },
        "help" | "--help" | "-h" => Ok(Cli::Help),
        "--version" | "-V" => Ok(Cli::Version),
        other => Err(format!("unknown command '{other}'")),
    }
}

fn parse_record(args: &[String]) -> Result<RecordArgs, String> {
    let mut monitor = None;
    let mut window = None;
    let mut out = None;
    let mut fps = None;
    let mut bitrate = None;
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = args.get(i + 1).ok_or_else(|| format!("{flag} needs a value"))?;
        match flag {
            "--monitor" => monitor = Some(parse_monitor(value)?),
            "--window" => window = Some(parse_window(value)?),
            "--out" => {
                if value.trim().is_empty() {
                    return Err("--out must not be empty".into());
                }
                out = Some(value.clone());
            }
            "--fps" => fps = Some(parse_fps(value)?),
            "--bitrate" => {
                let b: u32 = value
                    .parse()
                    .map_err(|_| format!("--bitrate must be a number of bits per second, got '{value}'"))?;
                if b < BITRATE_RANGE.0 || b > BITRATE_RANGE.1 {
                    return Err(format!("--bitrate must be between {} and {}", BITRATE_RANGE.0, BITRATE_RANGE.1));
                }
                bitrate = Some(b);
            }
            other => return Err(format!("unknown option '{other}'")),
        }
        i += 2;
    }
    let target = match (monitor, window) {
        (Some(m), None) => Target::Monitor(m),
        (None, Some(w)) => Target::Window(w),
        (Some(_), Some(_)) => return Err("--monitor and --window cannot be combined".into()),
        (None, None) => return Err("--monitor or --window is required".into()),
    };
    Ok(RecordArgs { target, out: out.ok_or("--out is required")?, fps: fps.ok_or("--fps is required")?, bitrate })
}

fn parse_watch_window(args: &[String]) -> Result<i64, String> {
    match args {
        [flag, value] if flag == "--window" => parse_window(value),
        [flag] if flag == "--window" => Err("--window needs a value".into()),
        [] => Err("--window is required".into()),
        _ => Err(format!("invalid arguments for watch-window: {}", args.join(" "))),
    }
}

/// A window handle: decimal as Electron prints it (`window:<HWND>:<n>`, a signed intptr_t),
/// or `0x`-prefixed hexadecimal for manual use. Zero is never a window.
pub fn parse_window(value: &str) -> Result<i64, String> {
    let v = value.trim();
    let parsed = match v.strip_prefix("0x").or_else(|| v.strip_prefix("0X")) {
        Some(hex) if !hex.is_empty() && hex.len() <= 16 && hex.bytes().all(|b| b.is_ascii_hexdigit()) => {
            u64::from_str_radix(hex, 16).ok().map(|n| n as i64)
        }
        Some(_) => None,
        None => {
            let digits = v.strip_prefix('-').unwrap_or(v);
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                v.parse::<i64>().ok()
            } else {
                None
            }
        }
    };
    match parsed {
        Some(0) => Err("--window must not be 0".into()),
        Some(n) => Ok(n),
        None => Err(format!("--window must be a window handle (decimal HWND), got '{value}'")),
    }
}

fn parse_fps(value: &str) -> Result<u32, String> {
    match value {
        "30" => Ok(30),
        "60" => Ok(60),
        _ => Err(format!("--fps must be 30 or 60, got '{value}'")),
    }
}

fn parse_selftest(args: &[String]) -> Result<SelftestArgs, String> {
    let mut out = None;
    let mut fps = 30;
    let mut seconds = 2;
    let mut i = 0;
    while i < args.len() {
        let flag = args[i].as_str();
        let value = args.get(i + 1).ok_or_else(|| format!("{flag} needs a value"))?;
        match flag {
            "--out" if !value.trim().is_empty() => out = Some(value.clone()),
            "--fps" => fps = parse_fps(value)?,
            "--seconds" => {
                seconds = value
                    .parse()
                    .ok()
                    .filter(|s| (1..=60).contains(s))
                    .ok_or_else(|| format!("--seconds must be between 1 and 60, got '{value}'"))?
            }
            other => return Err(format!("invalid option '{other}'")),
        }
        i += 2;
    }
    Ok(SelftestArgs { out: out.ok_or("--out is required")?, fps, seconds })
}

fn parse_monitor(value: &str) -> Result<MonitorSelector, String> {
    let v = value.trim();
    if v.is_empty() {
        return Err("--monitor must not be empty".into());
    }
    if v.bytes().all(|b| b.is_ascii_digit()) {
        return v.parse().map(MonitorSelector::Index).map_err(|_| format!("invalid monitor index '{v}'"));
    }
    Ok(MonitorSelector::Device(v.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &[&str]) -> Vec<String> {
        s.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn parses_simple_commands() {
        assert_eq!(parse(&args(&["probe"])), Ok(Cli::Probe));
        assert_eq!(parse(&args(&["list"])), Ok(Cli::List));
        assert_eq!(parse(&args(&["--help"])), Ok(Cli::Help));
        assert_eq!(parse(&args(&["--version"])), Ok(Cli::Version));
        assert!(parse(&args(&[])).is_err());
        assert!(parse(&args(&["probe", "x"])).is_err());
        assert!(parse(&args(&["capture"])).is_err());
    }

    #[test]
    fn parses_record() {
        let r = parse(&args(&["record", "--monitor", r"\\.\DISPLAY2", "--out", r"C:\a b\screen.mp4", "--fps", "60"]));
        assert_eq!(
            r,
            Ok(Cli::Record(RecordArgs {
                target: Target::Monitor(MonitorSelector::Device(r"\\.\DISPLAY2".into())),
                out: r"C:\a b\screen.mp4".into(),
                fps: 60,
                bitrate: None
            }))
        );
        let r = parse(&args(&["record", "--fps", "30", "--bitrate", "8000000", "--monitor", "1", "--out", "x.mp4"]));
        assert_eq!(
            r,
            Ok(Cli::Record(RecordArgs {
                target: Target::Monitor(MonitorSelector::Index(1)),
                out: "x.mp4".into(),
                fps: 30,
                bitrate: Some(8_000_000)
            }))
        );
    }

    #[test]
    fn parses_window_record_and_watch() {
        assert_eq!(
            parse(&args(&["record", "--window", "4194316", "--out", "w.mp4", "--fps", "30"])),
            Ok(Cli::Record(RecordArgs {
                target: Target::Window(4_194_316),
                out: "w.mp4".into(),
                fps: 30,
                bitrate: None
            }))
        );
        assert_eq!(
            parse(&args(&["record", "--out", "w.mp4", "--window", "0x20102", "--fps", "60", "--bitrate", "4000000"])),
            Ok(Cli::Record(RecordArgs {
                target: Target::Window(0x20102),
                out: "w.mp4".into(),
                fps: 60,
                bitrate: Some(4_000_000)
            }))
        );
        assert_eq!(parse(&args(&["watch-window", "--window", "131330"])), Ok(Cli::WatchWindow(131_330)));
        assert_eq!(parse(&args(&["watch-window", "--window", " 131330 "])), Ok(Cli::WatchWindow(131_330)));
        // Chromium prints the handle as a signed intptr_t.
        assert_eq!(parse(&args(&["watch-window", "--window", "-2147352318"])), Ok(Cli::WatchWindow(-2_147_352_318)));
    }

    #[test]
    fn rejects_bad_window_arguments() {
        for bad in [
            vec!["watch-window"],
            vec!["watch-window", "--window"],
            vec!["watch-window", "--window", "0"],
            vec!["watch-window", "--window", "-0"],
            vec!["watch-window", "--window", "abc"],
            vec!["watch-window", "--window", "-"],
            vec!["watch-window", "--window", "window:123:0"],
            vec!["watch-window", "--window", "12", "--out", "x"],
            vec!["watch-window", "--monitor", "0"],
            vec!["record", "--window", "12", "--monitor", "0", "--out", "x.mp4", "--fps", "30"],
            vec!["record", "--window", "", "--out", "x.mp4", "--fps", "30"],
            vec!["record", "--window", "0x", "--out", "x.mp4", "--fps", "30"],
            vec!["record", "--window", "0x12345678901234567", "--out", "x.mp4", "--fps", "30"],
            vec!["record", "--window", "1.5", "--out", "x.mp4", "--fps", "30"],
            vec!["record", "--window", "99999999999999999999", "--out", "x.mp4", "--fps", "30"],
            vec!["record", "--window", "12", "--out", "x.mp4"],
        ] {
            assert!(parse(&args(&bad)).is_err(), "{bad:?} should fail");
        }
    }

    #[test]
    fn parses_desktop_icons() {
        assert_eq!(parse(&args(&["desktop-icons", "hide"])), Ok(Cli::DesktopIcons(IconsAction::Hide)));
        assert_eq!(parse(&args(&["desktop-icons", "show"])), Ok(Cli::DesktopIcons(IconsAction::Show)));
        assert_eq!(parse(&args(&["desktop-icons", "status"])), Ok(Cli::DesktopIcons(IconsAction::Status)));
        assert_eq!(parse(&args(&["desktop-icons", "hold"])), Ok(Cli::DesktopIcons(IconsAction::Hold)));
        for bad in [vec!["desktop-icons"], vec!["desktop-icons", "toggle"], vec!["desktop-icons", "hide", "now"]] {
            assert!(parse(&args(&bad)).is_err(), "{bad:?} should fail");
        }
    }

    #[test]
    fn parses_selftest() {
        assert_eq!(
            parse(&args(&["selftest", "--out", "t.mp4"])),
            Ok(Cli::Selftest(SelftestArgs { out: "t.mp4".into(), fps: 30, seconds: 2 }))
        );
        assert_eq!(
            parse(&args(&["selftest", "--seconds", "5", "--fps", "60", "--out", "t.mp4"])),
            Ok(Cli::Selftest(SelftestArgs { out: "t.mp4".into(), fps: 60, seconds: 5 }))
        );
        assert!(parse(&args(&["selftest"])).is_err());
        assert!(parse(&args(&["selftest", "--out", "t.mp4", "--seconds", "0"])).is_err());
        assert!(parse(&args(&["selftest", "--out", "t.mp4", "--seconds", "61"])).is_err());
        assert!(parse(&args(&["selftest", "--out", " "])).is_err());
    }

    #[test]
    fn rejects_bad_record_arguments() {
        for bad in [
            vec!["record", "--out", "x.mp4", "--fps", "60"],
            vec!["record", "--monitor", "0", "--fps", "60"],
            vec!["record", "--monitor", "0", "--out", "x.mp4"],
            vec!["record", "--monitor", "0", "--out", "x.mp4", "--fps", "25"],
            vec!["record", "--monitor", "0", "--out", "x.mp4", "--fps"],
            vec!["record", "--monitor", "0", "--out", "x.mp4", "--fps", "60", "--bitrate", "fast"],
            vec!["record", "--monitor", "0", "--out", "x.mp4", "--fps", "60", "--bitrate", "10"],
            vec!["record", "--monitor", "0", "--out", "x.mp4", "--fps", "60", "--crf", "20"],
            vec!["record", "--monitor", " ", "--out", "x.mp4", "--fps", "60"],
            vec!["record", "--monitor", "0", "--out", "", "--fps", "60"],
        ] {
            assert!(parse(&args(&bad)).is_err(), "{bad:?} should fail");
        }
    }
}
