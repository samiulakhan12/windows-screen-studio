//! The parent watch (`--parent-pid`) against the built helper: a run it ends early always says
//! why on stdout, because the app counts an exit code 2 without a `cancelled` line as a crash.

#![cfg(any(target_os = "linux", windows))]

use std::process::{Command, Stdio};

const HELPER: &str = env!("CARGO_BIN_EXE_ssw-speech");

/// `cpu --parent-pid <parent>` from this process: the exit code and stdout.
fn cpu_with_parent(parent: u32) -> (Option<i32>, String) {
    let out = Command::new(HELPER)
        .args(["cpu", "--parent-pid", &parent.to_string()])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .unwrap();
    (out.status.code(), String::from_utf8(out.stdout).unwrap())
}

#[test]
fn its_parent_is_watched_and_the_run_goes_on() {
    let (code, out) = cpu_with_parent(std::process::id());
    assert_eq!(code, Some(0), "{out}");
    assert!(out.starts_with("{\"type\":\"cpu\","), "{out}");
}

#[test]
fn a_parent_already_gone_cancels_the_run() {
    let mut child = Command::new(HELPER).arg("cpu").stdout(Stdio::null()).spawn().unwrap();
    let gone = child.id();
    child.wait().unwrap();
    drop(child);
    let (code, out) = cpu_with_parent(gone);
    assert_eq!((code, out.as_str()), (Some(2), "{\"type\":\"cancelled\",\"done_until\":0.000}\n"));
}

#[cfg(target_os = "linux")]
#[test]
fn a_living_process_that_is_not_the_parent_is_an_args_error() {
    // Process 1 always exists and is never this test's child.
    let (code, out) = cpu_with_parent(1);
    assert_eq!(code, Some(1), "{out}");
    assert!(out.starts_with("{\"type\":\"error\",\"code\":\"args\",\"message\":\"--parent-pid 1 "), "{out}");
    assert_eq!(out.lines().count(), 1, "{out}");
}
