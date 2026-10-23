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
    assert!(stdout.is_empty(), "only record/selftest print JSON errors");
}

#[test]
fn version_and_help_succeed() {
    let (code, stdout, _) = run(&["--version"]);
    assert_eq!(code, 0);
    assert!(stdout.starts_with("ssw-capture "));
    let (code, stdout, _) = run(&["--help"]);
    assert_eq!(code, 0);
    assert!(stdout.contains("record --monitor"));
}

#[cfg(not(windows))]
#[test]
fn reports_unsupported_off_windows() {
    let (code, stdout, _) = run(&["probe"]);
    assert_eq!(code, 3);
    assert!(stdout.starts_with(r#"{"supported":false,"cursorToggle":false,"borderToggle":false"#), "{stdout}");
    let (code, stdout, _) = run(&["record", "--monitor", "0", "--out", "x.mp4", "--fps", "60"]);
    assert_eq!(code, 3);
    assert!(stdout.starts_with(r#"{"event":"error""#), "{stdout}");
}
