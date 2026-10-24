//! Exit codes and stdout of the built binary. On non-Windows hosts every command
//! reports "unsupported", which still exercises argument handling and the JSON output.

use std::process::Command;

fn run(args: &[&str]) -> (i32, String, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_ssw-capture")).args(args).output().expect("binary runs");
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stdout).into(),
        String::from_utf8_lossy(&out.stderr).into(),
    )
}

#[test]
fn invalid_arguments_exit_2_with_a_json_error_for_record() {
    let (code, stdout, stderr) = run(&["record", "--monitor", "0", "--out", "x.mp4", "--fps", "24"]);
    assert_eq!(code, 2);
    assert_eq!(stdout.trim(), r#"{"event":"error","message":"--fps must be 30 or 60, got '24'"}"#);
    assert!(stderr.contains("USAGE"));

    let (code, stdout, _) = run(&["bogus"]);
    assert_eq!(code, 2);
    assert!(stdout.is_empty(), "only record/selftest/watch-window print JSON errors");
}

#[test]
fn invalid_window_arguments_exit_2_with_a_json_error() {
    // The app passes the number from Electron's "window:<HWND>:<n>"; never the whole id.
    let (code, stdout, _) = run(&["watch-window", "--window", "window:123:0"]);
    assert_eq!(code, 2);
    assert!(stdout.starts_with(r#"{"event":"error","message":"--window must be a window handle"#), "{stdout}");
    let (code, stdout, _) = run(&["record", "--window", "0", "--out", "x.mp4", "--fps", "30"]);
    assert_eq!(code, 2);
    assert_eq!(stdout.trim(), r#"{"event":"error","message":"--window must not be 0"}"#);
    let (code, stdout, _) = run(&["record", "--window", "5", "--monitor", "0", "--out", "x.mp4", "--fps", "30"]);
    assert_eq!(code, 2);
    assert!(stdout.contains("cannot be combined"), "{stdout}");
}

#[test]
fn version_and_help_succeed() {
    let (code, stdout, _) = run(&["--version"]);
    assert_eq!(code, 0);
    assert!(stdout.starts_with("ssw-capture "));
    let (code, stdout, _) = run(&["--help"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("record --monitor"));
    assert!(stdout.contains("record --window"));
    assert!(stdout.contains("watch-window --window"));
}

#[cfg(not(windows))]
#[test]
fn reports_unsupported_off_windows() {
    let (code, stdout, _) = run(&["probe"]);
    assert_eq!(code, 3);
    assert!(stdout.starts_with(r#"{"supported":false,"cursorToggle":false,"borderToggle":false"#), "{stdout}");
    assert!(stdout.contains(r#""windowCapture":false"#), "{stdout}");
    let (code, stdout, _) = run(&["record", "--monitor", "0", "--out", "x.mp4", "--fps", "60"]);
    assert_eq!(code, 3);
    assert!(stdout.starts_with(r#"{"event":"error""#), "{stdout}");
    for args in [
        &["record", "--window", "131330", "--out", "x.mp4", "--fps", "30"][..],
        &["watch-window", "--window", "131330"],
    ] {
        let (code, stdout, _) = run(args);
        assert_eq!(code, 3, "{args:?}");
        assert!(stdout.starts_with(r#"{"event":"error""#), "{stdout}");
    }
}

#[test]
fn desktop_icons_arguments() {
    let (code, stdout, _) = run(&["desktop-icons", "toggle"]);
    assert_eq!(code, 2);
    assert_eq!(stdout.trim(), r#"{"event":"error","message":"desktop-icons takes hide, show or status, got 'toggle'"}"#);
    let (code, stdout, _) = run(&["desktop-icons"]);
    assert_eq!(code, 2);
    assert!(stdout.contains("desktop-icons takes one argument"), "{stdout}");
    let (_, stdout, _) = run(&["--help"]);
    assert!(stdout.contains("desktop-icons <hide|show|status>"), "{stdout}");
}

#[cfg(not(windows))]
#[test]
fn desktop_icons_unsupported_off_windows() {
    for action in ["hide", "show", "status"] {
        let (code, stdout, _) = run(&["desktop-icons", action]);
        assert_eq!(code, 3, "{action}");
        assert!(stdout.starts_with(r#"{"event":"error""#), "{stdout}");
    }
}
